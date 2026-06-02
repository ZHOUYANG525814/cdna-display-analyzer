// NanoporeAnalyzer unit tests. Hand-computes the expected RPM, Enrich_Global,
// and Fitness_vs_WT values for small fixtures and asserts the analyzer
// reproduces them to 1e-9. Also exercises CSV column ordering, sort order,
// single-site (no haplotype) emission, and the haplotype path.

import { describe, expect, it } from "vitest";
import { runNanoporeAnalyzer } from "../src/nanopore-analyzer.js";
import type { NanoporeRoundStats } from "../src/nanopore.js";

const PSEUDO = 1.0;

function makeStats(siteName: string, passedQc: number, hapPassed = 0): NanoporeRoundStats {
  return {
    sites: {
      [siteName]: {
        anchor_found: passedQc,
        discard_roi_indel: 0,
        discard_low_q_roi: 0,
        discard_frameshift: 0,
        discard_stop_codon: 0,
        passed_qc: passedQc,
        wt_count: 0,
      },
    },
    haplotype_passed_qc: hapPassed,
  };
}

describe("runNanoporeAnalyzer — single site, single round", () => {
  it("emits one row per AA with rank, RPM, and zero enrichment vs self", () => {
    const out = runNanoporeAnalyzer({
      roundNames: ["R0"],
      siteNames: ["site_1"],
      sites: [{ name: "site_1", wtDna: "GCT" }],
      dnaCounters: new Map([
        ["R0", new Map([
          ["site_1", new Map([
            ["GCT", 50], // Ala (WT)
            ["TGG", 30], // Trp
            ["TTT", 10], // Phe
          ])],
        ])],
      ]),
      haplotypeCounters: new Map(),
      stats: new Map([["R0", makeStats("site_1", 100)]]),
      emitHaplotype: false,
    });

    expect(out.perSiteRows.length).toBe(3);
    // Top by Fitness_vs_WT_R0 (= 0 for all since only round 0), tie-break AA asc.
    expect(out.perSiteRows[0]!.Variant_AA).toBe("A");
    expect(out.perSiteRows[1]!.Variant_AA).toBe("F");
    expect(out.perSiteRows[2]!.Variant_AA).toBe("W");

    // RPM = count / passed_qc * 1e6
    const ala = out.perSiteRows.find((r) => r.Variant_AA === "A")!;
    expect(ala.Count_R0).toBe(50);
    expect(ala.RPM_R0).toBeCloseTo(500_000, 9);
    // Rank_<r> dropped in Phase 6.12 (derivable). Verify the abundance ordering
    // via raw counts: Ala (50) > Trp (30) > Phe (10).
    const phe = out.perSiteRows.find((r) => r.Variant_AA === "F")!;
    const trp = out.perSiteRows.find((r) => r.Variant_AA === "W")!;
    expect(ala.Count_R0).toBeGreaterThan(trp.Count_R0 as number);
    expect(trp.Count_R0).toBeGreaterThan(phe.Count_R0 as number);
    // Enrich_Global column removed in Phase 6.16. Fitness_vs_WT for the WT
    // row itself = log2(1) = 0 by construction (it's its own reference).
    expect(ala.Fitness_vs_WT_R0).toBeCloseTo(0, 9);
    expect(ala.Dominant_DNA).toBe("GCT");
  });

  it("emits no haplotype rows for a single-site library even when emitHaplotype=true", () => {
    const out = runNanoporeAnalyzer({
      roundNames: ["R0"],
      siteNames: ["site_1"],
      sites: [{ name: "site_1", wtDna: "GCT" }],
      dnaCounters: new Map([["R0", new Map([["site_1", new Map([["GCT", 10]])]])]]),
      haplotypeCounters: new Map(),
      stats: new Map([["R0", makeStats("site_1", 10)]]),
      emitHaplotype: true,
    });
    expect(out.haplotypeRows.length).toBe(0);
    expect(out.haplotypeCsvParts).toEqual([]);
  });
});

