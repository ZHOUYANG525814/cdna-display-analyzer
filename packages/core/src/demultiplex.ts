// Port of 01_scripts/core_engine.py DemultiplexEngine. Same scoring constants,
// same coordinate math, same reason codes. The hot path stays in Uint8Array;
// only the per-record CDS slice is decoded into a string when committing to
// the counter Map (avoids V8 sliced-string retention).

import { ASCII, decodeCds, hasNoStopCodon } from "./dna.js";
import type { WasmScorerLike } from "./wasm.js";

export const MAX_BARCODE_ERROR = 1.0;
export const MIN_VICTORY_MARGIN = 1.0;
const ANCHOR_LEN = 10;

export interface RoundConfigInput {
  name: string;
  fwPrimer: string;
  rvPrimer: string;
  cdsStart: number;
  cdsEnd: number;
}

export interface PreprocessedRound {
  name: string;
  fwPrimerLen: number;
  fwAnchor: Uint8Array;     // last 10 bp of fwPrimer (or whole primer if shorter)
  fwBarcode: Uint8Array;    // fwPrimer[:-anchor_len]
  rvAnchor: Uint8Array;     // first 10 bp of reverse-complement(rvPrimer)
  cdsStart: number;         // user-supplied, 1-based-ish offset relative to Fw anchor end
  cdsEnd: number;
}

export interface DemultiplexSettings {
  adaptive: boolean;
  filterStop: boolean;
  /** Mean Phred threshold; reads with whole-read mean < this are dropped
   *  before barcode scoring (cheap pre-filter). */
  minMeanPhred: number;
  /** Stricter post-anchor check: after the CDS slice is located, the mean
   *  Phred over JUST those bases must also be ≥ this. Defaults to the same
   *  value as `minMeanPhred`. Catches reads with high overall quality but
   *  a noisy CDS region — common when Illumina quality decays toward the
   *  read 3' end and the CDS happens to live near it. */
  minMeanPhredCds: number;
}

export type UnassignedReason = "low_quality" | "no_anchor" | "ambiguous" | "barcode_mismatch";
export type ProcessResult = "assigned" | "no_anchor" | "ambiguous" | "barcode_mismatch";

export interface RoundStats {
  total_assigned: number;
  discard_truncated: number;
  discard_length_indel: number;
  discard_stop_codon: number;
  /** Reads whose CDS-slice mean Phred fell below the threshold. The pre-
   *  engine `low_quality` filter catches reads with globally-bad qual; this
   *  catches the more insidious case where a read is OK overall but the CDS
   *  region (typically toward the read's 3' end, where Illumina qual drops)
   *  is too noisy to trust the called variant. Adds ~10 ns per assigned read
   *  in the inner loop. */
  discard_low_quality_cds: number;
  passed_qc: number;
}

export interface UnassignedBreakdown {
  low_quality: number;
  no_anchor: number;
  ambiguous: number;
  barcode_mismatch: number;
}

const ASCII_ENC = new TextEncoder();
function encodeAscii(s: string): Uint8Array {
  return ASCII_ENC.encode(s);
}

