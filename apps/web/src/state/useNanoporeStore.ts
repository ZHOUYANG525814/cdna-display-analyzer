// Nanopore-SSM wizard state. Mirrors the cDNA tool's wizard shape but with
// inputs tuned for dual-anchor extraction at multiple independent saturation
// sites (typical: 1 site for single-codon SSM, 2+ sites for distant double-site
// SSM where Nanopore's long reads can span both sites in one read).
//
// Two pipeline modes:
//   - multiplexed: one or more shared FASTQs; each round is identified by a
//     short barcode prefix at the 5' end of the read. The barcode binds the
//     whole read to a round; sites inside the read are then extracted with
//     their own anchor pairs.
//   - per-round: each round owns its own FASTQ; no barcode needed because
//     file binding does the round discrimination.
//
// Multi-site model: each "site" is an independent anchor-bounded variable
// region. The engine (Phase 6.2+) scans every read for every site. Per-site
// counts go to a per-site CSV; when ≥2 sites are configured, the engine ALSO
// emits a linked-haplotype CSV where each row is a combined-codon string like
// "GCT_TGG" — only counted when ALL sites extract cleanly from the same read.
// Haplotype counts are what enable epistasis analysis on long-read data.

import { create } from "zustand";
import type {
  DriveFileRef,
  NanoporeOutcome,
  PipelineProgressMsg,
} from "../worker/types";
export type { DriveFileRef, NanoporeOutcome };

export type NanoporeRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface NanoporeLogEntry {
  ts: number;
  tag: "info" | "success" | "warning" | "error";
  msg: string;
}

export const NANOPORE_STEPS = ["sources", "configure", "preview", "run", "results"] as const;
export type NanoporeStepId = (typeof NANOPORE_STEPS)[number];

export type NanoporePipelineMode = "multiplexed" | "per-round";

export interface NanoporeSite {
  id: string;
  name: string;          // user-friendly label like "site_K417" or "site_1"
  fwAnchor: string;      // upstream flank for THIS site (12–30 bp)
  rvAnchor: string;      // downstream flank for THIS site (12–30 bp)
}

export interface NanoporeRoundForm {
  id: string;
  name: string;
  /** Multiplexed mode: 3–12 bp barcode prefix at the 5' end of the read.
   *  Per-round mode: empty (file binding does the discrimination). */
  barcode: string;
  /** Per-round mode: this round's FASTQ. Multiplexed mode: null. */
  file: File | null;
  /** Per-round mode: this round's Drive FASTQ. Multiplexed mode: null. */
  driveRef: DriveFileRef | null;
}

function makeSite(idx: number): NanoporeSite {
  return {
    id: `site_${idx}_${Math.random().toString(36).slice(2, 8)}`,
    name: `site_${idx + 1}`,
    fwAnchor: "",
    rvAnchor: "",
  };
}

function makeRound(idx: number): NanoporeRoundForm {
  return {
    id: `np_${idx}_${Math.random().toString(36).slice(2, 8)}`,
    name: `Round_${idx}`,
    barcode: "",
    file: null,
    driveRef: null,
  };
}

interface NanoporeState {
  // Navigation
  currentStep: NanoporeStepId;
  setStep: (s: NanoporeStepId) => void;
  goNext: () => void;
  goPrev: () => void;

  // Sources
  projectName: string;
  setProjectName: (s: string) => void;
  pipelineMode: NanoporePipelineMode;
  setPipelineMode: (m: NanoporePipelineMode) => void;
  localFiles: File[];          // multiplexed mode only
  driveFiles: DriveFileRef[];  // multiplexed mode only
  setLocalFiles: (fs: File[]) => void;
  setDriveFiles: (fs: DriveFileRef[]) => void;
  clearAllFiles: () => void;

  // Configuration (shared across rounds)
  referenceSeq: string;
  setReferenceSeq: (s: string) => void;
  sites: NanoporeSite[];
  setSites: (sites: NanoporeSite[]) => void;
  addSite: () => void;
  removeSite: (id: string) => void;
  updateSite: (id: string, patch: Partial<NanoporeSite>) => void;

  // Per-round form
  rounds: NanoporeRoundForm[];
  setRounds: (rs: NanoporeRoundForm[]) => void;
  addRound: () => void;
  removeRound: (id: string) => void;
  updateRound: (id: string, patch: Partial<NanoporeRoundForm>) => void;

  // Output options
  reportHaplotype: boolean;
  setReportHaplotype: (v: boolean) => void;

  // Advanced QC (defaults baked in for SUP R10.4)
  minMeanPhredRead: number;
  setMinMeanPhredRead: (v: number) => void;
  minMeanPhredRoi: number;
  setMinMeanPhredRoi: (v: number) => void;
  pseudocount: number;
  setPseudocount: (v: number) => void;

