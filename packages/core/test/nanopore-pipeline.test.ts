// End-to-end test for runNanoporePipeline against the seeded synthetic fixture
// at 00_material/test_nanopore/. Validates the full chain:
//   FASTQ stream → engine → per-site counters + global breakdown.
//
// Ground truth lives in expected_counts.json next to the FASTQs. The fixture
// generator embeds a known bad-read recipe in every round (10 low-Q, 8
// truncated, 7 no-anchor, 4 chimera, 6 ROI-indel, 5 low-ROI-Q, 3 stop-in-ROI,
// 3 N-in-ROI, 4 rc) so we can assert each filter bucket fires the right
// number of times.

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
const FIXTURE = path.resolve(HERE, "../../../../00_material/test_nanopore");
const SMALL_REFERENCE = "AAAAACCCCCATGGGGGGTTTTT";
const SMALL_SITE: NanoporeSiteInput = {
  name: "site_1",
  fwAnchor: "AAAAACCCCC",
  rvAnchor: "GGGGGTTTTT",
};
const SMALL_QUALITY = "I".repeat(SMALL_REFERENCE.length);

function memorySource(
  name: string,
  text: string,
  chunkSize = 3,
): IFastqSource {
  return {
    describe: () => ({ id: name, name, sizeBytes: text.length }),
    async open(): Promise<ReadableStream<Uint8Array>> {
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + chunkSize, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
    },
  };
}

function smallRecord(id: string, seq = SMALL_REFERENCE, qual = SMALL_QUALITY): string {
  return `@${id}\n${seq}\n+\n${qual}\n`;
}

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
  upstream_anchor: string;
  downstream_anchor: string;
  wt_codon: string;
  bad_read_recipe: Record<string, number>;
  rounds: Record<string, {
    total_reads: number;
    good_reads: number;
    bad_reads: number;
    expected_passed_qc: number;
    codon_counts: Record<string, number>;
  }>;
}

async function loadExpected(): Promise<ExpectedCounts> {
  const raw = await readFile(path.join(FIXTURE, "expected_counts.json"), "utf8");
  return JSON.parse(raw) as ExpectedCounts;
}