// Naive substring search over Uint8Array. Adequate for 10 bp anchors against
// 150 bp reads (~1500 byte comparisons worst case). The eventual WASM phase
// replaces this with a SIMD scan.
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  const nLen = needle.length;
  const hLen = haystack.length;
  if (nLen === 0) return start <= hLen ? start : -1;
  if (nLen > hLen - start) return -1;
  const last = hLen - nLen;
  const first = needle[0];
  outer: for (let i = start; i <= last; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < nLen; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// Reverse-complement bytes into a fresh Uint8Array. Separate from
// reverseComplementBytes (which produces a string) because the demultiplex
// retry stays in the byte domain.
export function reverseComplementBytesToBytes(input: Uint8Array): Uint8Array {
  const n = input.length;
  const out = new Uint8Array(n);
  rcInto(input, out);
  return out;
}

// Same RC mapping but writes into a caller-provided scratch buffer, returning
// the same buffer trimmed to the read length. The pipeline holds a scratch
// sized to the largest read seen so far and reuses it across every retry —
// this dodges the Uint8Array allocation on what's typically 30–50% of reads.
// Lowercase a/c/g/t/n are uppercased first by the pipeline's upstream
// uppercaseInto, so this function only needs to know about ACGTN.
export function rcInto(input: Uint8Array, scratch: Uint8Array): Uint8Array {
  const n = input.length;
  for (let i = 0; i < n; i++) {
    const c = input[n - 1 - i];
    scratch[i] = c === ASCII.A ? ASCII.T
               : c === ASCII.T ? ASCII.A
               : c === ASCII.C ? ASCII.G
               : c === ASCII.G ? ASCII.C
               : c === ASCII.N ? ASCII.N
               : c;
  }
  return scratch.subarray(0, n);
}

/** Uppercase ASCII letters in-place into a scratch buffer. Lowercase a-z
 *  (0x61-0x7A) → A-Z (0x41-0x5A); everything else passes through. Used as
 *  the B5 fix: some upstream tools emit soft-masked lowercase bases that
 *  would silently fail the engine's exact-byte anchor scan. */
export function uppercaseInto(input: Uint8Array, scratch: Uint8Array): Uint8Array {
  const n = input.length;
  for (let i = 0; i < n; i++) {
    const c = input[i]!;
    scratch[i] = c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
  }
  return scratch.subarray(0, n);
}

/** Reverse a byte array into a scratch buffer. Used for qual on the RC
 *  retry path: when seq is reverse-complemented, qual must be reversed
 *  (without complement — qual scores are platform-independent of base) so
 *  the per-position Q-score in the CDS region lines up with the per-position
 *  bases the engine scores. */
export function reverseInto(input: Uint8Array, scratch: Uint8Array): Uint8Array {
  const n = input.length;
  for (let i = 0; i < n; i++) scratch[i] = input[n - 1 - i]!;
  return scratch.subarray(0, n);
}

/** Verbatim copy into a scratch buffer. Small but worth its name: keeps the
 *  pipeline branch-free between forward + RC paths where the latter needs
 *  a separate qual buffer (reversed) but the former is identity. */
export function copyInto(input: Uint8Array, scratch: Uint8Array): Uint8Array {
  scratch.set(input);
  return scratch.subarray(0, input.length);
}

export function preprocessRounds(inputs: ReadonlyArray<RoundConfigInput>): PreprocessedRound[] {
  return inputs.map((cfg) => {
    const fwPrimerBytes = encodeAscii(cfg.fwPrimer);
    const anchorLen = Math.min(ANCHOR_LEN, fwPrimerBytes.length);
    const fwAnchor = fwPrimerBytes.slice(fwPrimerBytes.length - anchorLen);
    const fwBarcode = fwPrimerBytes.length > anchorLen
      ? fwPrimerBytes.slice(0, fwPrimerBytes.length - anchorLen)
      : new Uint8Array(0);
    const rcRv = reverseComplementBytesToBytes(encodeAscii(cfg.rvPrimer));
    const rvAnchor = rcRv.length >= ANCHOR_LEN ? rcRv.slice(0, ANCHOR_LEN) : rcRv;
    return {
      name: cfg.name,
      fwPrimerLen: fwPrimerBytes.length,
      fwAnchor,
      fwBarcode,
      rvAnchor,
      cdsStart: cfg.cdsStart,
      cdsEnd: cfg.cdsEnd,
    };
  });
}

interface ScoreBoardEntry {
  score: number;
  roundIdx: number;
  fwEndIdx: number;
}

export class DemultiplexEngine {
  readonly stats: Map<string, RoundStats>;
  readonly dnaCounters: Map<string, Map<string, number>>;
  readonly unassignedBreakdown: UnassignedBreakdown;
  globalUnassigned: number = 0;

  private readonly rounds: ReadonlyArray<PreprocessedRound>;
  private readonly settings: DemultiplexSettings;
  // Scratch score board, reused across reads to avoid per-call allocation.
  private readonly scoreBoard: ScoreBoardEntry[] = [];
  // Optional WASM-backed scoring. When set, the inner round-loop is replaced
  // with a single wasm boundary crossing per read; numeric results must match
  // the TS path byte-for-byte (asserted by the parity test).
  private readonly wasmScorer: WasmScorerLike | undefined;

  constructor(
    rounds: ReadonlyArray<PreprocessedRound>,
    settings: DemultiplexSettings,
    opts: { wasmScorer?: WasmScorerLike } = {},
  ) {
    this.rounds = rounds;
    this.settings = settings;
    this.wasmScorer = opts.wasmScorer;
    this.stats = new Map();
    this.dnaCounters = new Map();
    for (const r of rounds) {
      this.stats.set(r.name, {
        total_assigned: 0,
        discard_truncated: 0,
        discard_length_indel: 0,
        discard_stop_codon: 0,
        discard_low_quality_cds: 0,
        passed_qc: 0,
      });
      this.dnaCounters.set(r.name, new Map());
    }
    this.unassignedBreakdown = { low_quality: 0, no_anchor: 0, ambiguous: 0, barcode_mismatch: 0 };
    for (let i = 0; i < rounds.length; i++) {
      this.scoreBoard.push({ score: 0, roundIdx: 0, fwEndIdx: 0 });
    }
  }

  // Mirror of Python's _process_read. Returns the same reason codes. State
  // mutations (counters, stats) happen in this method for any "assigned"
  // outcome (including discards charged to a round-level bucket); only the
  // unassigned cases ("no_anchor" / "barcode_mismatch" / "ambiguous") are
  // bubbled up so the caller can retry on the reverse-complement strand.
  processRead(seq: Uint8Array, qual: Uint8Array): ProcessResult {
    let bestScore: number;
    let bestRoundIdx: number;
    let bestFwEndIdx: number;
    let runnerUpScore: number;

    if (this.wasmScorer) {
      // WASM path: one boundary crossing, results destructured immediately.
      const r = this.wasmScorer.score(seq);
      bestRoundIdx = r.bestRoundIdx;
      if (bestRoundIdx === -1) return "no_anchor";
      bestScore = r.bestScore;
      bestFwEndIdx = r.fwEndIdx;
      runnerUpScore = r.runnerUpScore;
    } else {
      // Pure-TS path. 1. Score every round whose Fw anchor matches the read.
      let boardLen = 0;
      for (let r = 0; r < this.rounds.length; r++) {
        const cfg = this.rounds[r]!;
        const idx = indexOfBytes(seq, cfg.fwAnchor);
        if (idx === -1) continue;

        const expectedBc = cfg.fwBarcode;
        const expectedBcLen = expectedBc.length;
        // The read's barcode is whatever bytes precede the anchor, capped at
        // expectedBcLen on the left. If the read starts mid-barcode we score
        // each missing base as 1.0 (matches Python).
        const bcStart = Math.max(0, idx - expectedBcLen);
        const readBcLen = idx - bcStart;
        const lenDiff = expectedBcLen - readBcLen;

        let score = lenDiff > 0 ? lenDiff : 0;
        const compareStart = lenDiff > 0 ? lenDiff : 0;
        for (let j = 0; j < readBcLen; j++) {
          const e = expectedBc[compareStart + j];
          const v = seq[bcStart + j];
          if (v === ASCII.N) score += 0.5;
          else if (v !== e) score += 1.0;
        }

        const slot = this.scoreBoard[boardLen]!;
        slot.score = score;
        slot.roundIdx = r;
        slot.fwEndIdx = idx + cfg.fwAnchor.length;
        boardLen++;
      }

      if (boardLen === 0) return "no_anchor";

      // 2. Stable sort by score ascending. Native Array.sort is stable
      //    (ES2019); this preserves round-definition order on ties, matching
      //    Python's TimSort applied to a list filled in dict-iteration order.
      const used = this.scoreBoard.slice(0, boardLen);
      used.sort((a, b) => a.score - b.score);
      bestScore = used[0]!.score;
      bestRoundIdx = used[0]!.roundIdx;
      bestFwEndIdx = used[0]!.fwEndIdx;
      runnerUpScore = used.length > 1 ? used[1]!.score : Infinity;
    }

    if (bestScore > MAX_BARCODE_ERROR) return "barcode_mismatch";
    if (runnerUpScore - bestScore < MIN_VICTORY_MARGIN) return "ambiguous";

    const assigned = this.rounds[bestRoundIdx]!;
    const roundStats = this.stats.get(assigned.name)!;
    roundStats.total_assigned++;

    // 3. CDS coordinate math, identical to Python (_map_coordinate adds -1 to
    //    cds_start to convert from 1-based-relative to 0-based-relative).
    const startOffset = assigned.cdsStart - 1;
    const cdsStartAbs = bestFwEndIdx + startOffset;
    const cdsEndAbs = bestFwEndIdx + assigned.cdsEnd;

    // 4. Truncation check (read too short to cover the user-defined CDS span).
    if (cdsEndAbs > seq.length || cdsStartAbs < 0) {
      roundStats.discard_truncated++;
      return "assigned";
    }

    const cdsBytes = seq.subarray(cdsStartAbs, cdsEndAbs);
    const cdsLen = cdsBytes.length;

    // 5. Large-indel check via Rv anchor (only when adaptive is off).
    if (!this.settings.adaptive) {
      const rvIdx = indexOfBytes(seq, assigned.rvAnchor, bestFwEndIdx);
      if (rvIdx !== -1 && cdsEndAbs > rvIdx) {
        roundStats.discard_length_indel++;
        return "assigned";
      }
    }

    // 6. Frameshift.
    if (cdsLen % 3 !== 0) {
      roundStats.discard_length_indel++;
      return "assigned";
    }

    // 7. CDS-region Q-score check. The pre-engine global mean-Phred filter
    //    caught reads with universally bad qual; this catches the trickier
    //    case where the whole-read mean was OK but the CDS bases themselves
    //    are too noisy to trust. Phred+33 mean over the slice — no allocation.
    {
      const qLen = cdsEndAbs - cdsStartAbs;
      if (qLen > 0 && cdsEndAbs <= qual.length) {
        let qSum = 0;
        for (let k = cdsStartAbs; k < cdsEndAbs; k++) qSum += qual[k]! - 33;
        const cdsMeanQ = qSum / qLen;
        if (cdsMeanQ < this.settings.minMeanPhredCds) {
          roundStats.discard_low_quality_cds++;
          return "assigned";
        }
      }
    }

    // 8. Stop codon (when filter is on).
    if (this.settings.filterStop && !hasNoStopCodon(cdsBytes)) {
      roundStats.discard_stop_codon++;
      return "assigned";
    }

    // 9. Commit. decodeCds produces a fresh atomized string with no parent
    //    reference, safe to use as a long-lived Map key.
    roundStats.passed_qc++;
    const cdsStr = decodeCds(cdsBytes);
    const counter = this.dnaCounters.get(assigned.name)!;
    counter.set(cdsStr, (counter.get(cdsStr) ?? 0) + 1);

    return "assigned";
  }

  recordLowQuality(): void {
    this.globalUnassigned++;
    this.unassignedBreakdown.low_quality++;
  }

  recordUnassigned(reason: ProcessResult): void {
    if (reason === "assigned") return;
    this.globalUnassigned++;
    this.unassignedBreakdown[reason]++;
  }

  /** Per-round entry point used by per-FASTQ-per-round mode. Scores the read
   *  only against `roundIdx`'s primer (no cross-round competition, no
   *  ambiguity check). If the Fw anchor is missing we still return
   *  "no_anchor" so the caller can retry on the reverse complement, but the
   *  read is NEVER reassigned to a different round.
   *
   *  All downstream behaviour (CDS slice, frameshift, stop-codon, commit) is
   *  identical to processRead — we just bypass the round-comparison step.
   *  Yields byte-identical numerical results for single-round configurations
   *  by construction. */
  processReadForRound(seq: Uint8Array, qual: Uint8Array, roundIdx: number): ProcessResult {
    const cfg = this.rounds[roundIdx];
    if (!cfg) return "no_anchor";

    const idx = indexOfBytes(seq, cfg.fwAnchor);
    if (idx === -1) return "no_anchor";

    // Compute the barcode-mismatch score (kept for stats parity, even though
    // we no longer compete rounds). A read whose barcode is bad enough to
    // exceed MAX_BARCODE_ERROR still gets charged to "barcode_mismatch" so
    // per-round QC numbers stay meaningful.
    const expectedBc = cfg.fwBarcode;
    const expectedBcLen = expectedBc.length;
    const bcStart = Math.max(0, idx - expectedBcLen);
    const readBcLen = idx - bcStart;
    const lenDiff = expectedBcLen - readBcLen;
    let score = lenDiff > 0 ? lenDiff : 0;
    const compareStart = lenDiff > 0 ? lenDiff : 0;
    for (let j = 0; j < readBcLen; j++) {
      const e = expectedBc[compareStart + j];
      const v = seq[bcStart + j];
      if (v === ASCII.N) score += 0.5;
      else if (v !== e) score += 1.0;
    }
    if (score > MAX_BARCODE_ERROR) return "barcode_mismatch";

    const bestFwEndIdx = idx + cfg.fwAnchor.length;

    const roundStats = this.stats.get(cfg.name)!;
    roundStats.total_assigned++;

    const startOffset = cfg.cdsStart - 1;
    const cdsStartAbs = bestFwEndIdx + startOffset;
    const cdsEndAbs = bestFwEndIdx + cfg.cdsEnd;

    if (cdsEndAbs > seq.length || cdsStartAbs < 0) {
      roundStats.discard_truncated++;
      return "assigned";
    }

    const cdsBytes = seq.subarray(cdsStartAbs, cdsEndAbs);
    const cdsLen = cdsBytes.length;

    if (!this.settings.adaptive) {
      const rvIdx = indexOfBytes(seq, cfg.rvAnchor, bestFwEndIdx);
      if (rvIdx !== -1 && cdsEndAbs > rvIdx) {
        roundStats.discard_length_indel++;
        return "assigned";
      }
    }

    if (cdsLen % 3 !== 0) {
      roundStats.discard_length_indel++;
      return "assigned";
    }

    // CDS-region Q-score check (same logic as processRead — see B2 fix).
    {
      const qLen = cdsEndAbs - cdsStartAbs;
      if (qLen > 0 && cdsEndAbs <= qual.length) {
        let qSum = 0;
        for (let k = cdsStartAbs; k < cdsEndAbs; k++) qSum += qual[k]! - 33;
        const cdsMeanQ = qSum / qLen;
        if (cdsMeanQ < this.settings.minMeanPhredCds) {
          roundStats.discard_low_quality_cds++;
          return "assigned";
        }
      }
    }

    if (this.settings.filterStop && !hasNoStopCodon(cdsBytes)) {
      roundStats.discard_stop_codon++;
      return "assigned";
    }

    roundStats.passed_qc++;
    const cdsStr = decodeCds(cdsBytes);
    const counter = this.dnaCounters.get(cfg.name)!;
    counter.set(cdsStr, (counter.get(cdsStr) ?? 0) + 1);

    return "assigned";
  }
}
