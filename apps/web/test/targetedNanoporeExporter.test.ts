import { describe, expect, it } from "vitest";
import { TARGETED_EXPORT_FILES, buildFilterFunnelCsv, buildLockedConfig, buildRunStats, buildSiteCallabilityCsv, buildTargetedQcReport, parseLockedConfig } from "../src/adapters/TargetedNanoporeExporter";
import type { TargetedNanoporeOutcome } from "../src/worker/types";
import { buildTargetedSankeyData } from "../src/tools/nanopore-targeted/viz";
import { useTargetedNanoporeStore } from "../src/state/useTargetedNanoporeStore";

const emptyDrops = { low_read_q: 1, partial_reference: 2, low_alignment_identity: 3, low_protected_identity: 4, protected_indel: 5, alignment_failed: 6, duplicate_read_id: 7, concatemer_or_chimera: 8, malformed_fastq: 14 };
const outcome = {
  roundNames: ["Round 0", "Round 1"], siteNames: ["A1"], targets: [{ name: "A1", ntStart: 1, wtDna: "GCT", wtAa: "A" }], wtBySite: { A1: "GCT" },
  statsByRound: Object.fromEntries(["Round 0", "Round 1"].map((round) => [round, {
    total_reads: 100, duplicate_read_ids: 7, aligned: 60, full_qc_passed: 50,
    qc_failures: { low_read_q: 1, partial_reference: 2, low_alignment_identity: 3, low_protected_identity: 4, protected_indel: 5 },
    primary_drop_reasons: { ...emptyDrops }, haplotype_passed_qc: 50,
    sites: { A1: { anchor_found: 55, discard_roi_indel: 0, discard_low_q_roi: 0, discard_frameshift: 0, discard_stop_codon: 0, passed_qc: 55, wt_count: 40, callable_full: 50, callable_rescued: 5, low_quality: 2, target_indel: 3, not_covered: 4, ambiguous: 1, off_design: 2, stop_codon: 1 } },
  }])), fileStats: [], libraryMedianFitness: {}, hitCounts: [], perSiteCsvBlob: null, haplotypeCsvBlob: null, exactCodonCsvBlob: null, exactHaplotypeCsvBlob: null, perSiteRowsPreview: [], haplotypeRowsPreview: [], perSiteRowsForViz: [], exactCodonCounts: { "Round 0": { A1: { GCT: 40 } } }, exactHaplotypeCounts: { "Round 0": {} }, haplotypeStatistics: [],
} as TargetedNanoporeOutcome;

const snapshot = {
  projectName: "audit", referenceSeq: "GCT".repeat(20), cdsStart: 1, cdsEnd: 60, cdsStrand: "+" as const,
  sites: [{ id: "s", name: "site_01", ntStart: 1 }],
  rounds: [
    { id: "r0", round: 0, files: [{ id: "f0", file: new File(["x"], "input.fastq"), driveRef: null, expectedFileName: null }] },
    { id: "r1", round: 1, files: [{ id: "f1", file: null, driveRef: { id: "secret-drive-id", name: "selected.fastq.gz", sizeBytes: 123 }, expectedFileName: null }] },
  ],
  settings: { minReadQ: 10, minReferenceCoverage: .9, minAlignmentIdentity: .85, minProtectedIdentity: .95, maxProtectedIndelBases: 30, minTargetBaseQ: 15, minInputCountToScore: 10, pseudocount: 0.5 },
  reportHaplotypes: false, startedAt: null, finishedAt: null,
};

