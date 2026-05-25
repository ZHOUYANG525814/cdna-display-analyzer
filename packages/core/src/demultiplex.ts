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
  /** Mean Phred threshold; reads with mean < this are dropped before scoring. */
  minMeanPhred: number;
}

export type UnassignedReason = "low_quality" | "no_anchor" | "ambiguous" | "barcode_mismatch";
export type ProcessResult = "assigned" | "no_anchor" | "ambiguous" | "barcode_mismatch";

export interface RoundStats {
  total_assigned: number;
  discard_truncated: number;
  discard_length_indel: number;
  discard_stop_codon: number;
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
  processRead(seq: Uint8Array): ProcessResult {
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

    // 7. Stop codon (when filter is on).
    if (this.settings.filterStop && !hasNoStopCodon(cdsBytes)) {
      roundStats.discard_stop_codon++;
      return "assigned";
    }

    // 8. Commit. decodeCds produces a fresh atomized string with no parent
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
}
