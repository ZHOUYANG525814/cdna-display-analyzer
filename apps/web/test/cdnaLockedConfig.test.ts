import { describe, expect, it } from "vitest";
import {
  buildCdnaLockedConfig,
  parseCdnaLockedConfig,
  type CdnaExportSnapshot,
} from "../src/adapters/BrowserExporter";
import { useRunStore } from "../src/state/useRunStore";

function snapshot(mode: "multiplexed" | "per-round"): CdnaExportSnapshot {
  return {
    projectName: "locked_ngs",
    pipelineMode: mode,
    referenceSeq: "ACGT".repeat(20),
    localFiles:
      mode === "multiplexed" ? [new File(["reads"], "pooled.fastq")] : [],
    driveFiles: [],
    expectedFileNames: [],
    rounds: [
      {
        id: "r0",
        name: "Round_0",
        fwPrimer: "ACGTACGTAC",
        rvPrimer: "TGCATGCATG",
        cdsStart: 1,
        cdsEnd: 30,
        file: mode === "per-round" ? new File(["reads"], "round0.fastq") : null,
        driveRef: null,
        expectedFileName: null,
      },
      {
        id: "r1",
        name: "Round_1",
        fwPrimer: "ACGTACGTAA",
        rvPrimer: "TGCATGCATA",
        cdsStart: 1,
        cdsEnd: 30,
        file: null,
        driveRef:
          mode === "per-round"
            ? { id: "secret-drive-id", name: "round1.fq", sizeBytes: 123 }
            : null,
        expectedFileName: null,
      },
    ],
    filterStop: true,
    useWasm: true,
    minMeanPhred: 20,
    minMeanPhredCds: 20,
    pseudocount: 0.5,
  };
}

