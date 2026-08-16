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
});
