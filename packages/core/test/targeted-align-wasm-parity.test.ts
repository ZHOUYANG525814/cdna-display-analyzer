import { describe, expect, it } from "vitest";
import {
  alignTargetedReferenceWithEstimate,
  createTargetedReferenceSeedIndex,
  estimateReferenceOffsetIndexed,
} from "../src/targeted-align.js";
import { createWasmTargetedAligner } from "../src/targeted-wasm.js";

const ENC = new TextEncoder();

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (1664525 * state + 1013904223) >>> 0) / 0x1_0000_0000);
}

function randomDna(length: number, next: () => number): string {
  const bases = "ACGT";
  return Array.from({ length }, () => bases[Math.floor(next() * 4)]).join("");
}

describe("TargetedAligner WASM candidate", () => {
  it("matches the TypeScript oracle on deterministic substitutions, indels and flanks", () => {
    const next = rng(0x5eed1234);
    const referenceString = randomDna(240, next);
    const reference = ENC.encode(referenceString);
    const seedIndex = createTargetedReferenceSeedIndex(reference);
    const wasm = createWasmTargetedAligner(reference);
    try {
      for (let sample = 0; sample < 200; sample++) {
        let read = "GGG" + referenceString + "TTAA";
        const position = 3 + Math.floor(next() * referenceString.length);
        if (sample % 3 === 0) {
          const old = read[position]!;
          read = read.slice(0, position) + "ACGT".split("").find((base) => base !== old)! + read.slice(position + 1);
        } else if (sample % 3 === 1) {
          read = read.slice(0, position) + "A" + read.slice(position);
        } else {
          read = read.slice(0, position) + read.slice(position + 1);
        }
        const bytes = ENC.encode(read);
        const tsEstimate = estimateReferenceOffsetIndexed(seedIndex, bytes);
        expect(wasm.estimate(bytes)).toEqual(tsEstimate);
        const ts = alignTargetedReferenceWithEstimate(reference, bytes, tsEstimate);
        const candidate = wasm.alignWithEstimate(bytes, tsEstimate);
        expect(candidate).toEqual(ts);
      }
    } finally {
      wasm.free();
    }
  });
});
