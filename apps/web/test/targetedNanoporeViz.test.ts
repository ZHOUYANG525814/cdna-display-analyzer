import { describe, expect, it } from "vitest";
import { targetedRowsToChartRows } from "../src/tools/nanopore-targeted/viz";

describe("targeted Nanopore chart adapter", () => {
  it("keeps site identity and uses descriptive stepwise RPM with existing site-scoped statistics", () => {
    const [row] = targetedRowsToChartRows([{
      Site: "aa116", Variant_AA: "F", Dominant_DNA: "TTT",
      "Count_Round 0": 10, "RPM_Round 0": 100,
      "Count_Round 1": 40, "RPM_Round 1": 800,
      "Centered_Fitness_Round 1": 2.5, "Pval_Fitness_Round 1": .001,
      "FDR_q_Round 1": .01, "Var_Fitness_Round 1": .2,
    }], ["Round 0", "Round 1"]);
    expect(row!.peptide).toBe("aa116:F");
    expect(row!.stepwise["Round 1"]).toBeCloseTo(Math.log2(801 / 101));
    expect(row!.centered["Round 1"]).toBe(2.5);
    expect(row!.fdr["Round 1"]).toBe(.01);
  });
});
