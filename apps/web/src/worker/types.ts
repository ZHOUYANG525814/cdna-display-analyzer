// Wire types crossing the worker boundary. Two important constraints:
//   - Everything must be structurally cloneable (no functions, no class
//     instances with methods — File / Uint8Array / plain objects only).
//   - Maps come back from the pipeline; we flatten them to plain records
//     before crossing so the main thread doesn't need to know about the
//     worker-side internal shapes.

import type {
  RoundConfigInput,
  DemultiplexSettings,
  RoundStats,
  UnassignedBreakdown,
  NanoporeAnalyzerRow,
  NanoporeGlobalBreakdown,
  NanoporeRoundStats,
  NanoporeSettings,
  TargetedRoundRunStats,
  TargetedFileStats,
  TargetedPipelineSettings,
} from "@cdna/core";

export interface DriveFileRef {
  id: string;
  name: string;
  sizeBytes: number | null;
}

export interface PipelineJob {
  localFiles: File[];
  driveFiles: DriveFileRef[];
  /** OAuth bearer for Drive fetches. Required iff driveFiles is non-empty. */
  driveToken?: string;
  rounds: RoundConfigInput[];
  settings: DemultiplexSettings;
  useWasm: boolean;
  /** Pipeline mode. "multiplexed" preserves the historical demultiplex-by-
   *  barcode behaviour. "per-round" requires `sourceRoundIndices` and tells
   *  the worker to score each file's reads only against its bound round. */
  mode?: "multiplexed" | "per-round";
  /** In per-round mode, parallel array to `localFiles` followed by `driveFiles`
   *  giving the round index (into `rounds`) each source is bound to. */
  sourceRoundIndices?: number[];
}

export interface PipelineProgressMsg {
  sourceIndex: number;
  fileName: string;
  bytesProcessed: number;
  totalBytes: number | null;
  recordsProcessed: number;
}

/** Run-log line emitted from inside the worker. The main thread appends each
 *  one to the UI terminal (Phase 6.13). `tag` chooses the line colour
 *  (info / success / warning / error). */
export interface PipelineLogMsg {
  text: string;
  tag: "info" | "success" | "warning" | "error";
}

// Serializable pipeline outcome. Maps in core/PipelineResult become plain
// objects keyed by round name; counter Maps are stripped (consumers can
// re-derive any per-DNA stats from the CSV).
//
// `csvBlob` is a Blob (structured-cloneable by reference across postMessage,
// not by deep copy) rather than a raw string — for large diverse libraries
// the CSV can be tens of MB, and Blob avoids freezing the main thread on
// the clone. Use `await csvBlob.text()` on the main thread to read it back.
export interface PipelineOutcome {
  runStatsJson: string;
  csvBlob: Blob | null;
  globalUnassigned: number;
  unassignedBreakdown: UnassignedBreakdown;
  statsByRound: Record<string, RoundStats>;
  roundNames: string[];
  /** Library median of `Enrich_Global_<round>_vs_<first>` for each non-first
   *  round. Used by the MethodsCard on Results to surface dropout-regime
   *  warnings (median far from zero ⇒ Centered_Enrich may over-correct). */
  libraryMedianEnrich: Record<string, number>;
  /** Hit counts at standard FDR thresholds per comparison. Populated by the
   *  worker so the Results page can render headline counts without
   *  re-parsing the CSV. */
  hitCounts: Array<{ label: string; q05: number; q01: number; total: number }>;
}

// --- Nanopore SSM tool ---------------------------------------------------

/** Wire-shape of a Nanopore site config. Anchors as plain ASCII strings so
 *  the worker can encode them once it owns them. */
export interface NanoporeSiteWire {
  name: string;
  fwAnchor: string;
  rvAnchor: string;
}

/** Wire-shape of one round. Multiplexed mode includes a barcode prefix;
 *  per-round mode omits it (source binding does the discrimination). */
export interface NanoporeRoundWire {
  name: string;
  barcode?: string;
}