  // Run state — populated when the engine actually runs.
  status: NanoporeRunStatus;
  setStatus: (s: NanoporeRunStatus) => void;
  progress: PipelineProgressMsg | null;
  setProgress: (p: PipelineProgressMsg | null) => void;
  perSourceBytes: Record<number, number>;
  setSourceBytes: (sourceIdx: number, bytes: number) => void;
  startedAt: number | null;
  finishedAt: number | null;
  setTiming: (startedAt: number | null, finishedAt: number | null) => void;
  log: NanoporeLogEntry[];
  appendLog: (entry: NanoporeLogEntry) => void;
  clearLog: () => void;
  outcome: NanoporeOutcome | null;
  setOutcome: (o: NanoporeOutcome | null) => void;
  errorMessage: string | null;
  setErrorMessage: (m: string | null) => void;
  resetRun: () => void;
  resetAll: () => void;
}

export const useNanoporeStore = create<NanoporeState>((set, get) => ({
  currentStep: "sources",
  setStep: (s) => set({ currentStep: s }),
  goNext: () => {
    const i = NANOPORE_STEPS.indexOf(get().currentStep);
    if (i >= 0 && i < NANOPORE_STEPS.length - 1) set({ currentStep: NANOPORE_STEPS[i + 1]! });
  },
  goPrev: () => {
    const i = NANOPORE_STEPS.indexOf(get().currentStep);
    if (i > 0) set({ currentStep: NANOPORE_STEPS[i - 1]! });
  },

  projectName: "",
  setProjectName: (s) => set({ projectName: s }),
  pipelineMode: "per-round",
  setPipelineMode: (m) => set({ pipelineMode: m }),
  localFiles: [],
  driveFiles: [],
  setLocalFiles: (fs) => set({ localFiles: fs }),
  setDriveFiles: (fs) => set({ driveFiles: fs }),
  clearAllFiles: () => set({ localFiles: [], driveFiles: [] }),

  referenceSeq: "",
  setReferenceSeq: (s) => set({ referenceSeq: s }),
  sites: [makeSite(0)],
  setSites: (sites) => set({ sites }),
  addSite: () => {
    const ss = get().sites;
    set({ sites: [...ss, makeSite(ss.length)] });
  },
  removeSite: (id) => set({ sites: get().sites.filter((s) => s.id !== id) }),
  updateSite: (id, patch) =>
    set({ sites: get().sites.map((s) => (s.id === id ? { ...s, ...patch } : s)) }),

  rounds: [makeRound(0), makeRound(1)],
  setRounds: (rs) => set({ rounds: rs }),
  addRound: () => {
    const rs = get().rounds;
    set({ rounds: [...rs, makeRound(rs.length)] });
  },
  removeRound: (id) => set({ rounds: get().rounds.filter((r) => r.id !== id) }),
  updateRound: (id, patch) =>
    set({ rounds: get().rounds.map((r) => (r.id === id ? { ...r, ...patch } : r)) }),

  reportHaplotype: true,
  setReportHaplotype: (v) => set({ reportHaplotype: v }),

  minMeanPhredRead: 10,
  setMinMeanPhredRead: (v) => set({ minMeanPhredRead: v }),
  minMeanPhredRoi: 15,
  setMinMeanPhredRoi: (v) => set({ minMeanPhredRoi: v }),
  pseudocount: 0.5,
  setPseudocount: (v) => set({ pseudocount: v }),

  status: "idle",
  setStatus: (s) => set({ status: s }),
  progress: null,
  setProgress: (p) => set({ progress: p }),
  perSourceBytes: {},
  setSourceBytes: (sourceIdx, bytes) =>
    set({ perSourceBytes: { ...get().perSourceBytes, [sourceIdx]: bytes } }),
  startedAt: null,
  finishedAt: null,
  setTiming: (startedAt, finishedAt) => set({ startedAt, finishedAt }),
  log: [],
  appendLog: (entry) => set({ log: [...get().log, entry] }),
  clearLog: () => set({ log: [] }),
  outcome: null,
  setOutcome: (o) => set({ outcome: o }),
  errorMessage: null,
  setErrorMessage: (m) => set({ errorMessage: m }),
  resetRun: () =>
    set({
      status: "idle",
      progress: null,
      perSourceBytes: {},
      startedAt: null,
      finishedAt: null,
      log: [],
      outcome: null,
      errorMessage: null,
    }),
  resetAll: () =>
    set({
      currentStep: "sources",
      projectName: "",
      pipelineMode: "per-round",
      localFiles: [],
      driveFiles: [],
      referenceSeq: "",
      sites: [makeSite(0)],
      rounds: [makeRound(0), makeRound(1)],
      reportHaplotype: true,
      minMeanPhredRead: 10,
      minMeanPhredRoi: 15,
      pseudocount: 0.5,
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

// --- Selectors / validation ----------------------------------------------

/** True when the Sources step has everything it needs to enable Continue. */
export function canContinueFromSources(s: NanoporeState): boolean {
  if (!s.projectName.trim()) return false;
  if (s.pipelineMode === "multiplexed") {
    return s.localFiles.length + s.driveFiles.length > 0;
  }
  // per-round: file binding happens on Configure
  return true;
}

/** True when the Configure step is complete enough to preview. */
export function canContinueFromConfigure(s: NanoporeState): boolean {
  if (s.referenceSeq.replace(/\s/g, "").length < 30) return false;
  if (s.sites.length === 0) return false;
  for (const site of s.sites) {
    if (!site.name.trim()) return false;
    if (site.fwAnchor.replace(/\s/g, "").length < 12) return false;
    if (site.rvAnchor.replace(/\s/g, "").length < 12) return false;
  }
  if (s.rounds.length === 0) return false;
  for (const r of s.rounds) {
    if (!r.name.trim()) return false;
    if (s.pipelineMode === "multiplexed") {
      if (r.barcode.replace(/\s/g, "").length < 3) return false;
    } else {
      if (r.file == null && r.driveRef == null) return false;
    }
  }
  if (s.pipelineMode === "multiplexed") {
    const seen = new Set<string>();
    for (const r of s.rounds) {
      const b = r.barcode.toUpperCase();
      if (seen.has(b)) return false;
      seen.add(b);
    }
  }
  return true;
}

export interface SiteAlignment {
  ok: boolean;
  fwStart: number;
  rvStart: number;
  roiLen: number;
  message?: string;
}

/** Per-site exact-match alignment used by the Preview step. The engine itself
 *  uses banded alignment so it tolerates Nanopore-class indels in the anchors;
 *  Preview is just a sanity check that the design is consistent (anchors
 *  exist in the reference, in order, with a non-zero ROI between them).
 *
 *  IMPORTANT: this is a PURE function taking primitive inputs, not a Zustand
 *  selector. Calling it as `useNanoporeStore(findAllSitesInReference)` would
 *  return a new object on every store update and trip Zustand v5's
 *  getSnapshot-must-be-cached check, which manifests as a blank page on the
 *  next step transition. Consumers must wrap it in useMemo with the relevant
 *  state slices as dependencies — see ConfigureStep / PreviewStep. */
export function findAllSitesInReference(
  inputSites: ReadonlyArray<NanoporeSite>,
  referenceSeq: string,
): { ref: string; sites: SiteAlignment[]; refError: string | null; overlapError: string | null } {
  const ref = referenceSeq.replace(/[^ACGTNacgtn]/g, "").toUpperCase();
  if (ref.length < 30) {
    return { ref, sites: [], refError: "Reference is too short (< 30 bp).", overlapError: null };
  }
  const sites: SiteAlignment[] = [];
  const ranges: { id: string; start: number; end: number }[] = [];
  for (const site of inputSites) {
    const fw = site.fwAnchor.replace(/\s/g, "").toUpperCase();
    const rv = site.rvAnchor.replace(/\s/g, "").toUpperCase();
    if (fw.length < 12 || rv.length < 12) {
      sites.push({ ok: false, fwStart: -1, rvStart: -1, roiLen: 0, message: "Anchor too short (< 12 bp)." });
      continue;
    }
    const fwStart = ref.indexOf(fw);
    if (fwStart < 0) {
      sites.push({ ok: false, fwStart: -1, rvStart: -1, roiLen: 0, message: "Upstream anchor not found in reference." });
      continue;
    }
    const rvStart = ref.indexOf(rv, fwStart + fw.length);
    if (rvStart < 0) {
      sites.push({ ok: false, fwStart, rvStart: -1, roiLen: 0, message: "Downstream anchor not found downstream of the upstream anchor." });
      continue;
    }
    const roiLen = rvStart - (fwStart + fw.length);
    let message: string | undefined;
    if (roiLen <= 0) {
      sites.push({ ok: false, fwStart, rvStart, roiLen, message: "Downstream anchor overlaps the upstream anchor." });
      continue;
    }
    if (roiLen % 3 !== 0) {
      message = `ROI is ${roiLen} bp — not divisible by 3, so it won't translate cleanly.`;
    }
    sites.push({ ok: true, fwStart, rvStart, roiLen, ...(message ? { message } : {}) });
    ranges.push({ id: site.id, start: fwStart, end: rvStart + rv.length });
  }

  // Overlap check across sites — anchor ranges can't intersect, otherwise the
  // engine has no way to know which site a given byte belongs to.
  let overlapError: string | null = null;
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.start < ranges[i - 1]!.end) {
      overlapError = "Two or more sites' anchor regions overlap in the reference. Sites must be non-overlapping.";
      break;
    }
  }

  return { ref, sites, refError: null, overlapError };
}
