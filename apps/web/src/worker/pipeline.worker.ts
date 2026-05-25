// Comlink-exposed worker module. Vite picks this up via the
//   new Worker(new URL("./pipeline.worker.ts", import.meta.url), { type: "module" })
// invocation in workerClient.ts.
//
// We deliberately construct LocalFastqSource on the worker side so the File
// objects (which are structured-cloneable) cross only once, and the streaming
// reads never have to cross the boundary.

import * as Comlink from "comlink";
import { runPipeline, type PipelineProgress } from "@cdna/core";
import type { IAuthProvider, IFastqSource } from "@cdna/types";
import { LocalFastqSource } from "../adapters/LocalFastqSource";
import { DriveFastqSource } from "../adapters/DriveFastqSource";
import type { PipelineJob, PipelineProgressMsg, PipelineOutcome } from "./types";

// Stub auth provider for the worker side: the main thread fetched a token
// before submitting the job, so we just hand that back. If the token expires
// mid-pipeline we surface the error and the user re-runs (token refresh
// across the worker boundary is a Phase 4+ concern).
function staticAuth(token: string): IAuthProvider {
  return {
    async signIn() {},
    async signOut() {},
    async getToken() {
      return token;
    },
    isSignedIn() {
      return true;
    },
  };
}

const api = {
  /**
   * Run the pipeline on a mix of local files and Drive files. The progress
   * callback is a Comlink proxy; calling it sends a structured-clone message
   * back to the main thread (one per ~64k records — see core/src/pipeline.ts).
   */
  async run(
    job: PipelineJob,
    onProgress?: (msg: PipelineProgressMsg) => void,
  ): Promise<PipelineOutcome> {
    if (job.driveFiles.length > 0 && !job.driveToken) {
      throw new Error("Drive files specified but no OAuth token attached to the job.");
    }
    const auth = job.driveToken ? staticAuth(job.driveToken) : null;

    // Local files come first, then Drive files. Source-index ordering matches
    // the UI display so progress events point at the right name.
    const sources: IFastqSource[] = [
      ...job.localFiles.map((f) => new LocalFastqSource(f)),
      ...job.driveFiles.map((d) =>
        new DriveFastqSource({ id: d.id, name: d.name, sizeBytes: d.sizeBytes }, auth!),
      ),
    ];
    const sourceNames = [
      ...job.localFiles.map((f) => f.name),
      ...job.driveFiles.map((d) => d.name),
    ];

    const wrappedProgress = onProgress
      ? (p: PipelineProgress) => {
          onProgress({
            sourceIndex: p.sourceIndex,
            fileName: sourceNames[p.sourceIndex] ?? "",
            bytesProcessed: p.bytesProcessed,
            totalBytes: p.totalBytes,
            recordsProcessed: p.recordsProcessed,
          });
        }
      : undefined;

    const result = await runPipeline({
      sources,
      rounds: job.rounds,
      settings: job.settings,
      useWasm: job.useWasm,
      ...(wrappedProgress ? { onProgress: wrappedProgress } : {}),
    });

    // Flatten Maps → plain records so the postMessage clone succeeds.
    const statsByRound: Record<string, ReturnType<typeof result.stats.get> & {}> = {};
    for (const [name, stat] of result.stats) {
      statsByRound[name] = stat;
    }

    // Wrap the CSV in a Blob so postMessage doesn't deep-copy it. Blobs are
    // structured-cloneable but cross by reference, not value — this matters
    // when the CSV is tens of MB.
    const csv = result.analyzer?.csv;
    const csvBlob = csv ? new Blob([csv], { type: "text/csv" }) : null;

    return {
      runStatsJson: result.runStatsJson,
      csvBlob,
      globalUnassigned: result.globalUnassigned,
      unassignedBreakdown: result.unassignedBreakdown,
      statsByRound,
      roundNames: job.rounds.map((r) => r.name),
    };
  },
};

export type PipelineWorkerApi = typeof api;

Comlink.expose(api);
