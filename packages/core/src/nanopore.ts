// Nanopore SSM engine. Per-read state machine that:
//   1. Gates on mean read Q (cheap pre-filter, before any anchor scan)
//   2. Multiplexed mode: matches each round's barcode in the read's 5' head
//      and binds the read to the best-scoring round (ambiguity-margin checked)
//   3. For every configured site, runs the DualAnchorScorer to locate the
//      site's upstream + downstream anchors, then enforces ROI invariants:
//         - ROI length == expected (no Nanopore indels in the variable region)
//         - mean ROI Q ≥ threshold (basecaller confidence at the variable position)
//         - length divisible by 3 (translates cleanly)
//         - no in-frame stop (if filterStop is on)
//   4. Increments per-site DNA counter on success; per-site WT counter when
//      the ROI matches the reference WT exactly
//   5. (Optional) When ≥2 sites configured and all sites extract cleanly from
//      the same read, emits a joined-codon "haplotype" counter for epistasis
//      analysis
//
// Round-binding is decoupled from per-read processing so the same engine
// supports multiplexed (barcode → round at process time) and per-round
// (source → round bound at orchestrator time) without code duplication.

import { bandedAlign } from "./banded-align.js";
import { hasNoStopCodon } from "./dna.js";
import { meanPhred } from "./fastq.js";

// --- Public config types --------------------------------------------------

export interface NanoporeSiteConfig {
  /** Display + storage key. */
  name: string;
  fwAnchor: Uint8Array;
  rvAnchor: Uint8Array;
  /** ROI length expected at this site, derived by the orchestrator from the
   *  reference (positions strictly between fwAnchor and rvAnchor). Used as a
   *  hard equality gate per read — Nanopore SSM variants are substitutions,
   *  never indels, so an off-by-N observed ROI is treated as a basecaller
   *  indel artifact. */
  expectedRoiLen: number;
  /** Reference (WT) ROI bytes as an ASCII string. ROIs exact-matching this
   *  feed the per-site WT counter, which the analyzer uses for the
   *  basecaller-error background AND the WT-anchored Fitness_vs_WT_* metric. */
  wtDna: string;
}

export interface NanoporeRoundConfig {
  name: string;
  /** Multiplexed mode: barcode prefix that distinguishes this round. Per-
   *  round mode: omit (the orchestrator binds source → round directly). */
  barcode?: Uint8Array;
}

export interface NanoporeSettings {
  /** Banded-align tolerance for anchor scans. (sub + indel) is the total
   *  per-anchor edit budget; indels separately cap the alignment-length band. */
  maxAnchorSubs: number;
  maxAnchorIndels: number;
  /** Per-read mean Phred gate. */
  minMeanPhredRead: number;
  /** Per-ROI mean Phred gate (basecaller confidence at the variable site). */
  minMeanPhredRoi: number;
  /** Reject reads whose ROI has an in-frame stop codon. */
  filterStop: boolean;
  /** Emit linked haplotype counter when ≥2 sites all extract from same read. */
  reportHaplotype: boolean;
  /** Downstream enrichment pseudocount in RPM units; does not affect read calling. */
  pseudocount: number;
  /** Multiplexed-mode barcode score budget (banded-align scale). */
  maxBarcodeError: number;
  /** Multiplexed-mode runner-up margin. */
  minBarcodeVictoryMargin: number;
  /** Window (bytes from 5' end) to search for barcodes. Keeps search cheap
   *  on long Nanopore reads. */
  barcodeSearchWindow: number;
}

export const DEFAULT_SETTINGS: NanoporeSettings = Object.freeze({
  maxAnchorSubs: 2,
  maxAnchorIndels: 1,
  minMeanPhredRead: 10,
  minMeanPhredRoi: 15,
  filterStop: true,
  reportHaplotype: true,
  pseudocount: 0.5,
  maxBarcodeError: 2,
  minBarcodeVictoryMargin: 1,
  barcodeSearchWindow: 100,
});

// --- Public stats / result types ------------------------------------------

export interface NanoporeSiteStats {
  /** Reads where both anchors of this site were located. */
  anchor_found: number;
  discard_roi_indel: number;
  discard_low_q_roi: number;
  discard_frameshift: number;
  discard_stop_codon: number;
  passed_qc: number;
  /** Reads whose ROI exactly matched the reference WT for this site. Subset
   *  of passed_qc; analyzer uses this as the error-floor denominator. */
  wt_count: number;
}

