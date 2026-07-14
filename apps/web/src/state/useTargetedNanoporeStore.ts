import { create } from "zustand";
import { normalizeReference, resolveTargetSites, type TargetedQcSettings } from "@cdna/core";
import type { DriveFileRef } from "../worker/types";

export const TARGETED_NANOPORE_STEPS = ["inputs", "qc", "run", "results"] as const;
export type TargetedNanoporeStepId = (typeof TARGETED_NANOPORE_STEPS)[number];

export interface TargetedSourceFile {
  id: string;
  file: File | null;
  driveRef: DriveFileRef | null;
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
}

export interface TargetedRunState {
  status: "idle" | "running" | "done" | "error";
  error: string | null;
  outcome: import("../worker/types").TargetedNanoporeOutcome | null;
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
}

export const TARGETED_USER_DEFAULTS: TargetedCallingSettings = {
  minReadQ: 10,
  minReferenceCoverage: 0.9,
  minAlignmentIdentity: 0.85,
  minProtectedIdentity: 0.95,
  maxProtectedIndelBases: 30,
  minTargetBaseQ: 15,
  minInputCountToScore: 10,
};

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeRound(round: number): TargetedRoundForm {
  return { id: uid("round"), round, files: [] };
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
  addRound: () => set({ rounds: [...get().rounds, makeRound(get().rounds.length)], qcLocked: false }),
  removeRound: (id) => set({ rounds: renumber(get().rounds.filter((r) => r.id !== id)), qcLocked: false }),
  addLocalFiles: (roundId, files) => set({
    rounds: get().rounds.map((r) => r.id === roundId ? {
      ...r,
      files: [...r.files, ...files.map((file) => ({ id: uid("local"), file, driveRef: null }))],
    } : r),
    qcLocked: false,
  }),
  addDriveFiles: (roundId, files) => set({
    rounds: get().rounds.map((r) => r.id === roundId ? {
      ...r,
      files: [...r.files, ...files.map((driveRef) => ({ id: `drive_${driveRef.id}`, file: null, driveRef }))],
    } : r),
    qcLocked: false,
  }),
  removeSource: (roundId, sourceId) => set({
    rounds: get().rounds.map((r) => r.id === roundId ? { ...r, files: r.files.filter((f) => f.id !== sourceId) } : r),
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
  runState: { status: "idle", error: null, outcome: null },
  setRunState: (patch) => set({ runState: { ...get().runState, ...patch } }),
}));

export function targetedInputErrors(state: Pick<TargetedNanoporeState,
  "projectName" | "rounds" | "referenceSeq" | "cdsStart" | "cdsEnd" | "sites"
>): string[] {
  const errors: string[] = [];
  if (!state.projectName.trim()) errors.push("Project name is required.");
  if (state.rounds.length < 2) errors.push("Round 0 and at least one selected round are required.");
  if (state.rounds.some((r, i) => r.round !== i)) errors.push("Rounds must be consecutive from Round 0.");
  if (state.rounds.some((r) => r.files.length === 0)) errors.push("Every round needs at least one FASTQ file.");
  const sourceKeys = state.rounds.flatMap((r) => r.files.map((f) => f.driveRef ? `d:${f.driveRef.id}` : `l:${f.file?.name}:${f.file?.size}`));
  if (new Set(sourceKeys).size !== sourceKeys.length) errors.push("The same FASTQ source cannot be assigned twice.");
  const reference = normalizeReference(state.referenceSeq);
  if (!reference) errors.push("Amplicon reference is required.");
  if (!Number.isInteger(state.cdsStart) || !Number.isInteger(state.cdsEnd) || state.cdsStart < 1 || state.cdsEnd > reference.length || state.cdsEnd < state.cdsStart) {
    errors.push("CDS start/end must define a valid interval inside the reference.");
  } else if ((state.cdsEnd - state.cdsStart + 1) % 3 !== 0) {
    errors.push("CDS length must be divisible by 3.");
  }
  try {
    resolveTargetSites(reference, state.sites.map((s) => ({ name: s.name, ntStart: s.ntStart, length: 3, design: "ANY" })));
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
    resolveTargetSites(state.referenceSeq, state.sites.map((s) => ({ name: s.name, ntStart: s.ntStart, length: 3, design: "ANY" })));
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
