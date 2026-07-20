import { describe, expect, it } from "vitest";
import { runTargetedNanoporePipeline, translateDna } from "@cdna/core";
import { LocalFastqSource } from "../src/adapters/LocalFastqSource";
import { AutoDecompressFastqSource } from "../src/adapters/AutoDecompressFastqSource";
import { buildNanoporeDemoRounds, NANOPORE_DEMO_REFERENCE, NANOPORE_DEMO_SITES } from "../src/tools/nanopore-targeted/demo";
import { NANOPORE_INPUT_LIMITS, peekNanoporeFastq, validateNanoporeDriveFile, validateNanoporeFileName } from "../src/tools/nanopore-targeted/inputValidation";
import { aminoAcidTargetLabel } from "../src/tools/nanopore-targeted/targetNaming";

describe("unified Nanopore input whitelist", () => {
  it.each([
    "reads.fastq", "reads.fq", "reads.fastqsanger", "reads.fastq.gz", "reads.fq.gz", "reads.fastqsanger.gz",
  ])("accepts %s", (name) => expect(validateNanoporeFileName(name, 100).ok).toBe(true));

  it.each(["reads.txt", "reads.sam", "reads.fast5", "reads.fastq.zip", "../reads.fastq", "bad\u0000.fastq"])(
    "rejects %s", (name) => expect(validateNanoporeFileName(name, 100).ok).toBe(false),
  );

  it("rejects empty/oversized names and forged Drive metadata", () => {
    expect(validateNanoporeFileName("empty.fastq", 0).ok).toBe(false);
    expect(validateNanoporeFileName(`${"a".repeat(256)}.fastq`, 10).ok).toBe(false);
    expect(validateNanoporeDriveFile({ id: "../../token", name: "reads.fastq", sizeBytes: 10 }).ok).toBe(false);
  });

  it("peeks a real .fastqsanger record", async () => {
    const file = new File(["@r qs:f:20\nACGTN\n+\nIIIII\n"], "real.fastqsanger");
    expect(await peekNanoporeFastq(file)).toEqual({ ok: true });
  });

  it("rejects malformed content even with a whitelisted suffix", async () => {
    const file = new File(["this is not FASTQ\n"], "fake.fastq");
    expect((await peekNanoporeFastq(file)).ok).toBe(false);
  });

  it("accepts a valid 50 kb first read instead of failing the bounded peek", async () => {
    const sequence = "ACGTN".repeat(10_000);
    const file = new File(
      [`@long qs:f:20\n${sequence}\n+\n${"I".repeat(sequence.length)}\n`],
      "long.fastq",
    );
    expect(await peekNanoporeFastq(file)).toEqual({ ok: true });
  });

  it("rejects truncated, invalid-base, invalid-quality and corrupt gzip inputs", async () => {
    const files = [
      new File(["@r\nACGT\n+\n"], "truncated.fastq"),
      new File(["@ \nACGT\n+\nIIII\n"], "empty-id.fastq"),
      new File(["@r\nACGX\n+\nIIII\n"], "base.fastq"),
      new File(["@r\nACGT\n+\nIII \n"], "quality.fastq"),
      new File([new Uint8Array([0x1f, 0x8b, 0x08, 0xff])], "corrupt.fastq.gz"),
    ];
    for (const file of files) {
      expect((await peekNanoporeFastq(file)).ok, file.name).toBe(false);
    }
  });

  it("round-trips a .fastqsanger.gz through streaming compression, peek, and decompression", async () => {
    const raw = "@gz qs:f:20\nACGTNACGTN\n+\nIIIIIIIIII\n";
    const compressed = await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const file = new File([compressed], "reads.fastqsanger.gz");
    expect(await peekNanoporeFastq(file)).toEqual({ ok: true });
    const source = new AutoDecompressFastqSource(new LocalFastqSource(file));
    expect(await new Response(await source.open()).text()).toBe(raw);
    expect(source.describe().sizeBytes).toBeNull();
  });

  it("keeps explicit pressure limits bounded", () => {
    expect(NANOPORE_INPUT_LIMITS.maxRounds).toBeLessThanOrEqual(32);
    expect(NANOPORE_INPUT_LIMITS.maxFilesPerRound).toBeLessThanOrEqual(128);
    expect(NANOPORE_INPUT_LIMITS.maxSites).toBeLessThanOrEqual(512);
    expect(NANOPORE_INPUT_LIMITS.maxReferenceBases).toBeLessThanOrEqual(100_000);
  });
});