describe("runNanoporePipeline — per-round mode (3-round synthetic fixture)", () => {
  it("passes the expected number of reads per round; bad-read buckets fire as designed", async () => {
    const expected = await loadExpected();

    const sites: NanoporeSiteInput[] = [
      {
        name: "site_1",
        fwAnchor: expected.upstream_anchor,
        rvAnchor: expected.downstream_anchor,
      },
    ];
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
    const sourceRoundIndices = [0, 1, 2];

    const result = await runNanoporePipeline({
      sources,
      reference: expected.reference,
      sites,
      rounds,
      sourceRoundIndices,
    });

    // --- Per-round passed_qc near the design target -----------------------
    // The fixture's `expected_passed_qc = good_reads + rc_reads`. Real engine
    // recovery is below 100 % because random 2 % flank + 1 % indel noise from
    // the fixture generator occasionally piles up inside a single 19-bp anchor
    // and exceeds the 3-edit (maxSub=2 + maxIndel=1) banded-align budget. We
    // accept ≤ 15 % loss per round, which empirically covers worst-case noise
    // distributions across the three rounds.
    for (const [roundKey, info] of Object.entries(expected.rounds)) {
      const roundName = `Round_${roundKey.replace("round", "")}`;
      const stats = result.stats.get(roundName);
      if (!stats) throw new Error(`No stats for ${roundName}`);
      const passed = stats.sites["site_1"]!.passed_qc;
      const target = info.expected_passed_qc;
      const lower = Math.floor(target * 0.85);
      expect(
        passed,
        `${roundName}: passed_qc=${passed}, expected ≈ ${target} (≥ ${lower})`,
      ).toBeGreaterThanOrEqual(lower);
      expect(passed).toBeLessThanOrEqual(target);
    }

    // --- Filter buckets fire on the designed bad reads --------------------
    // Each round seeds the same recipe; sum the per-round buckets and assert
    // each bucket contains AT LEAST the seeded count. Each bucket also
    // catches additional artifacts from realistic flank noise:
    //   - discard_roi_indel ALSO catches anchor-boundary slip when a Nanopore
    //     indel lands at the anchor edge (banded matching shifts the boundary
    //     by 1 bp; the ROI then differs from expected by 1).
    //   - discard_low_q_roi can fire on edge artifacts when Q crosses the
    //     threshold by a small margin.
    //   - low_quality_read is global and has no edge case (mean-Q is robust),
    //     so we assert exact equality there.
    const recipe = expected.bad_read_recipe;
    const lowQTotal = recipe["low_q"]! * 3; // 10 per round × 3 rounds = 30
    expect(result.globalBreakdown.low_quality_read).toBe(lowQTotal);

    const roiIndelTotal = Array.from(result.stats.values()).reduce(
      (acc, s) => acc + s.sites["site_1"]!.discard_roi_indel,
      0,
    );
    expect(roiIndelTotal).toBeGreaterThanOrEqual(recipe["roi_indel"]! * 3);

    const lowRoiQTotal = Array.from(result.stats.values()).reduce(
      (acc, s) => acc + s.sites["site_1"]!.discard_low_q_roi,
      0,
    );
    expect(lowRoiQTotal).toBeGreaterThanOrEqual(recipe["low_roi_q"]! * 3);

    const stopTotal = Array.from(result.stats.values()).reduce(
      (acc, s) => acc + s.sites["site_1"]!.discard_stop_codon,
      0,
    );
    expect(stopTotal).toBeGreaterThanOrEqual(recipe["stop_in_roi"]! * 3);

    // --- WT count matches the designed WT codon count ---------------------
    // round0 has WT codon = 5; round1 has 50; round2 has 60 (from the fixture).
    expect(result.stats.get("Round_0")!.sites["site_1"]!.wt_count).toBeGreaterThanOrEqual(4);
    expect(result.stats.get("Round_2")!.sites["site_1"]!.wt_count).toBeGreaterThanOrEqual(55);

    // --- Top-3 variant in Round_2 should be TGG (180 designed) ------------
    const r2Site1 = result.dnaCounters.get("Round_2")!.get("site_1")!;
    const top = Array.from(r2Site1.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
    expect(top[0]![0]).toBe("TGG");
    expect(top[0]![1]).toBeGreaterThanOrEqual(150); // ≥ 83 % of 180 designed
    expect(top[0]![1]).toBeLessThanOrEqual(180);
  });
});

describe("runNanoporePipeline — haplotype output", () => {
  it("does not emit haplotype counter for a single-site library", async () => {
    const expected = await loadExpected();
    const sites: NanoporeSiteInput[] = [
      {
        name: "site_1",
        fwAnchor: expected.upstream_anchor,
        rvAnchor: expected.downstream_anchor,
      },
    ];
    const result = await runNanoporePipeline({
      sources: [fileSource(path.join(FIXTURE, "nanopore_round0.fastq"))],
      reference: expected.reference,
      sites,
      rounds: [{ name: "Round_0" }],
      sourceRoundIndices: [0],
    });
    // 1 site → haplotype output should be a no-op even though the default
    // setting reportHaplotype=true.
    expect(result.haplotypeCounters.get("Round_0")!.size).toBe(0);
    expect(result.stats.get("Round_0")!.haplotype_passed_qc).toBe(0);
  });
});

describe("runNanoporePipeline — malformed and abnormal flows", () => {
  it.each([
    ["missing separator", `@bad\n${SMALL_REFERENCE}\nnot-plus\n${SMALL_QUALITY}\n`],
    ["truncated record", `@bad\n${SMALL_REFERENCE}\n+\n`],
    ["invalid base", smallRecord("bad", `${SMALL_REFERENCE.slice(0, 5)}X${SMALL_REFERENCE.slice(6)}`)],
    ["quality length mismatch", smallRecord("bad", SMALL_REFERENCE, SMALL_QUALITY.slice(1))],
    ["invalid quality byte", smallRecord("bad", SMALL_REFERENCE, `${SMALL_QUALITY.slice(1)} `)],
    ["empty read ID", `@\n${SMALL_REFERENCE}\n+\n${SMALL_QUALITY}\n`],
    ["junk before header", "not-a-header\njunk\n"],
  ])("isolates %s and recovers at the next valid record", async (_label, malformed) => {
    const logs: Array<{ text: string; tag: string }> = [];
    const result = await runNanoporePipeline({
      sources: [memorySource("damaged.fastq", malformed + smallRecord("good"))],
      reference: SMALL_REFERENCE,
      sites: [SMALL_SITE],
      rounds: [{ name: "Round_0" }],
      sourceRoundIndices: [0],
      settings: { minMeanPhredRead: 0, minMeanPhredRoi: 0 },
      onLog: (event) => logs.push(event),
    });
    expect(result.globalBreakdown.malformed_fastq).toBe(1);
    expect(result.stats.get("Round_0")!.sites.site_1.passed_qc).toBe(1);
    expect(logs.some((event) =>
      event.tag === "warning" && event.text.includes("malformed=1")
    )).toBe(true);
  });

  it("propagates source-open failures after logging the attempted source", async () => {
    const logs: string[] = [];
    const failing: IFastqSource = {
      describe: () => ({ id: "broken", name: "broken.fastq", sizeBytes: null }),
      open: async () => {
        throw new Error("simulated Drive stream failure");
      },
    };
    await expect(
      runNanoporePipeline({
        sources: [failing],
        reference: SMALL_REFERENCE,
        sites: [SMALL_SITE],
        rounds: [{ name: "Round_0" }],
        sourceRoundIndices: [0],
        onLog: (event) => logs.push(event.text),
      }),
    ).rejects.toThrow(/simulated Drive stream failure/);
    expect(logs.some((line) => line.includes("opening broken.fastq"))).toBe(true);
    expect(logs.some((line) => line.startsWith("Total runtime"))).toBe(false);
  });

  it("reports an empty stream as a warning", async () => {
    const logs: Array<{ text: string; tag: string }> = [];
    await runNanoporePipeline({
      sources: [memorySource("empty.fastq", "")],
      reference: SMALL_REFERENCE,
      sites: [SMALL_SITE],
      rounds: [{ name: "Round_0" }],
      sourceRoundIndices: [0],
      onLog: (event) => logs.push(event),
    });
    expect(logs.some((event) =>
      event.tag === "warning" && event.text.includes("EMPTY FASTQ STREAM")
    )).toBe(true);
  });

  it("stops cleanly when cancelled before streaming", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled by test"));
    await expect(
      runNanoporePipeline({
        sources: [memorySource("cancel.fastq", smallRecord("read"))],
        reference: SMALL_REFERENCE,
        sites: [SMALL_SITE],
        rounds: [{ name: "Round_0" }],
        sourceRoundIndices: [0],
        signal: abort.signal,
      }),
    ).rejects.toThrow(/cancelled by test/);
  });

  it("rejects invalid bindings and ambiguous result definitions", async () => {
    const source = memorySource("reads.fastq", smallRecord("read"));
    const base = {
      sources: [source],
      reference: SMALL_REFERENCE,
      sites: [SMALL_SITE],
      rounds: [{ name: "Round_0" }],
    };
    await expect(
      runNanoporePipeline({ ...base, sourceRoundIndices: [] }),
    ).rejects.toThrow(/exactly one round binding/i);
    await expect(
      runNanoporePipeline({ ...base, sourceRoundIndices: [1] }),
    ).rejects.toThrow(/invalid round binding/i);
    await expect(
      runNanoporePipeline({
        ...base,
        rounds: [{ name: "duplicate" }, { name: "duplicate" }],
        sourceRoundIndices: [0],
      }),
    ).rejects.toThrow(/round names must be unique/i);
    await expect(
      runNanoporePipeline({
        ...base,
        sites: [SMALL_SITE, { ...SMALL_SITE }],
        sourceRoundIndices: [0],
      }),
    ).rejects.toThrow(/site names must be unique/i);
    await expect(
      runNanoporePipeline({
        ...base,
        rounds: [{ name: "Round_0", barcode: "AAAA" }, { name: "Round_1", barcode: "AAAA" }],
      }),
    ).rejects.toThrow(/distinct barcodes/i);
  });
});
