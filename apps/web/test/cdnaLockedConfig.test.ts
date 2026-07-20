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
});
