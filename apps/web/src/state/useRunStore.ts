// Single global store covering the full wizard. Step 1 collects sources,
// Step 2 collects configuration, Step 3 runs anchor alignment ("Preview"),
// Step 4 runs the pipeline, Step 5 shows the results dashboard. Per-step
// data lives in one flat store so the user can step backwards without losing
// previously-entered values.

import { create } from "zustand";
import type { DriveFileRef, PipelineOutcome, PipelineProgressMsg } from "../worker/types";
export type { DriveFileRef };

// Steps are referenced by string id so the store stays tool-agnostic. The
// active tool (currently tools/cdna-display) decides which ids are valid
// and in what order — see STEP_ORDER below for the cDNA-DISPLAY ordering.
export type StepId = string;
// Ordering for the navigation helpers (goNext / goPrev). When a second tool
// ships, lift this to be tool-aware (per-tool store or a context-provided
// step list); for now, single-tool ordering lives here.
export const STEP_ORDER: StepId[] = ["sources", "configure", "preview", "run", "results"];

export type RunStatus = "idle" | "running" | "done" | "error" | "cancelled";

/** Two ways to feed reads into the demultiplex engine.
 *
 *  - `multiplexed` (default, historical): all FASTQs are scanned against
 *    every configured round; the engine picks the best-matching barcode
 *    per read. Use when rounds were pooled-and-barcoded onto one run.
 *
 *  - `per-round`: each FASTQ is bound to exactly one round by the user.
 *    The engine scores every read only against that round's primer — no
 *    cross-round competition. Use when each selection round was sequenced
 *    independently (same primer is then safe across rounds; no cross-talk
 *    because each file is physically separate). */
export type PipelineMode = "multiplexed" | "per-round";

export interface LogEntry {
  text: string;
  tag: "info" | "success" | "warning" | "error";
  at: number;
}

export interface RoundForm {
  id: string;            // local UI id; doesn't cross worker
  name: string;          // e.g. "Round_0" — round_configs key
  fwPrimer: string;
  rvPrimer: string;
  cdsStart: number | null;
  cdsEnd: number | null;
  /** Per-round FASTQ from the local filesystem. Only used when
   *  pipelineMode === "per-round". Mutually exclusive with `driveRef`:
   *  setting one clears the other. */
  file: File | null;
  /** Per-round FASTQ from Google Drive. Only used when
   *  pipelineMode === "per-round". Mutually exclusive with `file`. */
  driveRef: DriveFileRef | null;
}

// PreviewResult + PreviewStatus live in the cDNA tool module; re-export so
// store consumers don't reach across the tools/ boundary.
export type { PreviewResult, PreviewStatus } from "../tools/cdna-display/preview";
import type { PreviewResult } from "../tools/cdna-display/preview";

interface RunState {
  currentStep: StepId;

  // Step 1 — sources
  projectName: string;
  localFiles: File[];
  driveFiles: DriveFileRef[];

  // Step 2 — configure
  referenceSeq: string;
  rounds: RoundForm[];
  adaptive: boolean;
  filterStop: boolean;
  useWasm: boolean;
  pipelineMode: PipelineMode;
  /** Per-read mean Phred gate. Default 20 (Illumina Q≥20 is the standard
   *  cutoff for high-confidence base calls). Editable on Configure → Advanced. */
  minMeanPhred: number;
  /** Per-CDS-region mean Phred gate (B2 fix). Default 20. */
  minMeanPhredCds: number;
  /** Enrichment pseudocount in RPM units. 0.5 is recommended; 1.0 reproduces RPM+1 scores. */
  pseudocount: number;

  // Step 3 — preview
  /** Estimated read length, sampled from the first FASTQ during preview. */
  estimatedReadLength: number;
  previewResults: PreviewResult[];

  // Step 4 — run
  status: RunStatus;
  progress: PipelineProgressMsg | null;
  perSourceBytes: Record<number, number>;
  startedAt: number | null;
  finishedAt: number | null;
  log: LogEntry[];

  // Step 5 — results
  outcome: PipelineOutcome | null;
  errorMessage: string | null;

  // Setters
  setStep: (s: StepId) => void;
  goNext: () => void;
  goPrev: () => void;

  setProjectName: (v: string) => void;
  setLocalFiles: (files: File[]) => void;
  setDriveFiles: (files: DriveFileRef[]) => void;
  clearAllFiles: () => void;

  setReferenceSeq: (v: string) => void;
  setRounds: (rounds: RoundForm[]) => void;
  updateRound: (id: string, patch: Partial<RoundForm>) => void;
  addRound: () => void;
  removeRound: (id: string) => void;
  setAdaptive: (v: boolean) => void;
  setFilterStop: (v: boolean) => void;
  setUseWasm: (v: boolean) => void;
  setPipelineMode: (m: PipelineMode) => void;
  setMinMeanPhred: (v: number) => void;
  setMinMeanPhredCds: (v: number) => void;
  setPseudocount: (v: number) => void;