export interface NanoporeJob {
  localFiles: File[];
  driveFiles: DriveFileRef[];
  /** OAuth bearer for Drive fetches. Required iff driveFiles is non-empty. */
  driveToken?: string;
  /** WT amplicon DNA spanning all sites — the engine uses regions matching
   *  this exactly as the WT baseline + computes WT ROI per site from it. */
  reference: string;
  sites: NanoporeSiteWire[];
  rounds: NanoporeRoundWire[];
  /** Partial override of NANOPORE_DEFAULT_SETTINGS. Anything omitted keeps
   *  the defaults: read Q≥10, ROI Q≥15, maxSubs=2, maxIndels=1, etc. */
  settings?: Partial<NanoporeSettings>;
  mode?: "multiplexed" | "per-round";
  /** In per-round mode, parallel array to localFiles ++ driveFiles giving
   *  the round index each source is bound to. */
  sourceRoundIndices?: number[];
  useWasm: boolean;
}

/** Serialisable Nanopore outcome. Like the cDNA outcome, large strings
 *  (the CSVs) are wrapped in Blobs so postMessage doesn't deep-copy
 *  potentially-MB payloads. Maps from the engine are flattened to records. */
export interface NanoporeOutcome {
  /** enrichment_per_site.csv as a Blob. */
  perSiteCsvBlob: Blob | null;
  /** enrichment_haplotype.csv as a Blob (null when no haplotype data). */
  haplotypeCsvBlob: Blob | null;
  /** First 200 per-site rows for instant top-N display without re-parsing
   *  the CSV. Same shape as core's NanoporeAnalyzerRow. */
  perSiteRowsPreview: NanoporeAnalyzerRow[];
  /** First 200 haplotype rows. Empty when haplotype output is disabled. */
  haplotypeRowsPreview: NanoporeAnalyzerRow[];
  /** Per-round stats including per-site sub-counters + haplotype_passed_qc. */
  statsByRound: Record<string, NanoporeRoundStats>;
  globalBreakdown: NanoporeGlobalBreakdown;
  roundNames: string[];
  siteNames: string[];
  /** Site name → resolved WT DNA (the inter-anchor reference slice). Used
   *  by the UI to badge the WT row in variant tables. */
  resolvedWtBySite: Record<string, string>;
  /** Site name → expected ROI length. Used by the UI for verification text. */
  expectedRoiLenBySite: Record<string, number>;
  /** Library median Fitness_vs_WT, keyed as "<siteName>:<round>" for per-site
   *  medians and "__haplotype__:<round>" for haplotype-level medians.
   *  Surfaced for the Methods card's dropout diagnostic. */
  libraryMedianFitness: Record<string, number>;
  /** Hit counts at standard FDR thresholds per (site, round) for the
   *  Methods card. Same shape as the cDNA version. */
  hitCounts: Array<{ label: string; q05: number; q01: number; total: number }>;
}

// --- Targeted full-amplicon Nanopore tool -------------------------------

export interface TargetedNanoporeJob {
  localFiles: File[];
  driveFiles: DriveFileRef[];
  driveToken?: string;
  /** Parallel to localFiles ++ driveFiles. */
  sourceRoundIndices: number[];
  roundNames: string[];
  reference: string;
  sites: Array<{ name: string; ntStart: number; length: 3; design: "NNK" }>;
  settings: TargetedPipelineSettings;
}

export interface TargetedNanoporeOutcome {
  perSiteCsvBlob: Blob | null;
  haplotypeCsvBlob: Blob | null;
  perSiteRowsPreview: NanoporeAnalyzerRow[];
  haplotypeRowsPreview: NanoporeAnalyzerRow[];
  statsByRound: Record<string, TargetedRoundRunStats>;
  fileStats: TargetedFileStats[];
  roundNames: string[];
  siteNames: string[];
  wtBySite: Record<string, string>;
  libraryMedianFitness: Record<string, number>;
}