describe("targeted Nanopore result artifacts", () => {
  it("matches the NGS three-artifact download contract without losing DNA aggregates", () => {
    expect(TARGETED_EXPORT_FILES.map(([name]) => name)).toEqual(["Master_Enrichment_Matrix.csv.gz", "Combination_Enrichment_Matrix.csv.gz", "run_stats.json", "QC_Summary_Report.txt", "locked_config.json"]);
    const stats = buildRunStats(outcome, snapshot);
    expect(stats.exactCodonCounts["Round 0"]!.A1!.GCT).toBe(40);
    expect(stats).toHaveProperty("targetCallability");
    expect(stats).toHaveProperty("exactCombinationCounts");
    expect(stats.statsByRound["Round 0"]).toHaveProperty("targets.A1");
    expect(stats.statsByRound["Round 0"]).not.toHaveProperty("sites");
    expect(stats).toHaveProperty("filterFunnel");
  });
  it("round-trips locked settings while serializing filenames only", () => {
    const locked = buildLockedConfig(snapshot);
    const serialized = JSON.stringify(locked);
    expect(locked.calculationModel).toBe("rpm-pseudocount-v1");
    expect(locked.pseudocountUnit).toBe("RPM");
    expect(serialized).toContain("input.fastq");
    expect(serialized).toContain("selected.fastq.gz");
    expect(serialized).not.toContain("secret-drive-id");
    expect(serialized).not.toContain("sizeBytes");
    expect(serialized).not.toContain("startedAt");
    const imported = parseLockedConfig(serialized);
    expect(imported.settings.pseudocount).toBe(0.5);
    expect(imported.rounds.map((round) => round.expectedFileNames)).toEqual([
      ["input.fastq"],
      ["selected.fastq.gz"],
    ]);
    useTargetedNanoporeStore.getState().loadLockedConfig(imported);
    const state = useTargetedNanoporeStore.getState();
    const rebuilt = buildLockedConfig({
      projectName: state.projectName,
      referenceSeq: state.referenceSeq,
      cdsStart: state.cdsStart,
      cdsEnd: state.cdsEnd,
      cdsStrand: state.cdsStrand,
      sites: state.sites,
      rounds: state.rounds,
      settings: state.settings,
      reportHaplotypes: state.reportHaplotypes,
      startedAt: null,
      finishedAt: null,
    });
    expect(rebuilt).toEqual(locked);
  });
  it("rejects unsupported or unsafe locked configs", () => {
    const locked = buildLockedConfig(snapshot);
    expect(() => parseLockedConfig(JSON.stringify({ ...locked, schemaVersion: "v0" }))).toThrow(/schema/i);
    const withBadName = {
      ...locked,
      rounds: [{ round: 0, expectedFileNames: ["../../reads.fastq"] }, locked.rounds[1]],
    };
    expect(() => parseLockedConfig(JSON.stringify(withBadName))).toThrow(/filename|Round 0/i);
  });
  it("rejects malformed JSON and invalid locked values before state mutation", () => {
    const locked = buildLockedConfig(snapshot);
    expect(() => parseLockedConfig("{")).toThrow(/JSON/i);
    expect(() => parseLockedConfig("[]")).toThrow(/object/i);
    const invalid: Array<[string, unknown]> = [
      ["model", { ...locked, calculationModel: "counts" }],
      ["unit", { ...locked, pseudocountUnit: "count" }],
      ["project", { ...locked, project: "<script>" }],
      ["reference", { ...locked, reference: "ACGTX".repeat(20) }],
      ["CDS strand", { ...locked, cds: { ...locked.cds, strand: "?" } }],
      ["CDS frame", { ...locked, cds: { ...locked.cds, end1: 59 } }],
      ["targets", { ...locked, targets: [] }],
      ["target design", {
        ...locked,
        targets: [{ ...locked.targets[0], design: "ANY" }],
      }],
      ["round sequence", {
        ...locked,
        rounds: [{ ...locked.rounds[0], round: 1 }, locked.rounds[1]],
      }],
      ["round filename suffix", {
        ...locked,
        rounds: [{ round: 0, expectedFileNames: ["reads.txt"] }, locked.rounds[1]],
      }],
      ["read Q", {
        ...locked,
        settings: { ...locked.settings, minReadQ: 31 },
      }],
      ["zero pseudocount", {
        ...locked,
        settings: { ...locked.settings, pseudocount: 0 },
      }],
      ["report flag", {
        ...locked,
        settings: { ...locked.settings, reportHaplotypes: "yes" },
      }],
      ["enabled inapplicable combinations", {
        ...locked,
        settings: { ...locked.settings, reportHaplotypes: true },
      }],
      ["disabled required combinations", {
        ...locked,
        targets: [
          locked.targets[0],
          { ...locked.targets[0], name: "A2", ntStart: 4 },
        ],
        settings: { ...locked.settings, reportHaplotypes: false },
      }],
      ["rescue flank", {
        ...locked,
        settings: { ...locked.settings, rescueFlankBases: 29 },
      }],
      ["concatemer safeguard", {
        ...locked,
        fixedSafeguards: { concatemerLengthRatio: 2 },
      }],
    ];
    for (const [label, value] of invalid) {
      expect(() => parseLockedConfig(JSON.stringify(value)), label).toThrow();
    }
  });
  it("exports exclusive and target-specific QC without dropping reason columns", () => {
    expect(buildFilterFunnelCsv(outcome)).toContain("low_alignment_identity");
    expect(buildSiteCallabilityCsv(outcome)).toContain("Target_Indel");
    expect(buildSiteCallabilityCsv(outcome)).toContain('"55","50","5"');
  });
  it("uses the exclusive funnel counters in the Sankey without inflating read flow", () => {
    const sankey = buildTargetedSankeyData(outcome);
    expect(sankey.links.filter((link) => link.source === 0).reduce((n, link) => n + link.value, 0)).toBe(200);
    for (const roundNode of [1, 12]) {
      expect(sankey.links.filter((link) => link.source === roundNode).reduce((n, link) => n + link.value, 0)).toBe(100);
    }
  });
  it("documents substitution, indel, rescue and no-replicate semantics", () => {
    const report = buildTargetedQcReport(outcome, snapshot);
    expect(report).toContain("Substitution inside a target");
    expect(report).toContain("Insertion/deletion overlapping a target codon");
    expect(report).toContain("Partial read");
    expect(report).toContain("MULTI-TARGET COMBINATION ENRICHMENT");
    expect(report).toContain("R233W|A304V|G331D");
    expect(report).toContain("Without biological replicates");
    expect(report).toContain("four-term Poisson");
  });
});
