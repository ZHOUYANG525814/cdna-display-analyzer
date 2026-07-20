import { describe, expect, it } from "vitest";
import { log2RpmRatio } from "@cdna/core";
import { computeEnrichmentTests } from "../src/tools/cdna-display/viz/stats";
import type { PeptideRecord } from "../src/tools/cdna-display/viz/csvParse";

function row(peptide: string, src: number, dest: number): PeptideRecord {
  return {
    peptide,
    gc: 0,
    dominantDna: "",
    count: { R0: src, R1: dest },
    rpm: {},
    stepwise: {},
    centered: {},
    pval: {},
    fdr: {},
    variance: {},
  };
}

describe("visualization enrichment parity", () => {
  it.each([0.5, 1])("uses the core score for pseudocount %s", (pseudocount) => {
    const result = computeEnrichmentTests([row("PEP", 2, 10)], "R0", "R1", 80, 100, pseudocount);
    expect(result[0]!.log2FC).toBe(
      log2RpmRatio(10, 100, 2, 80, pseudocount),
    );
  });
});
