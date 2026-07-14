import { describe, expect, it } from "vitest";
import { targetedDesignErrors, targetedSourceErrors } from "../src/state/useTargetedNanoporeStore";

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
});
