import { describe, expect, it } from "vitest";
import { targetedDesignErrors, targetedInputErrors, targetedSourceErrors, useTargetedNanoporeStore } from "../src/state/useTargetedNanoporeStore";

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
      { id: "r0", round: 0, files: [{ id: "a", file: a, driveRef: null, expectedFileName: null }] },
      { id: "r1", round: 1, files: [{ id: "b", file: b, driveRef: null, expectedFileName: null }] },
    ] });
    expect(distinct).not.toContain("The same FASTQ source cannot be assigned twice.");
    const duplicate = targetedInputErrors({ ...base, rounds: [
      { id: "r0", round: 0, files: [{ id: "a", file: a, driveRef: null, expectedFileName: null }] },
      { id: "r1", round: 1, files: [{ id: "b", file: a, driveRef: null, expectedFileName: null }] },
    ] });
    expect(duplicate).toContain("The same FASTQ source cannot be assigned twice.");
  });

  it("starts a new run from the true initial state", () => {
    useTargetedNanoporeStore.setState({
      projectName: "finished", referenceSeq: "ACG".repeat(20), cdsStart: 1, cdsEnd: 60,
      sites: [{ id: "s", name: "site_01", ntStart: 1 }],
      rounds: [{ id: "r", round: 0, files: [{ id: "f", file: new File(["x"], "x.fastq"), driveRef: null, expectedFileName: null }] }],
      currentStep: "results", qcLocked: true,
    });
    useTargetedNanoporeStore.getState().prepareNextRun();
    const state = useTargetedNanoporeStore.getState();
    expect(state.currentStep).toBe("inputs");
    expect(state.projectName).toBe("");
    expect(state.rounds.map((r) => [r.round, r.files.length])).toEqual([[0, 0], [1, 0]]);
    expect(state.referenceSeq).toBe("");
    expect(state.cdsStart).toBe(1);
    expect(state.cdsEnd).toBe(0);
    expect(state.sites).toEqual([]);
    expect(state.settings).toEqual({
      minReadQ: 10,
      minReferenceCoverage: 0.9,
      minAlignmentIdentity: 0.85,
      minProtectedIdentity: 0.95,
      maxProtectedIndelBases: 30,
      minTargetBaseQ: 15,
      minInputCountToScore: 10,
      pseudocount: 0.5,
    });
    expect(state.qcLocked).toBe(false);
    expect(state.runState).toMatchObject({
      status: "idle",
      progress: null,
      perSourceBytes: {},
      log: [],
    });
  });

  it("tracks targeted progress and live log entries in run state", () => {
    const state = useTargetedNanoporeStore.getState();
    state.setRunState({
      status: "running",
      progress: null,
      perSourceBytes: {},
      log: [],
    });
    state.updateRunProgress({
      sourceIndex: 1,
      fileName: "round1.fastq",
      bytesProcessed: 1024,
      totalBytes: 2048,
      recordsProcessed: 10,
    });
    state.appendRunLog({ tag: "info", msg: "source started" });
    expect(useTargetedNanoporeStore.getState().runState).toMatchObject({
      status: "running",
      progress: { sourceIndex: 1, recordsProcessed: 10 },
      perSourceBytes: { 1: 1024 },
      log: [{ tag: "info", msg: "source started" }],
    });
  });

  it("loads locked filename hints and accepts a non-matching replacement without blocking", () => {
    useTargetedNanoporeStore.getState().loadLockedConfig({
      projectName: "locked",
      referenceSeq: "ACG".repeat(20),
      cdsStart: 1,
      cdsEnd: 60,
      cdsStrand: "+",
      sites: [{ ntStart: 1 }],
      settings: {
        minReadQ: 10,
        minReferenceCoverage: 0.9,
        minAlignmentIdentity: 0.85,
        minProtectedIdentity: 0.95,
        maxProtectedIndelBases: 30,
        minTargetBaseQ: 15,
        minInputCountToScore: 10,
        pseudocount: 0.5,
      },
      reportHaplotypes: false,
      rounds: [
        { round: 0, expectedFileNames: ["expected-r0.fastq"] },
        { round: 1, expectedFileNames: ["expected-r1.fastq"] },
      ],
    });
    let state = useTargetedNanoporeStore.getState();
    expect(state.rounds[0]!.files[0]!.expectedFileName).toBe("expected-r0.fastq");
    expect(state.rounds[0]!.files[0]!.file).toBeNull();

    state.addLocalFiles(state.rounds[0]!.id, [new File(["x"], "renamed.fastq")]);
    state = useTargetedNanoporeStore.getState();
    expect(state.rounds[0]!.files[0]!.file?.name).toBe("renamed.fastq");
    expect(state.rounds[0]!.files[0]!.expectedFileName).toBe("expected-r0.fastq");
  });
});