export interface NanoporeRoundStats {
  /** Keyed by site name. Same order as the input sites array. */
  sites: Record<string, NanoporeSiteStats>;
  /** Reads where every site extracted cleanly — feeds the haplotype counter.
   *  Only counted once per physical read (RC retry on the same record doesn't
   *  double-count: the engine's per-call counters are site-specific, and this
   *  one only fires after an "assigned" outcome). */
  haplotype_passed_qc: number;
}

export interface NanoporeGlobalBreakdown {
  /** FASTQ records whose four-line structure, sequence alphabet, or
   * Phred+33 quality text is invalid. */
  malformed_fastq: number;
  low_quality_read: number;
  barcode_mismatch: number;
  /** Reads bound to a round (or per-round in per-round mode) but where no
   *  site succeeded. Tracked globally because per-site anchor misses are
   *  already in NanoporeSiteStats.anchor_found's complement. */
  no_site_extracted: number;
}

export type NanoporeOutcome =
  | "assigned"
  | "low_quality_read"
  | "barcode_mismatch"
  | "no_site_extracted";

// --- Scorer abstraction ---------------------------------------------------

export interface DualAnchorSiteOutput {
  found: boolean;
  fwStart: number;
  fwEnd: number;
  rvStart: number;
  rvEnd: number;
}

export interface SiteScorerLike {
  /** Returns per-site results in registration order. Length === sites.length. */
  score(seq: Uint8Array): DualAnchorSiteOutput[];
}

/** Pure-TS scorer that calls bandedAlign twice per site. Used in tests and
 *  as the fallback when useWasm=false. WASM equivalent (createDualAnchorScorer)
 *  lives in wasm.ts and is byte-identical thanks to the parity suite. */
export function createTsScorer(
  sites: ReadonlyArray<NanoporeSiteConfig>,
  settings: NanoporeSettings,
): SiteScorerLike {
  return {
    score(seq: Uint8Array): DualAnchorSiteOutput[] {
      const out: DualAnchorSiteOutput[] = new Array(sites.length);
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i]!;
        const fw = bandedAlign(seq, site.fwAnchor, settings.maxAnchorSubs, settings.maxAnchorIndels);
        if (!fw.found) {
          out[i] = { found: false, fwStart: -1, fwEnd: -1, rvStart: -1, rvEnd: -1 };
          continue;
        }
        if (fw.end >= seq.length) {
          out[i] = { found: false, fwStart: fw.start, fwEnd: fw.end, rvStart: -1, rvEnd: -1 };
          continue;
        }
        const tail = seq.subarray(fw.end);
        const rv = bandedAlign(tail, site.rvAnchor, settings.maxAnchorSubs, settings.maxAnchorIndels);
        if (!rv.found) {
          out[i] = { found: false, fwStart: fw.start, fwEnd: fw.end, rvStart: -1, rvEnd: -1 };
          continue;
        }
        out[i] = {
          found: true,
          fwStart: fw.start,
          fwEnd: fw.end,
          rvStart: rv.start + fw.end,
          rvEnd: rv.end + fw.end,
        };
      }
      return out;
    },
  };
}

// --- Engine ---------------------------------------------------------------

const DEC = new TextDecoder("latin1");

export class NanoporeEngine {
  public readonly stats: Map<string, NanoporeRoundStats>;
  /** round → site → roi_dna → count. Per-site DNA counts. */
  public readonly dnaCounters: Map<string, Map<string, Map<string, number>>>;
  /** round → joined_dna → count. Only populated when reportHaplotype && sites.length >= 2. */
  public readonly haplotypeCounters: Map<string, Map<string, number>>;
  public readonly globalBreakdown: NanoporeGlobalBreakdown;

  private readonly sites: ReadonlyArray<NanoporeSiteConfig>;
  private readonly rounds: ReadonlyArray<NanoporeRoundConfig>;
  private readonly settings: NanoporeSettings;
  private readonly scorer: SiteScorerLike;
  private readonly emitHaplotypes: boolean;

