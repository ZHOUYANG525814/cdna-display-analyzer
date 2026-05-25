import { describe, expect, it } from "vitest";
import { runAnalyzer, type AnalyzerInput, serializeCsv } from "../src/analyzer.js";
import type { RoundStats } from "../src/demultiplex.js";

function mkStats(passedQc: number): RoundStats {
  return {
    total_assigned: passedQc,
    discard_truncated: 0,
    discard_length_indel: 0,
    discard_stop_codon: 0,
    passed_qc: passedQc,
  };
}

describe("runAnalyzer", () => {
  it("returns null on empty input", () => {
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([["R0", new Map()]]),
      stats: new Map([["R0", mkStats(0)]]),
    });
    expect(out).toBeNull();
  });

  it("collapses synonymous DNA codons to one peptide row", () => {
    // ATGGCC = MA, ATGGCG = MA also (GCC and GCG both → A). Should collapse.
    const counter = new Map<string, number>([
      ["ATGGCC", 10],
      ["ATGGCG", 5],
    ]);
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([["R0", counter]]),
      stats: new Map([["R0", mkStats(15)]]),
    })!;
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.Peptide_Seq).toBe("MA");
    // ATGGCC has count 10 > ATGGCG count 5 → ATGGCC dominant.
    expect(out.rows[0]!.Dominant_DNA_Seq).toBe("ATGGCC");
    expect(out.rows[0]!.Count_R0).toBe(15);
  });

  it("computes RPM as count / passed_qc × 1e6", () => {
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([["R0", new Map([["ATGGCC", 5]])]]),
      stats: new Map([["R0", mkStats(1000)]]),
    })!;
    // 5 / 1000 × 1e6 = 5000
    expect(out.rows[0]!.RPM_R0).toBe(5000);
  });

  it("RPM is 0 when passed_qc is 0 (matches Python guard)", () => {
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([["R0", new Map([["ATGGCC", 5]])]]),
      stats: new Map([["R0", mkStats(0)]]),
    })!;
    expect(out.rows[0]!.RPM_R0).toBe(0);
  });

  it("assigns competition ('min') ranks descending on RPM", () => {
    // Three peptides, RPMs [10, 10, 5] → ranks [1, 1, 3].
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([
        [
          "R0",
          new Map([
            ["ATGAAA", 10], // M-K
            ["ATGCCC", 10], // M-P
            ["ATGGGG", 5],  // M-G
          ]),
        ],
      ]),
      stats: new Map([["R0", mkStats(25)]]),
    })!;
    const byPeptide = new Map(out.rows.map((r) => [r.Peptide_Seq, r]));
    expect(byPeptide.get("MK")!.Rank_R0).toBe(1);
    expect(byPeptide.get("MP")!.Rank_R0).toBe(1);
    expect(byPeptide.get("MG")!.Rank_R0).toBe(3);
  });

  it("computes stepwise + global log2 enrichment with pseudocount 1.0", () => {
    // Peptide M: R0 count 1, R1 count 100, R2 count 0.
    // passed_qc: R0=1000, R1=1000, R2=1000 → RPMs 1000, 100000, 0.
    // Step R1 vs R0: log2((100000+1)/(1000+1)) ≈ log2(99.9) ≈ 6.643
    // Step R2 vs R1: log2((0+1)/(100000+1)) ≈ log2(1e-5) ≈ -16.61
    // Global R1 vs R0: same as step (only 2 rounds either way for global)
    // Global R2 vs R0: log2((0+1)/(1000+1)) ≈ log2(1e-3) ≈ -9.97
    const out = runAnalyzer({
      roundNames: ["R0", "R1", "R2"],
      dnaCounters: new Map([
        ["R0", new Map([["ATG", 1]])],
        ["R1", new Map([["ATG", 100]])],
        ["R2", new Map()],
      ]),
      stats: new Map([
        ["R0", mkStats(1000)],
        ["R1", mkStats(1000)],
        ["R2", mkStats(1000)],
      ]),
    })!;
    const r = out.rows[0]!;
    expect(r.RPM_R0).toBe(1000);
    expect(r.RPM_R1).toBe(100000);
    expect(r.RPM_R2).toBe(0);
    // Exact float-64 values; we want byte-identical match with Python so just
    // assert the math matches Math.log2 directly (no tolerance — they should
    // be ULP-identical to np.log2).
    expect(r["Enrich_Step_R1_vs_R0"]).toBe(Math.log2((100000 + 1) / (1000 + 1)));
    expect(r["Enrich_Step_R2_vs_R1"]).toBe(Math.log2((0 + 1) / (100000 + 1)));
    expect(r["Enrich_Global_R1_vs_R0"]).toBe(Math.log2((100000 + 1) / (1000 + 1)));
    expect(r["Enrich_Global_R2_vs_R0"]).toBe(Math.log2((0 + 1) / (1000 + 1)));
  });

  it("sets Present_In_All only when every round has count > 0", () => {
    const out = runAnalyzer({
      roundNames: ["R0", "R1"],
      dnaCounters: new Map([
        ["R0", new Map([["ATG", 1], ["GCC", 1]])],
        ["R1", new Map([["ATG", 1]])],
      ]),
      stats: new Map([
        ["R0", mkStats(2)],
        ["R1", mkStats(1)],
      ]),
    })!;
    const m = out.rows.find((r) => r.Peptide_Seq === "M")!;
    const a = out.rows.find((r) => r.Peptide_Seq === "A")!;
    expect(m.Present_In_All).toBe(true);
    expect(a.Present_In_All).toBe(false);
  });

  it("sorts by enrichment desc with Peptide_Seq asc tiebreaker (stable)", () => {
    // Two peptides with identical enrichment (both seen once in both rounds)
    // → ties broken alphabetically: 'MA' < 'MG'.
    const out = runAnalyzer({
      roundNames: ["R0", "R1"],
      dnaCounters: new Map([
        ["R0", new Map([["ATGGCC", 1], ["ATGGGG", 1]])],
        ["R1", new Map([["ATGGCC", 1], ["ATGGGG", 1]])],
      ]),
      stats: new Map([
        ["R0", mkStats(2)],
        ["R1", mkStats(2)],
      ]),
    })!;
    expect(out.rows.map((r) => r.Peptide_Seq)).toEqual(["MA", "MG"]);
  });
});

