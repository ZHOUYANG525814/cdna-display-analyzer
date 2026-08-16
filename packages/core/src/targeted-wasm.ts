import * as wasm from "@cdna/targeted-wasm";
import type {
  CigarCode,
  TargetedAlignment,
  TargetedDiagonalEstimate,
} from "./targeted-align.js";

export interface WasmTargetedAlignerLike {
  estimate(read: Uint8Array): TargetedDiagonalEstimate;
  alignWithEstimate(read: Uint8Array, estimate: TargetedDiagonalEstimate): TargetedAlignment;
  free(): void;
}

export function createWasmTargetedAligner(reference: Uint8Array): WasmTargetedAlignerLike {
  const aligner = new wasm.TargetedAligner(reference);
  let result = aligner.resultView();
  const refreshResult = (): Float64Array => {
    if (result.byteLength === 0) result = aligner.resultView();
    return result;
  };
  return {
    estimate(read) {
      aligner.estimate(read);
      const view = refreshResult();
      return { offset: view[9]!, hits: view[10]! };
    },
    alignWithEstimate(read, estimate) {
      if (!aligner.alignWithEstimate(read, estimate.offset, estimate.hits)) {
        throw new Error("No alignment path found within maximum band 192.");
      }
      const view = refreshResult();
      const packed = aligner.cigarView();
      const codes: CigarCode[] = ["M", "X", "I", "D"];
      const cigar = Array.from(packed, (value) => ({
        code: codes[value & 3]!,
        length: value >>> 2,
      }));
      return {
        score: view[0]!, readStart: view[1]!, readEnd: view[2]!,
        matches: view[3]!, mismatches: view[4]!, insertedBases: view[5]!, deletedBases: view[6]!,
        identity: view[7]!, referenceCoverage: view[8]!,
        estimatedOffset: view[9]!, seedHits: view[10]!, bandUsed: view[11]!, bandTouched: view[12] === 1,
        cigar,
        cigarString: cigar.map((op) => `${op.length}${op.code}`).join(""),
      };
    },
    free() { aligner.free(); },
  };
}
