// End-to-end test for the 2-site Nanopore SSM scenario. Validates the
// haplotype path of the engine against a seeded synthetic fixture at
// 00_material/test_nanopore_2site/. The fixture mimics a K417 + E484
// double-saturation library: two sites 400 bp apart, with Round_2 designed
// to show epistasis (double-mutant TGG_CTG vastly out-enriches what
// marginal site frequencies would predict).

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastqSourceDescriptor, IFastqSource } from "@cdna/types";
import {
  runNanoporePipeline,
  type NanoporeSiteInput,
  type NanoporeRoundInput,
} from "../src/nanopore-pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../../../../00_material/test_nanopore_2site");

function fileSource(filePath: string): IFastqSource {
  return {
    describe(): FastqSourceDescriptor {
      return { id: filePath, name: path.basename(filePath), sizeBytes: null };
    },
    async open(): Promise<ReadableStream<Uint8Array>> {
      const nodeStream = createReadStream(filePath);
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
  };
}

interface ExpectedCounts {
  reference: string;
  expected_amplicon_len: number;
  sites: { name: string; fw_anchor: string; rv_anchor: string; wt_codon: string }[];
  bad_read_recipe: Record<string, number>;
  rounds: Record<string, {
    total_reads: number;
    good_reads: number;
    bad_reads: number;
    expected_passed_qc_per_site: number;
    site_1_codon_counts: Record<string, number>;
    site_2_codon_counts: Record<string, number>;
    haplotype_counts: Record<string, number>;
  }>;
}

describe("runNanoporePipeline — 2-site per-round mode (560 bp amplicon)", () => {
  it("recovers per-site counts AND linked haplotypes from a long-read SSM library", async () => {
    const raw = await readFile(path.join(FIXTURE, "expected_counts.json"), "utf8");
    const expected = JSON.parse(raw) as ExpectedCounts;

    const sites: NanoporeSiteInput[] = expected.sites.map((s) => ({
      name: s.name,
      fwAnchor: s.fw_anchor,
      rvAnchor: s.rv_anchor,
    }));
    const rounds: NanoporeRoundInput[] = [
      { name: "Round_0" },
      { name: "Round_1" },
      { name: "Round_2" },
    ];
    const sources = [
      fileSource(path.join(FIXTURE, "nanopore_round0.fastq")),
      fileSource(path.join(FIXTURE, "nanopore_round1.fastq")),
      fileSource(path.join(FIXTURE, "nanopore_round2.fastq")),
    ];

    const result = await runNanoporePipeline({
      sources,
      reference: expected.reference,
      sites,
      rounds,
      sourceRoundIndices: [0, 1, 2],
    });

    // --- Per-site passed_qc ≥ 80 % of design for BOTH sites ---------------
    // Longer reads + a second anchor pair compound the anchor-boundary
    // slip risk, so we relax slightly vs the 85 % bar from the 1-site test.
    for (const [roundKey, info] of Object.entries(expected.rounds)) {
      const roundName = `Round_${roundKey.replace("round", "")}`;
      const stats = result.stats.get(roundName);
      if (!stats) throw new Error(`No stats for ${roundName}`);
      const target = info.expected_passed_qc_per_site;
      const lower = Math.floor(target * 0.80);
      for (const siteName of ["site_1", "site_2"]) {
        const passed = stats.sites[siteName]!.passed_qc;
        expect(
          passed,
          `${roundName} / ${siteName}: passed_qc=${passed}, expected ≈ ${target} (≥ ${lower})`,
        ).toBeGreaterThanOrEqual(lower);
        expect(passed).toBeLessThanOrEqual(target);
      }
    }

    // --- Haplotype counter is populated for every round -------------------
    for (const roundName of ["Round_0", "Round_1", "Round_2"]) {
      const hap = result.haplotypeCounters.get(roundName)!;
      expect(
        hap.size,
        `${roundName} haplotype counter should have entries`,
      ).toBeGreaterThan(0);
    }

    // --- Round_2 top haplotype is TGG_CTG (the epistasis target) ----------
    const r2Hap = Array.from(result.haplotypeCounters.get("Round_2")!.entries())
      .sort((a, b) => b[1] - a[1]);
    expect(r2Hap[0]![0]).toBe("TGG_CTG");
    // Designed 220; accept ≥ 80 % under banded-anchor slip.
    expect(r2Hap[0]![1]).toBeGreaterThanOrEqual(Math.floor(220 * 0.8));

    // --- haplotype_passed_qc < per-site passed_qc (partial-success cases) -
    // The fixture seeds "site2_missing" + "stop_in_roi1" + "roi1_indel"
    // bad reads where one site succeeds but the other doesn't; the engine
    // should record those at the site level but NOT in the haplotype counter.
    for (const roundName of ["Round_0", "Round_1", "Round_2"]) {
      const stats = result.stats.get(roundName)!;
      expect(stats.haplotype_passed_qc).toBeLessThanOrEqual(
        Math.min(stats.sites["site_1"]!.passed_qc, stats.sites["site_2"]!.passed_qc),
      );
    }

    // --- Analyzer emits both CSVs and haplotype rows show epistasis -------
    // CSVs are now emitted as string[] parts (one entry per line) to avoid
    // the V8 ~537 MB single-string ceiling on multi-GB runs.
    expect(result.analyzer.perSiteCsvParts.length).toBeGreaterThan(1); // header + ≥1 row
    expect(result.analyzer.haplotypeCsvParts.length).toBeGreaterThan(1);
    expect(result.analyzer.haplotypeRows.length).toBeGreaterThan(0);
    // The designed double mutant must retain the largest observed Round_2
    // count. RPM+p enrichment can legitimately rank a newly observed
    // zero-baseline haplotype above it, so abundance—not row 0—is the stable
    // fixture contract.
    const doubleMut = result.analyzer.haplotypeRows.find((row) => row.Haplotype_AA === "W_L")!;
    const maxRound2Count = Math.max(
      ...result.analyzer.haplotypeRows.map((row) => row.Count_Round_2 as number),
    );
    expect(doubleMut.Count_Round_2).toBe(maxRound2Count);
  });
});