describe("built-in Nanopore demo", () => {
  it("uses a continuous stop-free coding reference", () => {
    expect(NANOPORE_DEMO_REFERENCE).toHaveLength(540);
    expect(translateDna(NANOPORE_DEMO_REFERENCE)).not.toContain("*");
  });

  it("runs through the production core and recovers the designed Round-2 double enrichment", async () => {
    const rounds = buildNanoporeDemoRounds();
    const sources: LocalFastqSource[] = [];
    const sourceRoundIndices: number[] = [];
    for (const round of rounds) for (const source of round.files) {
      sources.push(new LocalFastqSource(source.file!));
      sourceRoundIndices.push(round.round);
    }
    const result = await runTargetedNanoporePipeline({
      sources, sourceRoundIndices, roundNames: rounds.map((r) => `Round ${r.round}`),
      reference: NANOPORE_DEMO_REFERENCE,
      sites: NANOPORE_DEMO_SITES.map((site) => ({ name: aminoAcidTargetLabel(NANOPORE_DEMO_REFERENCE, 1, site.ntStart).name, ntStart: site.ntStart, length: 3, design: "NNK" as const })),
      settings: { minReadQ: 10, minReferenceCoverage: 0.9, minAlignmentIdentity: 0.85, minProtectedIdentity: 0.95, maxProtectedIndelBases: 30, minTargetBaseQ: 15, minInputCountToScore: 5, pseudocount: 0.5, reportHaplotypes: true },
    });
    expect(result.stats.get("Round 0")!.primary_drop_reasons.low_read_q).toBe(1);
    expect(result.stats.get("Round 2")!.primary_drop_reasons.concatemer_or_chimera).toBe(1);
    expect(result.fileStats.filter((file) => file.round === "Round 1")).toHaveLength(2);
    for (const [roundName, round] of result.stats) {
      expect(round.full_qc_passed + Object.values(round.primary_drop_reasons).reduce((a, b) => a + b, 0)).toBe(round.total_reads);
      for (const site of NANOPORE_DEMO_SITES) {
        const name = aminoAcidTargetLabel(NANOPORE_DEMO_REFERENCE, 1, site.ntStart).name;
        const exactTotal = [...result.dnaCounters.get(roundName)!.get(name)!.values()].reduce((a, b) => a + b, 0);
        expect(exactTotal).toBe(round.sites[name]!.passed_qc);
      }
    }
    const double = result.analyzer.haplotypeRows.find((row) => row.Combination_DNA === "TGG|CTG");
    expect(double).toBeTruthy();
    expect(double!.Combination_AA).toBe("A21W|Y151L");
    expect(double!["Count_Round 2"]).toBe(100);
    expect(double!["Enrichment_Round 2_vs_Round 0"] as number).toBeGreaterThan(3);
    const referenceCombination = result.analyzer.haplotypeRows.find((row) => row.Combination_AA === "A21A|Y151Y");
    expect(referenceCombination).toBeTruthy();
    expect(Number.isFinite(referenceCombination!["Enrichment_Round 2_vs_Round 0"])).toBe(true);
    expect(referenceCombination!["Enrichment_Round 2_vs_Round 0"]).not.toBe(0);
    const exactCodons = result.exactCodonCsvParts.join("");
    const exactHaplotypes = result.exactHaplotypeCsvParts.join("");
    expect(exactCodons).toContain("Codon_DNA");
    expect(exactCodons).toContain("TGG");
    expect(exactCodons).toContain("Target,Codon_DNA");
    expect(exactHaplotypes).toContain("A21W|Y151L");
  }, 20_000);
});