  constructor(
    sites: ReadonlyArray<NanoporeSiteConfig>,
    rounds: ReadonlyArray<NanoporeRoundConfig>,
    settings: NanoporeSettings,
    scorer?: SiteScorerLike,
  ) {
    this.sites = sites;
    this.rounds = rounds;
    this.settings = settings;
    this.scorer = scorer ?? createTsScorer(sites, settings);
    this.emitHaplotypes = settings.reportHaplotype && sites.length >= 2;

    this.stats = new Map();
    this.dnaCounters = new Map();
    this.haplotypeCounters = new Map();
    this.globalBreakdown = {
      malformed_fastq: 0,
      low_quality_read: 0,
      barcode_mismatch: 0,
      no_site_extracted: 0,
    };

    for (const r of rounds) {
      const siteStats: Record<string, NanoporeSiteStats> = {};
      const dnaPerSite = new Map<string, Map<string, number>>();
      for (const s of sites) {
        siteStats[s.name] = freshSiteStats();
        dnaPerSite.set(s.name, new Map());
      }
      this.stats.set(r.name, {
        sites: siteStats,
        haplotype_passed_qc: 0,
      });
      this.dnaCounters.set(r.name, dnaPerSite);
      this.haplotypeCounters.set(r.name, new Map());
    }
  }

  /** Process a read in multiplexed mode — match barcode → bind to round. */
  processRead(seq: Uint8Array, qual: Uint8Array): NanoporeOutcome {
    if (!this.gateReadQ(qual)) {
      this.globalBreakdown.low_quality_read++;
      return "low_quality_read";
    }
    const roundIdx = this.matchBarcode(seq);
    if (roundIdx < 0) {
      this.globalBreakdown.barcode_mismatch++;
      return "barcode_mismatch";
    }
    return this.processForRoundInternal(seq, qual, roundIdx);
  }

  /** Charge a damaged FASTQ record without sending invalid bytes through
   * anchor alignment or Q-score calculations. */
  recordMalformedFastq(): void {
    this.globalBreakdown.malformed_fastq++;
  }

  /** Process a read in per-round mode — round is bound by the orchestrator. */
  processReadForRound(seq: Uint8Array, qual: Uint8Array, roundIdx: number): NanoporeOutcome {
    if (!this.gateReadQ(qual)) {
      this.globalBreakdown.low_quality_read++;
      return "low_quality_read";
    }
    return this.processForRoundInternal(seq, qual, roundIdx);
  }

  // -----------------------------------------------------------------------

  private gateReadQ(qual: Uint8Array): boolean {
    if (this.settings.minMeanPhredRead <= 0) return true;
    return meanPhred(qual) >= this.settings.minMeanPhredRead;
  }

