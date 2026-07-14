import { describe, expect, it } from "vitest";
import { targetedDesignErrors, targetedInputErrors, targetedSourceErrors } from "../src/state/useTargetedNanoporeStore";

describe("targeted Nanopore web contract", () => {
  it("requires consecutive rounds and at least one file per round", () => {
    const errors = targetedSourceErrors({
      projectName: "MTG",
      rounds: [
        { id: "a", round: 0, files: [] },
        { id: "b", round: 1, files: [] },
      ],
    });
    expect(errors).toEqual(["Every round needs at least one FASTQ file."]);
  });

  it("uses the shared core to validate 1-based, non-overlapping sites", () => {
    expect(targetedDesignErrors({
      referenceSeq: "ACGTCAGCTAAATGGCCGTA",
      sites: [
        { id: "a", name: "site_01", ntStart: 7 },
        { id: "b", name: "site_02", ntStart: 8 },
      ],
    })[0]).toMatch(/overlap/i);
  });

  it("allows distinct same-name shards but rejects the exact same File object twice", () => {
    const a = new File(["x"], "reads.fastq");
    const b = new File(["y"], "reads.fastq");
    const base = {
      projectName: "stress", referenceSeq: "ACG".repeat(10), cdsStart: 1, cdsEnd: 30,
      sites: [{ id: "s", name: "site_01", ntStart: 1 }],
    };
    const distinct = targetedInputErrors({ ...base, rounds: [
      { id: "r0", round: 0, files: [{ id: "a", file: a, driveRef: null }] },
      { id: "r1", round: 1, files: [{ id: "b", file: b, driveRef: null }] },
    ] });
    expect(distinct).not.toContain("The same FASTQ source cannot be assigned twice.");
    const duplicate = targetedInputErrors({ ...base, rounds: [
      { id: "r0", round: 0, files: [{ id: "a", file: a, driveRef: null }] },
      { id: "r1", round: 1, files: [{ id: "b", file: a, driveRef: null }] },
    ] });
    expect(duplicate).toContain("The same FASTQ source cannot be assigned twice.");
  });
});
