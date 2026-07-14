import { describe, expect, it } from "vitest";
import { buildFilterFunnelCsv, buildSiteCallabilityCsv, buildTargetedQcReport } from "../src/adapters/TargetedNanoporeExporter";
import type { TargetedNanoporeOutcome } from "../src/worker/types";

const emptyDrops = { low_read_q: 1, partial_reference: 2, low_alignment_identity: 3, low_protected_identity: 4, protected_indel: 5, alignment_failed: 6, duplicate_read_id: 7, concatemer_or_chimera: 8, malformed_fastq: 9 };
const outcome = {
  roundNames: ["Round 0", "Round 1"], siteNames: ["site_01"], wtBySite: { site_01: "GCT" },
  statsByRound: Object.fromEntries(["Round 0", "Round 1"].map((round) => [round, {
    total_reads: 100, duplicate_read_ids: 7, aligned: 60, full_qc_passed: 50,
    qc_failures: { low_read_q: 1, partial_reference: 2, low_alignment_identity: 3, low_protected_identity: 4, protected_indel: 5 },
    primary_drop_reasons: { ...emptyDrops }, haplotype_passed_qc: 50,
    sites: { site_01: { anchor_found: 55, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 55, wt_count: 40, callable_full: 50, callable_rescued: 5, low_quality: 2, target_indel: 3, not_covered: 4, ambiguous: 1, off_design: 2, stop_codon: 1 } },
  }])), fileStats: [], libraryMedianFitness: {}, hitCounts: [], perSiteCsvBlob: null, haplotypeCsvBlob: null, exactCodonCsvBlob: null, exactHaplotypeCsvBlob: null, perSiteRowsPreview: [], haplotypeRowsPreview: [],
} as TargetedNanoporeOutcome;

const snapshot = { projectName: "audit", referenceSeq: "GCT".repeat(20), cdsStart: 1, cdsEnd: 60, cdsStrand: "+" as const, sites: [{ id: "s", name: "site_01", ntStart: 1 }], settings: { minReadQ: 10, minReferenceCoverage: .9, minAlignmentIdentity: .85, minProtectedIdentity: .95, maxProtectedIndelBases: 30, minTargetBaseQ: 15, minInputCountToScore: 10 }, reportHaplotypes: false, startedAt: null, finishedAt: null };

describe("targeted Nanopore result artifacts", () => {
  it("exports exclusive and site-specific QC without dropping reason columns", () => {
    expect(buildFilterFunnelCsv(outcome)).toContain("low_alignment_identity");
    expect(buildSiteCallabilityCsv(outcome)).toContain("Target_Indel");
    expect(buildSiteCallabilityCsv(outcome)).toContain('"55","50","5"');
  });
  it("documents substitution, indel, rescue and no-replicate semantics", () => {
    const report = buildTargetedQcReport(outcome, snapshot);
    expect(report).toContain("Substitution inside a target");
    expect(report).toContain("Insertion/deletion overlapping a target codon");
    expect(report).toContain("Partial read");
    expect(report).toContain("Without biological replicates");
    expect(report).toContain("four-term Poisson");
  });
});
