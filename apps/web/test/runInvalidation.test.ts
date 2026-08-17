import { beforeEach, describe, expect, it } from "vitest";
import { useRunStore } from "../src/state/useRunStore";
import { useTargetedNanoporeStore } from "../src/state/useTargetedNanoporeStore";

describe("completed-result invalidation", () => {
  beforeEach(() => {
    useRunStore.getState().resetAll();
    useTargetedNanoporeStore.getState().prepareNextRun();
  });

  it("clears NGS results, progress, logs and errors after a scientific setting changes", () => {
    useRunStore.setState({ status: "done", outcome: {} as never, progress: {} as never, log: [{ text: "old", tag: "info", at: 1 }], errorMessage: "old" });
    useRunStore.getState().setPseudocount(1);
    expect(useRunStore.getState()).toMatchObject({ status: "idle", outcome: null, progress: null, log: [], errorMessage: null });
  });

  it("clears Nanopore results after a file, design or QC setting changes", () => {
    useTargetedNanoporeStore.setState({ runState: { ...useTargetedNanoporeStore.getState().runState, status: "done", outcome: {} as never, log: [{ ts: 1, tag: "info", msg: "old" }] } });
    useTargetedNanoporeStore.getState().setSettings({ pseudocount: 1 });
    expect(useTargetedNanoporeStore.getState().runState).toMatchObject({ status: "idle", outcome: null, progress: null, log: [], error: null });
  });

  it("prepares an NGS rerun without changing files, design or settings", () => {
    const file = new File(["x"], "reads.fastq");
    useRunStore.setState({ currentStep: "results", projectName: "keep", localFiles: [file], referenceSeq: "ACG", pseudocount: 1, status: "done", outcome: {} as never });
    useRunStore.getState().prepareRerun();
    expect(useRunStore.getState()).toMatchObject({ currentStep: "analyze", projectName: "keep", localFiles: [file], referenceSeq: "ACG", pseudocount: 1, status: "idle", outcome: null });
  });

  it("prepares a Nanopore rerun without changing files, targets or settings", () => {
    const before = useTargetedNanoporeStore.getState();
    useTargetedNanoporeStore.setState({ currentStep: "results", projectName: "keep", sites: [{ id: "s", name: "site_01", ntStart: 7 }], settings: { ...before.settings, pseudocount: 1 }, runState: { ...before.runState, status: "done", outcome: {} as never } });
    useTargetedNanoporeStore.getState().prepareRerun();
    expect(useTargetedNanoporeStore.getState()).toMatchObject({ currentStep: "analyze", projectName: "keep", sites: [{ id: "s", name: "site_01", ntStart: 7 }], settings: { pseudocount: 1 }, runState: { status: "idle", outcome: null } });
  });
});