  setPreview: (estReadLen: number, results: PreviewResult[]) => void;
  clearPreview: () => void;

  startRun: () => void;
  updateProgress: (p: PipelineProgressMsg) => void;
  finishRun: (outcome: PipelineOutcome) => void;
  failRun: (msg: string) => void;
  cancelRun: () => void;

  appendLog: (entry: Omit<LogEntry, "at">) => void;

  resetAll: () => void;
}

let nextRoundIdSeq = 0;
const mkRoundId = (): string => `r${++nextRoundIdSeq}_${Date.now() % 100000}`;

function defaultRound(idx: number): RoundForm {
  return {
    id: mkRoundId(),
    name: `Round_${idx}`,
    fwPrimer: "",
    rvPrimer: "",
    cdsStart: null,
    cdsEnd: null,
    file: null,
    driveRef: null,
  };
}

export const useRunStore = create<RunState>((set, get) => ({
  currentStep: "sources",

  projectName: "",
  localFiles: [],
  driveFiles: [],

  referenceSeq: "",
  rounds: [defaultRound(0), defaultRound(1)],
  adaptive: true,
  filterStop: true,
  useWasm: true,
  minMeanPhred: 20,
  minMeanPhredCds: 20,
  pseudocount: 0.5,
  pipelineMode: "multiplexed",

  estimatedReadLength: 150,
  previewResults: [],

  status: "idle",
  progress: null,
  perSourceBytes: {},
  startedAt: null,
  finishedAt: null,
  log: [],

  outcome: null,
  errorMessage: null,

  setStep: (s) => set({ currentStep: s }),
  goNext: () => {
    const i = STEP_ORDER.indexOf(get().currentStep);
    if (i < STEP_ORDER.length - 1) set({ currentStep: STEP_ORDER[i + 1]! });
  },
  goPrev: () => {
    const i = STEP_ORDER.indexOf(get().currentStep);
    if (i > 0) set({ currentStep: STEP_ORDER[i - 1]! });
  },

  setProjectName: (v) => set({ projectName: v }),
  setLocalFiles: (files) => set({ localFiles: files }),
  setDriveFiles: (files) => set({ driveFiles: files }),
  clearAllFiles: () => set({ localFiles: [], driveFiles: [] }),

  setReferenceSeq: (v) => set({ referenceSeq: v.toUpperCase().replace(/[^ACGTN]/g, "") }),
  setRounds: (rounds) => set({ rounds }),
  updateRound: (id, patch) =>
    set({ rounds: get().rounds.map((r) => (r.id === id ? { ...r, ...patch } : r)) }),
  addRound: () =>
    set({
      rounds: [...get().rounds, defaultRound(get().rounds.length)],
    }),
  removeRound: (id) => set({ rounds: get().rounds.filter((r) => r.id !== id) }),
  setAdaptive: (v) => set({ adaptive: v }),
  setFilterStop: (v) => set({ filterStop: v }),
  setUseWasm: (v) => set({ useWasm: v }),
  setPipelineMode: (m) => set({ pipelineMode: m }),
  setMinMeanPhred: (v) => set({ minMeanPhred: v }),
  setMinMeanPhredCds: (v) => set({ minMeanPhredCds: v }),
  setPseudocount: (v) => set({ pseudocount: v }),

  setPreview: (estReadLen, results) =>
    set({ estimatedReadLength: estReadLen, previewResults: results }),
  clearPreview: () => set({ previewResults: [] }),

  startRun: () =>
    set({
      status: "running",
      progress: null,
      perSourceBytes: {},
      outcome: null,
      errorMessage: null,
      log: [],
      startedAt: performance.now(),
      finishedAt: null,
    }),
  updateProgress: (p) =>
    set((s) => ({
      progress: p,
      perSourceBytes: { ...s.perSourceBytes, [p.sourceIndex]: p.bytesProcessed },
    })),
  finishRun: (outcome) =>
    set({ status: "done", outcome, finishedAt: performance.now(), currentStep: "results" }),
  failRun: (msg) => set({ status: "error", errorMessage: msg, finishedAt: performance.now() }),
  cancelRun: () => set({ status: "cancelled", finishedAt: performance.now() }),

  appendLog: (entry) => set((s) => ({ log: [...s.log, { ...entry, at: performance.now() }] })),

  resetAll: () =>
    set({
      currentStep: "sources",
      projectName: "",
      localFiles: [],
      driveFiles: [],
      referenceSeq: "",
      rounds: [defaultRound(0), defaultRound(1)],
      adaptive: true,
      filterStop: true,
      useWasm: true,
      minMeanPhred: 20,
      minMeanPhredCds: 20,
      pseudocount: 0.5,
      pipelineMode: "multiplexed",
      estimatedReadLength: 150,
      previewResults: [],
      status: "idle",
      progress: null,
      perSourceBytes: {},
      startedAt: null,
      finishedAt: null,
      log: [],
      outcome: null,
      errorMessage: null,
    }),
}));
