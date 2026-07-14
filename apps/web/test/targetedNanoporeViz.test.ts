import { describe, expect, it } from "vitest";
import { targetedRowsToChartRows } from "../src/tools/nanopore-targeted/viz";

describe("targeted Nanopore chart adapter", () => {
  it("keeps biological target identity and uses descriptive stepwise RPM with target-scoped statistics", () => {
    const [row] = targetedRowsToChartRows([{
      Target: "R116", Variant_AA: "F", Dominant_DNA: "TTT",
      "Count_Round 0": 10, "RPM_Round 0": 100,
      "Count_Round 1": 40, "RPM_Round 1": 800,
      "Centered_Enrichment_Round 1_vs_Round 0": 2.5, "Pval_Enrichment_Round 1_vs_Round 0": .001,
      "FDR_q_Round 1_vs_Round 0": .01, "Var_Enrichment_Round 1_vs_Round 0": .2,
    }], ["Round 0", "Round 1"]);
    expect(row!.peptide).toBe("R116:F");
    expect(row!.stepwise["Round 1"]).toBeCloseTo(Math.log2(801 / 101));
    expect(row!.centered["Round 1"]).toBe(2.5);
    expect(row!.fdr["Round 1"]).toBe(.01);
  });
});
