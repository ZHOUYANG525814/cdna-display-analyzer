import { create } from "zustand";
import { normalizeReference, resolveTargetSites, type TargetedQcSettings } from "@cdna/core";
import type { DriveFileRef, PipelineProgressMsg } from "../worker/types";
import { NANOPORE_INPUT_LIMITS, validateNanoporeDriveFile, validateNanoporeLocalFile } from "../tools/nanopore-targeted/inputValidation";
import { validateProjectName } from "../lib/validation";

export const TARGETED_NANOPORE_STEPS = ["inputs", "qc", "run", "results"] as const;
export type TargetedNanoporeStepId = (typeof TARGETED_NANOPORE_STEPS)[number];

export interface TargetedSourceFile {
  id: string;
  file: File | null;
  driveRef: DriveFileRef | null;
  /** Filename recorded by an imported locked config. No path, ID, token or
   * file content is retained. */
  expectedFileName: string | null;
}

export interface TargetedRoundForm {
  id: string;
  /** Zero-based biological selection round. Round 0 is always the baseline. */
  round: number;
  files: TargetedSourceFile[];
}

export interface TargetedSiteForm {
  id: string;
  name: string;
  /** One-based first nucleotide of the codon in the amplicon reference. */
  ntStart: number;
}

export interface TargetedCallingSettings extends TargetedQcSettings {
  minTargetBaseQ: number;
  minInputCountToScore: number;
  pseudocount: number;
}

export interface TargetedRunState {
  status: "idle" | "running" | "done" | "error" | "cancelled";
  error: string | null;
  outcome: import("../worker/types").TargetedNanoporeOutcome | null;
  startedAt: number | null;
  finishedAt: number | null;
  progress: PipelineProgressMsg | null;
  perSourceBytes: Record<number, number>;
  log: TargetedLogEntry[];
}

export interface TargetedLogEntry {
  ts: number;
  tag: "info" | "success" | "warning" | "error";
  msg: string;
}

export interface TargetedLockedConfigImport {
  projectName: string;
  referenceSeq: string;
  cdsStart: number;
  cdsEnd: number;
  cdsStrand: "+" | "-";
  sites: Array<{ ntStart: number }>;
  settings: TargetedCallingSettings;
  reportHaplotypes: boolean;
  rounds: Array<{ round: number; expectedFileNames: string[] }>;
}

interface TargetedNanoporeState {
  currentStep: TargetedNanoporeStepId;
  setStep: (step: TargetedNanoporeStepId) => void;
  goNext: () => void;
  goPrev: () => void;
  projectName: string;
  setProjectName: (value: string) => void;
  rounds: TargetedRoundForm[];
  addRound: () => void;
  removeRound: (id: string) => void;
  addLocalFiles: (roundId: string, files: File[]) => void;
  addDriveFiles: (roundId: string, files: DriveFileRef[]) => void;
  removeSource: (roundId: string, sourceId: string) => void;
  referenceSeq: string;
  setReferenceSeq: (value: string) => void;
  cdsStart: number;
  cdsEnd: number;
  cdsStrand: "+" | "-";
  setCds: (patch: Partial<Pick<TargetedNanoporeState, "cdsStart" | "cdsEnd" | "cdsStrand">>) => void;
  sites: TargetedSiteForm[];
  setSites: (sites: TargetedSiteForm[]) => void;
  addSiteByNt: (ntStart: number) => void;
  removeSite: (id: string) => void;
  settings: TargetedCallingSettings;
  setSettings: (patch: Partial<TargetedCallingSettings>) => void;
  qcLocked: boolean;
  setQcLocked: (locked: boolean) => void;
  reportHaplotypes: boolean;
  setReportHaplotypes: (value: boolean) => void;
  runState: TargetedRunState;
  setRunState: (patch: Partial<TargetedRunState>) => void;
  updateRunProgress: (progress: PipelineProgressMsg) => void;
  appendRunLog: (entry: Omit<TargetedLogEntry, "ts">) => void;
  loadLockedConfig: (config: TargetedLockedConfigImport) => void;
  /** Return to a genuinely fresh initial wizard. */
  prepareNextRun: () => void;
}

