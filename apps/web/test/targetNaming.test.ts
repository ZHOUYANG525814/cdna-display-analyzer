import { describe, expect, it } from "vitest";
import { aminoAcidTargetLabel } from "../src/tools/nanopore-targeted/targetNaming";

describe("targeted Nanopore biological target naming", () => {
  it("derives reference-AA plus CDS position from an amplicon coordinate", () => {
    const reference = `TTT${"GCT".repeat(232)}CGT${"GCT".repeat(10)}`;
    expect(aminoAcidTargetLabel(reference, 4, 700)).toEqual({
      name: "R233", aaPosition: 233, referenceAa: "R", wtDna: "CGT",
    });
  });

  it("rejects coordinates that are not complete CDS codons", () => {
    expect(() => aminoAcidTargetLabel("GCTGCT", 1, 2)).toThrow(/complete CDS codon/);
  });
});
