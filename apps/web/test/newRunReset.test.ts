import { describe, expect, it } from "vitest";
import { useNanoporeStore } from "../src/state/useNanoporeStore";
import { useRunStore } from "../src/state/useRunStore";

describe("New run resets", () => {
  it("fully resets the cDNA/NGS wizard", () => {
    useRunStore.setState({
      currentStep: "results",
      projectName: "finished",
      localFiles: [new File(["x"], "reads.fastq")],
      expectedFileNames: ["reads.fastq"],
      referenceSeq: "ACG",
      adaptive: false,
      filterStop: false,
      useWasm: false,
      minMeanPhred: 5,
      minMeanPhredCds: 6,
      pseudocount: 1,
      pipelineMode: "per-round",
      estimatedReadLength: 999,
      status: "done",
      startedAt: 1,
      finishedAt: 2,
      log: [{ text: "done", tag: "success", at: 1 }],
      errorMessage: "old",
    });
    useRunStore.getState().resetAll();
    const state = useRunStore.getState();
    expect({
      step: state.currentStep,
      project: state.projectName,
      files: state.localFiles.length + state.driveFiles.length,
      expectedFiles: state.expectedFileNames,
      reference: state.referenceSeq,
      rounds: state.rounds.length,
      settings: [
        state.adaptive,
        state.filterStop,
        state.useWasm,
        state.minMeanPhred,
        state.minMeanPhredCds,
        state.pseudocount,
        state.pipelineMode,
      ],
      readLength: state.estimatedReadLength,
      status: state.status,
      log: state.log,
      error: state.errorMessage,
    }).toEqual({
      step: "sources",
      project: "",
      files: 0,
      expectedFiles: [],
      reference: "",
      rounds: 2,
      settings: [true, true, true, 20, 20, 0.5, "multiplexed"],
      readLength: 150,
      status: "idle",
      log: [],
      error: null,
    });
  });

  it("fully resets the legacy Nanopore wizard", () => {
    useNanoporeStore.setState({
      currentStep: "results",
      projectName: "finished",
      pipelineMode: "multiplexed",
      localFiles: [new File(["x"], "reads.fastq")],
      referenceSeq: "ACG",
      sites: [],
      rounds: [],
      reportHaplotype: false,
      minMeanPhredRead: 1,
      minMeanPhredRoi: 2,
      pseudocount: 1,
      status: "done",
      startedAt: 1,
      finishedAt: 2,
      errorMessage: "old",
    });
    useNanoporeStore.getState().resetAll();
    const state = useNanoporeStore.getState();
    expect({
      step: state.currentStep,
      project: state.projectName,
      mode: state.pipelineMode,
      files: state.localFiles.length + state.driveFiles.length,
      reference: state.referenceSeq,
      sites: state.sites.length,
      rounds: state.rounds.length,
      reportHaplotype: state.reportHaplotype,
      q: [state.minMeanPhredRead, state.minMeanPhredRoi],
      pseudocount: state.pseudocount,
      status: state.status,
      error: state.errorMessage,
    }).toEqual({
      step: "sources",
      project: "",
      mode: "per-round",
      files: 0,
      reference: "",
      sites: 1,
      rounds: 2,
      reportHaplotype: true,
      q: [10, 15],
      pseudocount: 0.5,
      status: "idle",
      error: null,
    });
  });
});
