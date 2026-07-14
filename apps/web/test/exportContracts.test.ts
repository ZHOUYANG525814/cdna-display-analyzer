import { describe, expect, it } from "vitest";
import { CDNA_EXPORT_FILES } from "../src/adapters/BrowserExporter";

describe("download contracts", () => {
  it("exposes the full-length NGS combination matrix as a deliberate fourth artifact", () => {
    expect(CDNA_EXPORT_FILES.map(([name]) => name)).toEqual([
      "Master_Enrichment_Matrix.csv.gz",
      "Combination_Enrichment_Matrix.csv.gz",
      "run_stats.json",
      "QC_Summary_Report.txt",
    ]);
    expect(CDNA_EXPORT_FILES[1]![1]).toMatch(/full-length/i);
  });
});