describe("runNanoporeAnalyzer — two rounds, single site (enrichment math)", () => {
  it("Fitness_vs_WT matches the hand-computed log2((c_i+1)/(wt_i+1) / (c_0+1)/(wt_0+1))", () => {
    // Setup: 100 reads per round.
    // R0: WT=50, TGG=10 → variant frequency 10/100, WT freq 50/100 → ratio 0.2
    // R1: WT=20, TGG=60 → variant frequency 60/100, WT freq 20/100 → ratio 3
    // Fitness_vs_WT(R1) = log2(3 / 0.2) ≈ log2(15) ≈ 3.906... (without pseudocount)
    // With pseudocount 1: log2(((60+1)/(20+1)) / ((10+1)/(50+1)))
    //                   = log2((61/21) / (11/51)) ≈ log2(13.46) ≈ 3.751
    const out = runNanoporeAnalyzer({
      roundNames: ["R0", "R1"],
      siteNames: ["site_1"],
      sites: [{ name: "site_1", wtDna: "GCT" }],
      dnaCounters: new Map([
        ["R0", new Map([["site_1", new Map([["GCT", 50], ["TGG", 10]])]])],
        ["R1", new Map([["site_1", new Map([["GCT", 20], ["TGG", 60]])]])],
      ]),
      haplotypeCounters: new Map(),
      stats: new Map([
        ["R0", makeStats("site_1", 100)],
        ["R1", makeStats("site_1", 100)],
      ]),
      emitHaplotype: false,
    });

    const tgg = out.perSiteRows.find((r) => r.Variant_AA === "W")!;
    const expectedFitness = Math.log2(((60 + PSEUDO) / (20 + PSEUDO)) / ((10 + PSEUDO) / (50 + PSEUDO)));
    expect(tgg.Fitness_vs_WT_R1).toBeCloseTo(expectedFitness, 9);

    // Sort: TGG (W, higher fitness) should be rank 0 in the output rows.
    expect(out.perSiteRows[0]!.Variant_AA).toBe("W");
    expect(out.perSiteRows[1]!.Variant_AA).toBe("A"); // WT, fitness=0

    // WT row has fitness 0 in both rounds (it's its own reference).
    const wt = out.perSiteRows.find((r) => r.Variant_AA === "A")!;
    expect(wt.Fitness_vs_WT_R0).toBeCloseTo(0, 9);
    expect(wt.Fitness_vs_WT_R1).toBeCloseTo(0, 9);

    // Phase 6.16: Enrich_Global column removed; sanity is now on Var_Fitness.
    // Var_Fitness = (1/ln 2)² × [1/(c_v_r+1) + 1/(wt_r+1) + 1/(c_v_0+1) + 1/(wt_0+1)]
    // For TGG: counts (60, 20, 10, 50) → σ² = (1/ln2)² × (1/61 + 1/21 + 1/11 + 1/51).
    const INV_LN2 = 1 / Math.LN2;
    const expectedVar =
      INV_LN2 * INV_LN2 * (1 / 61 + 1 / 21 + 1 / 11 + 1 / 51);
    expect(tgg.Var_Fitness_R1).toBeCloseTo(expectedVar, 10);

    // Rank_<r> dropped in Phase 6.12. Verify the abundance ordering via Count
    // directly: TGG=60 > GCT=20 at R1.
    expect(tgg.Count_R1).toBeGreaterThan(wt.Count_R1 as number);
  });
});

describe("runNanoporeAnalyzer — multi-site rows are grouped by site", () => {
  it("emits independent per-site rows for each configured site", () => {
    const out = runNanoporeAnalyzer({
      roundNames: ["R0"],
      siteNames: ["site_1", "site_2"],
      sites: [
        { name: "site_1", wtDna: "GCT" },
        { name: "site_2", wtDna: "TAC" },
      ],
      dnaCounters: new Map([
        ["R0", new Map([
          ["site_1", new Map([["GCT", 30], ["TGG", 10]])],
          ["site_2", new Map([["TAC", 20], ["CTG", 5]])],
        ])],
      ]),
      haplotypeCounters: new Map(),
      stats: new Map([
        ["R0", {
          sites: {
            site_1: { anchor_found: 40, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 40, wt_count: 30 },
            site_2: { anchor_found: 25, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 25, wt_count: 20 },
          },
          haplotype_passed_qc: 0,
        }],
      ]),
      emitHaplotype: false,
    });

    const site1Rows = out.perSiteRows.filter((r) => r.Site === "site_1");
    const site2Rows = out.perSiteRows.filter((r) => r.Site === "site_2");
    expect(site1Rows.length).toBe(2);
    expect(site2Rows.length).toBe(2);

    // Site 1 RPM denominator is 40; site 2 is 25.
    const gct = site1Rows.find((r) => r.Variant_AA === "A")!;
    expect(gct.RPM_R0).toBeCloseTo((30 / 40) * 1e6, 6);

    const tac = site2Rows.find((r) => r.Variant_AA === "Y")!;
    expect(tac.RPM_R0).toBeCloseTo((20 / 25) * 1e6, 6);
  });
});