export const TARGETED_USER_DEFAULTS: TargetedCallingSettings = {
  minReadQ: 10,
  minReferenceCoverage: 0.9,
  minAlignmentIdentity: 0.85,
  minProtectedIdentity: 0.95,
  maxProtectedIndelBases: 30,
  minTargetBaseQ: 15,
  minInputCountToScore: 10,
  pseudocount: 0.5,
};

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeRound(round: number): TargetedRoundForm {
  return { id: uid("round"), round, files: [] };
}

function emptyRunState(): TargetedRunState {
  return {
    status: "idle",
    error: null,
    outcome: null,
    startedAt: null,
    finishedAt: null,
    progress: null,
    perSourceBytes: {},
    log: [],
  };
}

function expectedSource(expectedFileName: string): TargetedSourceFile {
  return { id: uid("expected"), file: null, driveRef: null, expectedFileName };
}

function attachSources(
  existing: TargetedSourceFile[],
  sources: Array<{ file: File | null; driveRef: DriveFileRef | null }>,
): TargetedSourceFile[] {
  const next = existing.map((source) => ({ ...source }));
  const unmatched: Array<{ file: File | null; driveRef: DriveFileRef | null }> = [];
  // Exact filename matches claim their intended slots first, independent of
  // picker order. This prevents an unrelated shard from consuming a later
  // exact match's slot.
  for (const source of sources) {
    const actualName = source.file?.name ?? source.driveRef?.name ?? "";
    const index = next.findIndex((slot) =>
      !slot.file && !slot.driveRef && slot.expectedFileName === actualName
    );
    if (index >= 0) {
      next[index] = { ...next[index]!, ...source };
    } else unmatched.push(source);
  }
  for (const source of unmatched) {
    const index = next.findIndex((slot) => !slot.file && !slot.driveRef);
    if (index >= 0) {
      next[index] = { ...next[index]!, ...source };
    } else {
      next.push({ id: uid(source.file ? "local" : "drive"), ...source, expectedFileName: null });
    }
  }
  return next.slice(0, NANOPORE_INPUT_LIMITS.maxFilesPerRound);
}

function renumber(rounds: TargetedRoundForm[]): TargetedRoundForm[] {
  return rounds.map((item, round) => ({ ...item, round }));
}

