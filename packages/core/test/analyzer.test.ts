import { describe, expect, it } from "vitest";
import { runAnalyzer as runAnalyzerCore, type AnalyzerInput, serializeCsv } from "../src/analyzer.js";
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

/** Tests spell out the product default once; production AnalyzerInput keeps
 * pseudocount required so omitted wiring remains a compile error. */
function runAnalyzer(input: Omit<AnalyzerInput, "pseudocount"> & { pseudocount?: number }) {
  return runAnalyzerCore({ ...input, pseudocount: input.pseudocount ?? 0.5 });
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
    // Rank_<r> was dropped in Phase 6.12 (derivable from Count_<r>).
    // Verify the equivalent assertion against the raw counts.
    const byPeptide = new Map(out.rows.map((r) => [r.Peptide_Seq, r]));
    expect(byPeptide.get("MK")!.Count_R0).toBe(10);
    expect(byPeptide.get("MP")!.Count_R0).toBe(10);
    expect(byPeptide.get("MG")!.Count_R0).toBe(5);
  });

  it("computes RPM+p stepwise + global enrichment with pseudocount 1.0 RPM", () => {
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
      pseudocount: 1,
    })!;
    const r = out.rows[0]!;
    expect(r.RPM_R0).toBe(1000);
    expect(r.RPM_R1).toBe(100000);
    expect(r.RPM_R2).toBe(0);
    // Exact float-64 values; we want byte-identical match with Python so just
    // assert the math matches Math.log2 directly (no tolerance — they should
    // be ULP-identical to np.log2).
    expect(r["Enrich_Step_R1_vs_R0"]).toBeCloseTo(Math.log2((100000 + 1) / (1000 + 1)), 14);
    expect(r["Enrich_Step_R2_vs_R1"]).toBeCloseTo(Math.log2((0 + 1) / (100000 + 1)), 14);
    // Phase 6.16: Enrich_Global_* removed. The raw log₂ fold-change is the
    // sum of `Centered_Enrich + libraryMedian`; verify that identity instead.
    const med1 = out.libraryMedianEnrich["Enrich_Global_R1_vs_R0"]!;
    const med2 = out.libraryMedianEnrich["Enrich_Global_R2_vs_R0"]!;
    expect((r["Centered_Enrich_R1_vs_R0"] as number) + med1).toBeCloseTo(
      Math.log2((100000 + 1) / (1000 + 1)),
      14,
    );
    expect((r["Centered_Enrich_R2_vs_R0"] as number) + med2).toBeCloseTo(
      Math.log2((0 + 1) / (1000 + 1)),
      14,
    );
  });

  it("a peptide present in every round has Count_<r> > 0 in every round", () => {
    // Present_In_All was dropped in Phase 6.12 (trivially derivable).
    // The contract under test is unchanged: cross-round presence is visible
    // by inspecting the Count_<r> columns directly.
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
    expect(m.Count_R0).toBe(1);
    expect(m.Count_R1).toBe(1); // present in all
    expect(a.Count_R0).toBe(1);
    expect(a.Count_R1).toBe(0); // missing from R1
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
    // csvParts is one entry per line (each terminated with "\n"). Joining
    // reproduces the single-string output for inspection.
    const csv = out.csvParts.join("");
    const lines = csv.trim().split("\n");
    // Phase 6.12 schema: Rank_*, GC_Percent, Present_In_All all dropped.
    // Single-round runs have no Enrich_*/stats columns (those start at i=1).
    expect(lines[0]).toBe("Peptide_Seq,Dominant_DNA_Seq,Count_R0,RPM_R0");
    // RPM = 5/1000 * 1e6 = 5000.0 — must appear as "5000.0" not "5000".
    expect(lines[1]).toContain(",5000.0");
    // Count = 5 — must appear as "5", not "5.0".
    expect(lines[1]!.split(",")[2]).toBe("5");
  });

  it("ends every row including the last with a single newline", () => {
    const out = runAnalyzer({
      roundNames: ["R0"],
      dnaCounters: new Map([["R0", new Map([["ATG", 1]])]]),
      stats: new Map([["R0", mkStats(1)]]),
    })!;
    // Every part is "\n"-terminated, so the joined string ends with exactly
    // one trailing newline and never with a doubled "\n\n".
    expect(out.csvParts.every((p) => p.endsWith("\n"))).toBe(true);
    const joined = out.csvParts.join("");
    expect(joined.endsWith("\n")).toBe(true);
    expect(joined.endsWith("\n\n")).toBe(false);
  });

  it("matches pandas float repr for a handful of tricky values", () => {
    // serializeCsv goes through pyFloatStr — exercise it via a manual row.
    const parts = serializeCsv(
      [{ Peptide_Seq: "M", Dominant_DNA_Seq: "ATG", GC_Percent: 33.33333333333333 }],
      [
        { name: "Peptide_Seq", type: "string" },
        { name: "Dominant_DNA_Seq", type: "string" },
        { name: "GC_Percent", type: "float" },
      ],
    );
    expect(parts.join("")).toContain("33.33333333333333");
  });
});