describe("runNanoporeAnalyzer — haplotype output", () => {
  it("emits haplotype rows for a 2-site library when emitHaplotype=true", () => {
    const out = runNanoporeAnalyzer({
      roundNames: ["R0", "R1"],
      siteNames: ["site_1", "site_2"],
      sites: [
        { name: "site_1", wtDna: "GCT" },
        { name: "site_2", wtDna: "TAC" },
      ],
      dnaCounters: new Map([
        ["R0", new Map([
          ["site_1", new Map([["GCT", 50], ["TGG", 10]])],
          ["site_2", new Map([["TAC", 50], ["CTG", 10]])],
        ])],
        ["R1", new Map([
          ["site_1", new Map([["GCT", 20], ["TGG", 50]])],
          ["site_2", new Map([["TAC", 20], ["CTG", 50]])],
        ])],
      ]),
      haplotypeCounters: new Map([
        ["R0", new Map([
          ["GCT_TAC", 40], // WT_WT
          ["TGG_CTG", 5],  // double mutant
          ["GCT_CTG", 5],  // site_2 mutant only
        ])],
        ["R1", new Map([
          ["GCT_TAC", 10],
          ["TGG_CTG", 40], // double mutant enriched
          ["GCT_CTG", 5],
        ])],
      ]),
      stats: new Map([
        ["R0", { sites: {
          site_1: { anchor_found: 60, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 60, wt_count: 50 },
          site_2: { anchor_found: 60, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 60, wt_count: 50 },
        }, haplotype_passed_qc: 50 }],
        ["R1", { sites: {
          site_1: { anchor_found: 70, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 70, wt_count: 20 },
          site_2: { anchor_found: 70, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 70, wt_count: 20 },
        }, haplotype_passed_qc: 55 }],
      ]),
      emitHaplotype: true,
    });

    expect(out.haplotypeRows.length).toBe(3);

    // Top haplotype should be W_L (double mutant, biggest fitness).
    expect(out.haplotypeRows[0]!.Haplotype_AA).toBe("W_L");
    const doubleMut = out.haplotypeRows[0]!;
    // Expected Fitness_vs_WT_R1 for W_L:
    //   c=40, wt=10 in R1; c=5, wt=40 in R0.
    //   log2(((40+1)/(10+1)) / ((5+1)/(40+1)))
    const expectedFitness = Math.log2(((40 + PSEUDO) / (10 + PSEUDO)) / ((5 + PSEUDO) / (40 + PSEUDO)));
    expect(doubleMut.Fitness_vs_WT_R1).toBeCloseTo(expectedFitness, 9);

    // WT_WT row has fitness 0 vs itself.
    const wt = out.haplotypeRows.find((r) => r.Haplotype_AA === "A_Y")!;
    expect(wt.Fitness_vs_WT_R0).toBeCloseTo(0, 9);
    expect(wt.Fitness_vs_WT_R1).toBeCloseTo(0, 9);
  });
});

describe("runNanoporeAnalyzer — CSV serialization", () => {
  it("produces a parseable CSV with the expected header row", () => {
    const out = runNanoporeAnalyzer({
      roundNames: ["R0", "R1"],
      siteNames: ["site_1"],
      sites: [{ name: "site_1", wtDna: "GCT" }],
      dnaCounters: new Map([
        ["R0", new Map([["site_1", new Map([["GCT", 10], ["TGG", 5]])]])],
        ["R1", new Map([["site_1", new Map([["GCT", 5], ["TGG", 10]])]])],
      ]),
      haplotypeCounters: new Map(),
      stats: new Map([
        ["R0", makeStats("site_1", 15)],
        ["R1", makeStats("site_1", 15)],
      ]),
      emitHaplotype: false,
    });

    // perSiteCsvParts: one "\n"-terminated string per line (header + 2 rows).
    expect(out.perSiteCsvParts.length).toBe(3);
    // Phase 6.12: Rank_* / GC_Percent dropped.
    // Phase 6.16: Enrich_Global_* / NegLog10Pval_Fitness_* dropped, Var_Fitness
    //             added — same net column count as before.
    expect(out.perSiteCsvParts[0]!).toBe(
      "Site,Variant_AA,Dominant_DNA,Count_R0,Count_R1,RPM_R0,RPM_R1,Fitness_vs_WT_R0,Fitness_vs_WT_R1,Centered_Fitness_R1,Z_Fitness_R1,Pval_Fitness_R1,FDR_q_R1,Var_Fitness_R1\n",
    );
    // Joined view: 2 data rows + 1 header row + trailing newline.
    const joined = out.perSiteCsvParts.join("");
    const lines = joined.split("\n");
    expect(lines.length).toBe(4);
    expect(lines[lines.length - 1]).toBe("");
  });
});