export const useTargetedNanoporeStore = create<TargetedNanoporeState>((set, get) => ({
  currentStep: "inputs",
  setStep: (currentStep) => set({ currentStep }),
  goNext: () => {
    const i = TARGETED_NANOPORE_STEPS.indexOf(get().currentStep);
    if (i < TARGETED_NANOPORE_STEPS.length - 1) set({ currentStep: TARGETED_NANOPORE_STEPS[i + 1]! });
  },
  goPrev: () => {
    const i = TARGETED_NANOPORE_STEPS.indexOf(get().currentStep);
    if (i > 0) set({ currentStep: TARGETED_NANOPORE_STEPS[i - 1]! });
  },
  projectName: "",
  setProjectName: (projectName) => set({ projectName, qcLocked: false }),
  rounds: [makeRound(0), makeRound(1)],
  addRound: () => {
    if (get().rounds.length >= NANOPORE_INPUT_LIMITS.maxRounds) return;
    set({ rounds: [...get().rounds, makeRound(get().rounds.length)], qcLocked: false });
  },
  removeRound: (id) => set({ rounds: renumber(get().rounds.filter((r) => r.id !== id)), qcLocked: false }),
  addLocalFiles: (roundId, files) => set({
    rounds: get().rounds.map((r) => r.id === roundId ? {
      ...r,
      files: attachSources(r.files, files.map((file) => ({ file, driveRef: null }))),
    } : r),
    qcLocked: false,
  }),
  addDriveFiles: (roundId, files) => set({
    rounds: get().rounds.map((r) => r.id === roundId ? {
      ...r,
      files: attachSources(r.files, files.map((driveRef) => ({ file: null, driveRef }))),
    } : r),
    qcLocked: false,
  }),
  removeSource: (roundId, sourceId) => set({
    rounds: get().rounds.map((r) => r.id === roundId ? {
      ...r,
      files: r.files.flatMap((source) => {
        if (source.id !== sourceId) return [source];
        return source.expectedFileName
          ? [{ ...source, file: null, driveRef: null }]
          : [];
      }),
    } : r),
    qcLocked: false,
  }),
  referenceSeq: "",
  setReferenceSeq: (referenceSeq) => set({ referenceSeq, qcLocked: false }),
  cdsStart: 1,
  cdsEnd: 0,
  cdsStrand: "+",
  setCds: (patch) => set({ ...patch, qcLocked: false }),
  sites: [],
  setSites: (sites) => set({ sites, qcLocked: false }),
  addSiteByNt: (ntStart) => {
    if (get().sites.length >= NANOPORE_INPUT_LIMITS.maxSites) return;
    if (get().sites.some((s) => s.ntStart === ntStart)) return;
    const sites = [...get().sites, { id: uid("site"), name: "", ntStart }]
      .sort((a, b) => a.ntStart - b.ntStart)
      .map((s, i) => ({ ...s, name: `site_${String(i + 1).padStart(2, "0")}` }));
    set({ sites, qcLocked: false });
  },
  removeSite: (id) => set({
    sites: get().sites.filter((s) => s.id !== id).map((s, i) => ({ ...s, name: `site_${String(i + 1).padStart(2, "0")}` })),
    qcLocked: false,
  }),
  settings: TARGETED_USER_DEFAULTS,
  setSettings: (patch) => set({ settings: { ...get().settings, ...patch }, qcLocked: false }),
  qcLocked: false,
  setQcLocked: (qcLocked) => set({ qcLocked }),
  reportHaplotypes: true,
  setReportHaplotypes: (reportHaplotypes) => set({ reportHaplotypes }),
  runState: emptyRunState(),
  setRunState: (patch) => set({ runState: { ...get().runState, ...patch } }),
  updateRunProgress: (progress) => set({
    runState: {
      ...get().runState,
      progress,
      perSourceBytes: {
        ...get().runState.perSourceBytes,
        [progress.sourceIndex]: progress.bytesProcessed,
      },
    },
  }),
  appendRunLog: (entry) => set({
    runState: {
      ...get().runState,
      log: [...get().runState.log, { ...entry, ts: Date.now() }],
    },
  }),
  loadLockedConfig: (config) => set({
    currentStep: "inputs",
    projectName: config.projectName,
    rounds: config.rounds.map(({ round, expectedFileNames }) => ({
      id: uid("round"),
      round,
      files: expectedFileNames.map(expectedSource),
    })),
    referenceSeq: config.referenceSeq,
    cdsStart: config.cdsStart,
    cdsEnd: config.cdsEnd,
    cdsStrand: config.cdsStrand,
    sites: config.sites.map(({ ntStart }, index) => ({
      id: uid("site"),
      name: `site_${String(index + 1).padStart(2, "0")}`,
      ntStart,
    })),
    settings: { ...config.settings },
    reportHaplotypes: config.reportHaplotypes,
    qcLocked: false,
    runState: emptyRunState(),
  }),
  prepareNextRun: () => set({
    currentStep: "inputs",
    projectName: "",
    rounds: [makeRound(0), makeRound(1)],
    referenceSeq: "",
    cdsStart: 1,
    cdsEnd: 0,
    cdsStrand: "+",
    sites: [],
    settings: { ...TARGETED_USER_DEFAULTS },
    qcLocked: false,
    reportHaplotypes: true,
    runState: emptyRunState(),
  }),
}));

