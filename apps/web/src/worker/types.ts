// Wire types crossing the worker boundary. Two important constraints:
//   - Everything must be structurally cloneable (no functions, no class
//     instances with methods — File / Uint8Array / plain objects only).
//   - Maps come back from the pipeline; we flatten them to plain records
//     before crossing so the main thread doesn't need to know about the
//     worker-side internal shapes.

import type { RoundConfigInput, DemultiplexSettings, RoundStats, UnassignedBreakdown } from "@cdna/core";

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
}

export interface PipelineProgressMsg {
  sourceIndex: number;
  fileName: string;
  bytesProcessed: number;
  totalBytes: number | null;
  recordsProcessed: number;
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
}
