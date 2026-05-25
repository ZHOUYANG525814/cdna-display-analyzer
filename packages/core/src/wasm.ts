// Thin TS facade over @cdna/core-wasm. Two responsibilities:
//   - Build a Scorer prepopulated with each preprocessed round (anchor +
//     barcode bytes). Returned object exposes a single `score(seq)` call
//     that crosses the wasm boundary once per read.
//   - Expose RC + meanPhred byte-bands so the pipeline can choose between
//     pure-TS (reference) and WASM (production) implementations.
//
// The two implementations are kept byte-identical: the same parity test
// passes against both. Switching is opt-in at engine construction time.

import * as wasm from "@cdna/core-wasm";
import type { PreprocessedRound } from "./demultiplex.js";

export interface WasmScoreResult {
  bestScore: number;
  bestRoundIdx: number; // -1 when no anchor matched any round
  fwEndIdx: number;
  runnerUpScore: number; // +Infinity when only one round matched
}

export interface WasmScorerLike {
  score(seq: Uint8Array): WasmScoreResult;
  // Free the underlying wasm allocation. Optional in Node where GC is reliable.
  free?(): void;
}

export function createWasmScorer(rounds: ReadonlyArray<PreprocessedRound>): WasmScorerLike {
  const scorer = new wasm.Scorer();
  for (const r of rounds) {
    scorer.addRound(r.fwAnchor, r.fwBarcode);
  }
  // `resultView` aliases the Scorer's internal `[f64; 4]` in linear memory —
  // no copy per call. If WASM memory grows (rare; malloc pool warms up after
  // a few reads), the view's buffer detaches; byteLength === 0 triggers a
  // refresh.
  let resultView: Float64Array = scorer.resultView();
  return {
    score(seq: Uint8Array): WasmScoreResult {
      scorer.score(seq);
      if (resultView.byteLength === 0) resultView = scorer.resultView();
      return {
        bestScore: resultView[0]!,
        runnerUpScore: resultView[1]!,
        bestRoundIdx: resultView[2]!,
        fwEndIdx: resultView[3]!,
      };
    },
    free() {
      scorer.free();
    },
  };
}

// Pass-through wrappers for the byte primitives. Kept in this module so any
// callsite that touches WASM goes through one place — easier to swap in a
// SharedArrayBuffer-based zero-copy variant later.
export function wasmReverseComplement(input: Uint8Array): Uint8Array {
  return wasm.reverseComplement(input);
}

export function wasmMeanPhred(qual: Uint8Array): number {
  return wasm.meanPhred(qual);
}