  /** Returns the best-matching round index, or -1 if no match within budget /
   *  ambiguous within margin. Search window capped to barcodeSearchWindow bp
   *  from the 5' end so we don't catch in-amplicon false hits. */
  private matchBarcode(seq: Uint8Array): number {
    const head = seq.subarray(0, Math.min(this.settings.barcodeSearchWindow, seq.length));
    let bestIdx = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    let runnerScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.rounds.length; i++) {
      const bc = this.rounds[i]!.barcode;
      if (!bc || bc.length === 0) continue;
      const m = bandedAlign(head, bc, this.settings.maxAnchorSubs, this.settings.maxAnchorIndels);
      if (!m.found) continue;
      if (m.score < bestScore) {
        runnerScore = bestScore;
        bestScore = m.score;
        bestIdx = i;
      } else if (m.score < runnerScore) {
        runnerScore = m.score;
      }
    }
    if (bestIdx < 0 || bestScore > this.settings.maxBarcodeError) return -1;
    if (runnerScore - bestScore < this.settings.minBarcodeVictoryMargin) return -1;
    return bestIdx;
  }

  private processForRoundInternal(
    seq: Uint8Array,
    qual: Uint8Array,
    roundIdx: number,
  ): NanoporeOutcome {
    const round = this.rounds[roundIdx];
    if (!round) {
      // Bad index — treat as no_site_extracted so we don't silently lose the read.
      this.globalBreakdown.no_site_extracted++;
      return "no_site_extracted";
    }
    const roundStats = this.stats.get(round.name)!;
    const siteResults = this.scorer.score(seq);
    const passedSites: { siteName: string; roiDna: string }[] = [];
    let allSitesPassed = true;

    for (let i = 0; i < this.sites.length; i++) {
      const site = this.sites[i]!;
      const r = siteResults[i]!;
      const ss = roundStats.sites[site.name]!;

      if (!r.found) {
        allSitesPassed = false;
        continue;
      }
      ss.anchor_found++;

      const roiStart = r.fwEnd;
      const roiEnd = r.rvStart;
      const observedLen = roiEnd - roiStart;
      if (observedLen !== site.expectedRoiLen) {
        ss.discard_roi_indel++;
        allSitesPassed = false;
        continue;
      }

      // ROI mean Q (skip if no Q-budget configured)
      if (this.settings.minMeanPhredRoi > 0) {
        const qSlice = qual.subarray(roiStart, roiEnd);
        if (qSlice.length !== observedLen) {
          // qual shorter than seq for this stretch — basecaller edge artifact
          ss.discard_low_q_roi++;
          allSitesPassed = false;
          continue;
        }
        let qSum = 0;
        for (let k = 0; k < qSlice.length; k++) qSum += qSlice[k]! - 33;
        const roiMeanQ = qSum / qSlice.length;
        if (roiMeanQ < this.settings.minMeanPhredRoi) {
          ss.discard_low_q_roi++;
          allSitesPassed = false;
          continue;
        }
      }

      // Frameshift / stop checks — both operate on the ROI byte slice.
      if (observedLen % 3 !== 0) {
        ss.discard_frameshift++;
        allSitesPassed = false;
        continue;
      }
      const roiBytes = seq.subarray(roiStart, roiEnd);
      if (this.settings.filterStop && !hasNoStopCodon(roiBytes)) {
        ss.discard_stop_codon++;
        allSitesPassed = false;
        continue;
      }

      // Commit the ROI.
      const roiDna = DEC.decode(roiBytes.slice()); // copy to detach from underlying buffer
      ss.passed_qc++;
      if (roiDna === site.wtDna) ss.wt_count++;
      const siteCounter = this.dnaCounters.get(round.name)!.get(site.name)!;
      siteCounter.set(roiDna, (siteCounter.get(roiDna) ?? 0) + 1);
      passedSites.push({ siteName: site.name, roiDna });
    }

    if (passedSites.length === 0) {
      this.globalBreakdown.no_site_extracted++;
      return "no_site_extracted";
    }
    if (allSitesPassed && this.emitHaplotypes) {
      const joined = passedSites.map((p) => p.roiDna).join("_");
      roundStats.haplotype_passed_qc++;
      const h = this.haplotypeCounters.get(round.name)!;
      h.set(joined, (h.get(joined) ?? 0) + 1);
    }
    return "assigned";
  }
}

function freshSiteStats(): NanoporeSiteStats {
  return {
    anchor_found: 0,
    discard_roi_indel: 0,
    discard_low_q_roi: 0,
    discard_frameshift: 0,
    discard_stop_codon: 0,
    passed_qc: 0,
    wt_count: 0,
  };
}

// --- Helper for orchestrator: resolve WT ROI per site --------------------

/** For each site, find the exact anchor positions in the reference and
 *  return the WT ROI bytes-as-string. Throws if any site's anchors aren't
 *  found in order; the orchestrator catches this and reports it. */
export function resolveWtRois(
  reference: string,
  sites: ReadonlyArray<{ name: string; fwAnchor: string; rvAnchor: string }>,
): { wtByName: Map<string, string>; expectedRoiLen: Map<string, number> } {
  const ref = reference.replace(/[^ACGTNacgtn]/g, "").toUpperCase();
  const wtByName = new Map<string, string>();
  const expectedRoiLen = new Map<string, number>();
  for (const s of sites) {
    const fw = s.fwAnchor.toUpperCase();
    const rv = s.rvAnchor.toUpperCase();
    const fwIdx = ref.indexOf(fw);
    if (fwIdx < 0) throw new Error(`Site ${s.name}: upstream anchor not found in reference.`);
    const rvIdx = ref.indexOf(rv, fwIdx + fw.length);
    if (rvIdx < 0) throw new Error(`Site ${s.name}: downstream anchor not found in reference after upstream.`);
    const roi = ref.slice(fwIdx + fw.length, rvIdx);
    if (roi.length === 0) throw new Error(`Site ${s.name}: ROI is empty (anchors overlap).`);
    wtByName.set(s.name, roi);
    expectedRoiLen.set(s.name, roi.length);
  }
  return { wtByName, expectedRoiLen };
}