describe("runAnalyzer — Phase 6.12 + 6.16 column set", () => {
  it("emits Centered_Enrich, Z, Pval, FDR_q, Var_Enrich for non-first rounds", () => {
    // Two-round setup: one variant with the same RPM in both rounds (neutral),
    // one with 10x growth (strong enricher). Library size = 2 → median centering
    // is trivially defined; the centered values should bracket zero.
    const out = runAnalyzer({
      roundNames: ["R0", "R1"],
      dnaCounters: new Map([
        ["R0", new Map([
          ["AAA", 100],
          ["CCC", 100],
        ])],
        ["R1", new Map([
          ["AAA", 100],  // neutral
          ["CCC", 1000], // 10x
        ])],
      ]),
      stats: new Map([
        ["R0", mkStats(10_000)],
        ["R1", mkStats(10_000)],
      ]),
    })!;
    const csv = out.csvParts.join("");
    const header = csv.split("\n")[0]!;
    // Phase 6.12 removals: Rank / GC_Percent / Present_In_All.
    expect(header).not.toContain("Rank_");
    expect(header).not.toContain("GC_Percent");
    expect(header).not.toContain("Present_In_All");
    // Phase 6.16 removals: Enrich_Global / NegLog10Pval.
    expect(header).not.toContain("Enrich_Global_");
    expect(header).not.toContain("NegLog10Pval_");
    // Kept + new columns.
    expect(header).toContain("Centered_Enrich_R1_vs_R0");
    expect(header).toContain("Z_Enrich_R1_vs_R0");
    expect(header).toContain("Pval_Enrich_R1_vs_R0");
    expect(header).toContain("FDR_q_R1_vs_R0");
    expect(header).toContain("Var_Enrich_R1_vs_R0");

    // The strong enricher row should have a much larger Z than the neutral row.
    const enricher = out.rows.find((r) => r.Peptide_Seq === "P");  // CCC = Pro
    const neutral = out.rows.find((r) => r.Peptide_Seq === "K");   // AAA = Lys
    expect(enricher).toBeTruthy();
    expect(neutral).toBeTruthy();
    expect(Math.abs(enricher!["Z_Enrich_R1_vs_R0"] as number)).toBeGreaterThan(
      Math.abs(neutral!["Z_Enrich_R1_vs_R0"] as number),
    );
    // Enrich2 variance includes both variant counts and library totals after
    // converting 0.5 RPM to its count-scale equivalent for this library.
    const q = 0.5 * 10_000 / 1e6;
    const expectedVar = (1 / Math.LN2) ** 2 *
      (1 / (100 + q) + 1 / (10_000 + q) + 1 / (100 + q) + 1 / (10_000 + q));
    expect(neutral!["Var_Enrich_R1_vs_R0"] as number).toBeCloseTo(expectedVar, 10);
    // Library median diagnostic key is kept as "Enrich_Global_*" (describes
    // the underlying log₂ fold-change quantity even though we no longer emit
    // it as a column).
    const med = out.libraryMedianEnrich["Enrich_Global_R1_vs_R0"]!;
    expect(med).toBeGreaterThan(0);
    expect(med).toBeLessThan(Math.log2(10));
  });

  it("FDR_q for round with one strong + many neutral signals stays low for the strong", () => {
    // 1 enricher (10x) + 30 neutral variants, each with a distinct 6-bp DNA
    // so the AA-collapsed analyzer sees 31 distinct peptide entries.
    const r0 = new Map<string, number>();
    const r1 = new Map<string, number>();
    // Strong enricher: "ATGAAA" = Met-Lys (MK), 10x R1 vs R0.
    r0.set("ATGAAA", 200);
    r1.set("ATGAAA", 2000);
    // Generate 30 unique DNAs (CCC + 3-base variations) — 64 possible, take 30.
    // CCC = Proline, so the second codon varies and yields different peptides.
    const BASES = ["A", "C", "G", "T"];
    let added = 0;
    outer: for (const b1 of BASES) {
      for (const b2 of BASES) {
        for (const b3 of BASES) {
          if (added >= 30) break outer;
          const dna = "CCC" + b1 + b2 + b3;
          r0.set(dna, 200);
          r1.set(dna, 200);
          added++;
        }
      }
    }
    const out = runAnalyzer({
      roundNames: ["R0", "R1"],
      dnaCounters: new Map([
        ["R0", r0],
        ["R1", r1],
      ]),
      stats: new Map([
        ["R0", mkStats(100_000)],
        ["R1", mkStats(100_000)],
      ]),
    })!;
    const enricher = out.rows.find((r) => r.Peptide_Seq === "MK"); // ATG + AAA
    expect(enricher).toBeTruthy();
    const q = enricher!["FDR_q_R1_vs_R0"] as number;
    // Enricher Z ≈ log2(10) / SE  where SE ≈ 0.11 → Z ≈ 30, p ≈ 0.
    // Even after BH with m ~ many variants, q should be far below 0.05.
    expect(q).toBeLessThan(0.05);
    // And the neutrals should have q close to 1 (no signal).
    const neutral = out.rows.find((r) => r.Peptide_Seq && r.Peptide_Seq !== "MK")!;
    const qNeutral = neutral["FDR_q_R1_vs_R0"] as number;
    expect(qNeutral).toBeGreaterThan(0.5);
  });
});