describe("cDNA-display locked config", () => {
  it.each(["multiplexed", "per-round"] as const)(
    "round-trips %s settings and retains filenames only",
    (mode) => {
      const locked = buildCdnaLockedConfig(snapshot(mode));
      const serialized = JSON.stringify(locked);
      expect(locked.calculationModel).toBe("rpm-pseudocount-v1");
      expect(locked.pseudocountUnit).toBe("RPM");
      expect(serialized).not.toContain("secret-drive-id");
      expect(serialized).not.toContain("sizeBytes");
      expect(serialized).not.toContain("lastModified");

      const imported = parseCdnaLockedConfig(serialized);
      useRunStore.getState().loadLockedConfig(imported);
      const state = useRunStore.getState();
      expect(state.localFiles).toEqual([]);
      expect(state.driveFiles).toEqual([]);
      expect(state.rounds.every((round) => !round.file && !round.driveRef)).toBe(true);
      expect(state.pseudocount).toBe(0.5);
      expect(buildCdnaLockedConfig(state)).toEqual(locked);
    },
  );

  it("rejects unsupported and unsafe configs", () => {
    const locked = buildCdnaLockedConfig(snapshot("multiplexed"));
    expect(() =>
      parseCdnaLockedConfig(JSON.stringify({ ...locked, schemaVersion: "v0" })),
    ).toThrow(/schema/i);
    expect(() =>
      parseCdnaLockedConfig(
        JSON.stringify({
          ...locked,
          sources: { expectedFileNames: ["../reads.fastq"] },
        }),
      ),
    ).toThrow(/filename/i);
  });

  it("rejects malformed JSON and invalid values at every trust boundary", () => {
    const multiplexed = buildCdnaLockedConfig(snapshot("multiplexed"));
    const perRound = buildCdnaLockedConfig(snapshot("per-round"));
    expect(() => parseCdnaLockedConfig("{")).toThrow(/JSON/i);
    expect(() => parseCdnaLockedConfig("[]")).toThrow(/object/i);

    const invalid: Array<[string, unknown]> = [
      ["calculation model", { ...multiplexed, calculationModel: "count-pseudocount" }],
      ["pseudocount unit", { ...multiplexed, pseudocountUnit: "count" }],
      ["project", { ...multiplexed, project: "<script>" }],
      ["pipeline mode", { ...multiplexed, pipelineMode: "automatic" }],
      ["reference alphabet", { ...multiplexed, reference: "ACGTX".repeat(20) }],
      ["source array", { ...multiplexed, sources: { expectedFileNames: "reads.fastq" } }],
      ["too many sources", {
        ...multiplexed,
        sources: {
          expectedFileNames: Array.from(
            { length: 1_001 },
            (_, index) => `reads_${index}.fastq`,
          ),
        },
      }],
      ["per-round global source", { ...perRound, sources: { expectedFileNames: ["pooled.fastq"] } }],
      ["multiplexed round source", {
        ...multiplexed,
        rounds: [{ ...multiplexed.rounds[0], expectedFileName: "round.fastq" }, multiplexed.rounds[1]],
      }],
      ["missing per-round source", {
        ...perRound,
        rounds: [{ ...perRound.rounds[0], expectedFileName: null }, perRound.rounds[1]],
      }],
      ["duplicate round", {
        ...multiplexed,
        rounds: [multiplexed.rounds[0], { ...multiplexed.rounds[1], name: multiplexed.rounds[0]!.name }],
      }],
      ["duplicate multiplexed primer", {
        ...multiplexed,
        rounds: [
          multiplexed.rounds[0],
          {
            ...multiplexed.rounds[1],
            fwPrimer: multiplexed.rounds[0]!.fwPrimer,
          },
        ],
      }],
      ["too many rounds", {
        ...multiplexed,
        rounds: Array.from(
          { length: 101 },
          (_, index) => ({ ...multiplexed.rounds[0], name: `Round_${index}` }),
        ),
      }],
      ["short primer", {
        ...multiplexed,
        rounds: [{ ...multiplexed.rounds[0], fwPrimer: "ACGT" }, multiplexed.rounds[1]],
      }],
      ["invalid CDS frame", {
        ...multiplexed,
        rounds: [{ ...multiplexed.rounds[0], cdsEnd: 29 }, multiplexed.rounds[1]],
      }],
      ["quality threshold", {
        ...multiplexed,
        settings: { ...multiplexed.settings, minMeanPhred: 41 },
      }],
      ["boolean setting", {
        ...multiplexed,
        settings: { ...multiplexed.settings, useWasm: "yes" },
      }],
      ["zero pseudocount", {
        ...multiplexed,
        settings: { ...multiplexed.settings, pseudocount: 0 },
      }],
      ["fixed safeguard", {
        ...multiplexed,
        fixedSafeguards: { adaptivePrimerMatching: false },
      }],
    ];
    for (const [label, value] of invalid) {
      expect(
        () => parseCdnaLockedConfig(JSON.stringify(value)),
        label,
      ).toThrow();
    }
  });

  it("resets stale run state and preserves a filename hint after replacement", () => {
    const imported = parseCdnaLockedConfig(
      JSON.stringify(buildCdnaLockedConfig(snapshot("per-round"))),
    );
    useRunStore.setState({
      currentStep: "results",
      status: "error",
      errorMessage: "old failure",
      log: [{ text: "old log", tag: "error", at: 1 }],
      startedAt: 1,
      finishedAt: 2,
    });
    useRunStore.getState().loadLockedConfig(imported);
    let state = useRunStore.getState();
    expect(state).toMatchObject({
      currentStep: "sources",
      status: "idle",
      errorMessage: null,
      log: [],
      startedAt: null,
      finishedAt: null,
    });
    const first = state.rounds[0]!;
    expect(first.expectedFileName).toBe("round0.fastq");
    state.updateRound(first.id, {
      file: new File(["replacement"], "renamed.fastq"),
      driveRef: null,
    });
    state = useRunStore.getState();
    expect(state.rounds[0]!.file?.name).toBe("renamed.fastq");
    expect(state.rounds[0]!.expectedFileName).toBe("round0.fastq");
  });
});
