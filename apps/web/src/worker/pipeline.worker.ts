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

// Worker-side console.log appears in DevTools under its own thread context;
// every `[worker]` line below shows up when DevTools → Console → "all
// contexts" is selected. This is the single source of truth when debugging
// a stuck pipeline — every long-running step gets logged on entry and exit.
function wlog(msg: string, extra?: unknown): void {
  if (extra !== undefined) {
    console.log(`[worker] ${msg}`, extra);
  } else {
    console.log(`[worker] ${msg}`);
  }
}

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

// Raw `message` listener BEFORE Comlink.expose — verifies that postMessage
// from the main thread is actually arriving at the worker. If this fires but
// `[worker] run() entered` doesn't, the message is reaching us but Comlink
// isn't dispatching it.
self.addEventListener("message", (event: MessageEvent) => {
  wlog("raw postMessage received", { dataType: typeof event.data, hasPort: event.ports.length });
});

wlog("module loaded — about to call Comlink.expose");

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
    const log = (m: string, extra?: unknown) => wlog(m, extra);

    try {
      log("run() entered", {
        localFiles: job.localFiles.length,
        driveFiles: job.driveFiles.length,
        rounds: job.rounds.length,
        useWasm: job.useWasm,
      });

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
      log(`constructed ${sources.length} sources`, sourceNames);

      let lastReportedSrc = -1;
      const wrappedProgress = (p: PipelineProgress) => {
        // Log when we cross into a new source so the user sees "starting file N"
        if (p.sourceIndex !== lastReportedSrc) {
          lastReportedSrc = p.sourceIndex;
          log(
            `source[${p.sourceIndex}] = ${sourceNames[p.sourceIndex]} — first progress event`,
          );
        }
        onProgress?.({
          sourceIndex: p.sourceIndex,
          fileName: sourceNames[p.sourceIndex] ?? "",
          bytesProcessed: p.bytesProcessed,
          totalBytes: p.totalBytes,
          recordsProcessed: p.recordsProcessed,
        });
      };

      log("calling runPipeline …");
      const result = await runPipeline({
        sources,
        rounds: job.rounds,
        settings: job.settings,
        useWasm: job.useWasm,
        onProgress: wrappedProgress,
      });
      log("runPipeline returned", {
        globalUnassigned: result.globalUnassigned,
        roundStats: Array.from(result.stats.entries()).map(([k, v]) => ({
          name: k,
          passed_qc: v.passed_qc,
        })),
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
      log(`csv length=${csv?.length ?? 0} → wrapped as Blob`);

      return {
        runStatsJson: result.runStatsJson,
        csvBlob,
        globalUnassigned: result.globalUnassigned,
        unassignedBreakdown: result.unassignedBreakdown,
        statsByRound,
        roundNames: job.rounds.map((r) => r.name),
      };
    } catch (e: unknown) {
      const err = e as Error;
      const msg = `worker run() threw: ${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`;
      console.error(`[worker] ${msg}`);
      throw e;
    }
  },
};

export type PipelineWorkerApi = typeof api;

try {
  Comlink.expose(api);
  wlog("Comlink.expose() returned successfully");
} catch (e: unknown) {
  console.error("[worker] Comlink.expose() threw:", e);
}

// Heartbeat: send a message every 2 seconds. If the main thread receives
// these but our raw listener never fires for inbound messages, the channel
// is one-way (Vercel bundling/isolation issue). If neither direction works,
// the worker is fully isolated from the main thread.
let heartbeatCount = 0;
setInterval(() => {
  heartbeatCount++;
  try {
    self.postMessage({ __heartbeat: heartbeatCount, ts: Date.now() });
  } catch (e) {
    console.error("[worker] heartbeat postMessage threw:", e);
  }
}, 2000);
wlog("heartbeat interval started (every 2s)");
