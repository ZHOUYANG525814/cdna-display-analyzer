import { describe, expect, it } from "vitest";
import {
  cdnaZeroCoverage,
  findDuplicateFastqGroups,
  nanoporeZeroCoverage,
  targetedZeroCoverage,
  zeroCoverageMessage,
} from "../src/lib/runGuards";
import type {
  NanoporeOutcome,
  PipelineOutcome,
  TargetedNanoporeOutcome,
} from "../src/worker/types";

describe("web run guards", () => {
  it("blocks duplicate local content across distinct File objects and names", async () => {
    const content = "@r\nACGT\n+\nIIII\n";
    const groups = await findDuplicateFastqGroups(
      [
        { file: new File([content], "round0.fastq"), label: "Round 0" },
        { file: new File([content], "renamed.fastq"), label: "Round 1" },
      ],
      [],
    );
    expect(groups).toEqual([["Round 0", "Round 1"]]);
  });

  it("allows same-name shards with different content and blocks repeated Drive IDs", async () => {
    const groups = await findDuplicateFastqGroups(
      [
        { file: new File(["@a\nA\n+\nI\n"], "reads.fastq"), label: "local A" },
        { file: new File(["@b\nC\n+\nI\n"], "reads.fastq"), label: "local B" },
      ],
      [
        { file: { id: "same-id", name: "a.fastq", sizeBytes: 10 }, label: "Drive A" },
        { file: { id: "same-id", name: "b.fastq", sizeBytes: 10 }, label: "Drive B" },
      ],
    );
    expect(groups).toEqual([["Drive A", "Drive B"]]);
  });

  it("identifies every zero denominator required by each web result", () => {
    const cdna = {
      roundNames: ["Round_0", "Round_1"],
      statsByRound: {
        Round_0: { passed_qc: 10 },
        Round_1: { passed_qc: 0 },
      },
    } as unknown as PipelineOutcome;
    expect(cdnaZeroCoverage(cdna)).toEqual(["Round_1"]);

    const nanopore = {
      roundNames: ["Round_0"],
      siteNames: ["A1", "A2"],
      statsByRound: {
        Round_0: {
          sites: { A1: { passed_qc: 1 }, A2: { passed_qc: 0 } },
          haplotype_passed_qc: 0,
        },
      },
    } as unknown as NanoporeOutcome;
    expect(nanoporeZeroCoverage(nanopore, true)).toEqual([
      "Round_0 / A2",
      "Round_0 / linked combinations",
    ]);
    expect(nanoporeZeroCoverage(nanopore, false)).toEqual(["Round_0 / A2"]);

    const targeted = {
      roundNames: ["Round 0"],
      siteNames: ["A1"],
      statsByRound: {
        "Round 0": { sites: { A1: { passed_qc: 0 } } },
      },
    } as unknown as TargetedNanoporeOutcome;
    const issues = targetedZeroCoverage(targeted, false);
    expect(issues).toEqual(["Round 0 / A1"]);
    expect(zeroCoverageMessage(issues)).toMatch(/rejected.*denominator is zero/i);
  });
});