export function targetedInputErrors(state: Pick<TargetedNanoporeState,
  "projectName" | "rounds" | "referenceSeq" | "cdsStart" | "cdsEnd" | "sites"
>): string[] {
  const errors: string[] = [];
  const projectError = validateProjectName(state.projectName);
  if (projectError) errors.push(projectError);
  if (state.rounds.length < 2) errors.push("Round 0 and at least one selected round are required.");
  if (state.rounds.length > NANOPORE_INPUT_LIMITS.maxRounds) errors.push(`At most ${NANOPORE_INPUT_LIMITS.maxRounds} rounds are supported.`);
  if (state.rounds.some((r, i) => r.round !== i)) errors.push("Rounds must be consecutive from Round 0.");
  if (state.rounds.some((r) => r.files.length === 0)) errors.push("Every round needs at least one FASTQ file.");
  if (state.rounds.some((r) => r.files.length > NANOPORE_INPUT_LIMITS.maxFilesPerRound)) errors.push(`At most ${NANOPORE_INPUT_LIMITS.maxFilesPerRound} files are allowed per round.`);
  for (const round of state.rounds) for (const source of round.files) {
    const check = source.file ? validateNanoporeLocalFile(source.file) : source.driveRef ? validateNanoporeDriveFile(source.driveRef) : { ok: false, reason: "Missing file source." };
    if (!check.ok) errors.push(`Round ${round.round}: ${check.reason}`);
  }
  const driveIds = state.rounds.flatMap((r) => r.files.flatMap((f) => f.driveRef ? [f.driveRef.id] : []));
  const localObjects = state.rounds.flatMap((r) => r.files.flatMap((f) => f.file ? [f.file] : []));
  if (new Set(driveIds).size !== driveIds.length || new Set(localObjects).size !== localObjects.length) errors.push("The same FASTQ source cannot be assigned twice.");
  const reference = normalizeReference(state.referenceSeq);
  if (!reference) errors.push("Amplicon reference is required.");
  if (reference.length > NANOPORE_INPUT_LIMITS.maxReferenceBases) errors.push(`Reference exceeds ${NANOPORE_INPUT_LIMITS.maxReferenceBases.toLocaleString()} bases.`);
  if (reference && reference.length < NANOPORE_INPUT_LIMITS.minReferenceBases) errors.push(`Reference must contain at least ${NANOPORE_INPUT_LIMITS.minReferenceBases} bases.`);
  if (state.sites.length > NANOPORE_INPUT_LIMITS.maxSites) errors.push(`At most ${NANOPORE_INPUT_LIMITS.maxSites} target codons are supported.`);
  if (!Number.isInteger(state.cdsStart) || !Number.isInteger(state.cdsEnd) || state.cdsStart < 1 || state.cdsEnd > reference.length || state.cdsEnd < state.cdsStart) {
    errors.push("CDS start/end must define a valid interval inside the reference.");
  } else if ((state.cdsEnd - state.cdsStart + 1) % 3 !== 0) {
    errors.push("CDS length must be divisible by 3.");
  }
  try {
    resolveTargetSites(reference, state.sites.map((s) => ({ name: s.name, ntStart: s.ntStart, length: 3 })));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const site of state.sites) {
    if (site.ntStart < state.cdsStart || site.ntStart + 2 > state.cdsEnd || (site.ntStart - state.cdsStart) % 3 !== 0) {
      errors.push(`${site.name || "Target"} must start on a codon boundary inside the CDS.`);
    }
  }
  return [...new Set(errors)];
}

// Compatibility aliases for pre-registration tests/imports.
export const targetedSourceErrors = (state: Pick<TargetedNanoporeState, "projectName" | "rounds">): string[] => {
  const errors: string[] = [];
  if (!state.projectName.trim()) errors.push("Project name is required.");
  if (state.rounds.length < 2) errors.push("Round 0 and at least one selected round are required.");
  if (state.rounds.some((r) => r.files.length === 0)) errors.push("Every round needs at least one FASTQ file.");
  return errors;
};

export function targetedDesignErrors(state: Pick<TargetedNanoporeState, "referenceSeq" | "sites">): string[] {
  try {
    resolveTargetSites(state.referenceSeq, state.sites.map((s) => ({ name: s.name, ntStart: s.ntStart, length: 3 })));
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