describe("CSV serialization (pandas parity)", () => {
  it("integer columns render without decimal; float columns add .0 for integers", () => {
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([["R0", new Map([["ATG", 5]])]]),
      stats: new Map([["R0", mkStats(1000)]]),
    })!;
    const lines = out.csv.trim().split("\n");
    expect(lines[0]).toBe("Peptide_Seq,Dominant_DNA_Seq,GC_Percent,Count_R0,RPM_R0,Rank_R0,Present_In_All");
    // RPM = 5/1000 * 1e6 = 5000.0 — should appear as "5000.0" not "5000".
    expect(lines[1]).toContain(",5000.0,");
    // Count = 5 — should appear as "5", not "5.0".
    expect(lines[1]!.split(",")[3]).toBe("5");
    // Rank — integer.
    expect(lines[1]!.split(",")[5]).toBe("1");
    // Present_In_All — capitalized.
    expect(lines[1]!.endsWith(",True")).toBe(true);
  });

  it("ends every row including the last with a single newline", () => {
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([["R0", new Map([["ATG", 1]])]]),
      stats: new Map([["R0", mkStats(1)]]),
    })!;
    expect(out.csv.endsWith("\n")).toBe(true);
    expect(out.csv.endsWith("\n\n")).toBe(false);
  });

  it("matches pandas float repr for a handful of tricky values", () => {
    // serializeCsv goes through pyFloatStr — exercise it via a manual row.
    const csv = serializeCsv(
      [{ Peptide_Seq: "M", Dominant_DNA_Seq: "ATG", GC_Percent: 33.33333333333333, Present_In_All: false }],
      [
        { name: "Peptide_Seq", type: "string" },
        { name: "Dominant_DNA_Seq", type: "string" },
        { name: "GC_Percent", type: "float" },
        { name: "Present_In_All", type: "bool" },
      ],
    );
    expect(csv).toContain("33.33333333333333");
  });
});
