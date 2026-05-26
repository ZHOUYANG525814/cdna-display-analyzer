// Main-thread handle for the pipeline worker. One persistent worker per
// session — spinning a new worker per job costs ~50ms of WASM init time we
// don't want to repeat.

import * as Comlink from "comlink";
import type { PipelineWorkerApi } from "./pipeline.worker";
import type { PipelineJob, PipelineOutcome, PipelineProgressMsg } from "./types";

let workerInstance: Worker | null = null;
let api: Comlink.Remote<PipelineWorkerApi> | null = null;
let onErrorHandler: ((msg: string) => void) | null = null;

export function setWorkerErrorHandler(handler: (msg: string) => void): void {
  onErrorHandler = handler;
}

function ensureWorker(): Comlink.Remote<PipelineWorkerApi> {
  if (!api) {
    workerInstance = new Worker(
      new URL("./pipeline.worker.ts", import.meta.url),
      { type: "module", name: "cdna-pipeline" },
    );
    // Surface bundle / import failures to the UI; otherwise the user only
    // sees the progress bar stuck at 0% with no hint why.
    workerInstance.onerror = (e) => {
      const msg = `Worker error: ${e.message || "(no message)"} @ ${e.filename ?? "?"}:${e.lineno ?? "?"}`;
      console.error(msg, e);
      onErrorHandler?.(msg);
    };
    workerInstance.onmessageerror = (e) => {
      const msg = "Worker postMessage clone error — a value in the job/result is not structured-cloneable.";
      console.error(msg, e);
      onErrorHandler?.(msg);
    };
    // Heartbeat listener: see if the worker can send messages out at all.
    // Comlink wraps this same channel; if our own listener catches messages
    // but Comlink's calls hang, the issue is Comlink-specific.
    workerInstance.addEventListener("message", (e: MessageEvent) => {
      if (e.data && typeof e.data === "object" && "__heartbeat" in e.data) {
        const count = (e.data as { __heartbeat: number; ts: number }).__heartbeat;
        if (count <= 3) {
          // Log the first few then quiet down so the console isn't spammed.
          console.log("[main] heartbeat received from worker:", e.data);
        }
      }
    });
    api = Comlink.wrap<PipelineWorkerApi>(workerInstance);
  }
  return api;
}

export async function runInWorker(
  job: PipelineJob,
  onProgress?: (msg: PipelineProgressMsg) => void,
): Promise<PipelineOutcome> {
  const a = ensureWorker();

  // Diagnostic 1: confirm the job payload is structured-cloneable. If
  // postMessage of the same data throws DataCloneError, Comlink swallows
  // it and the await hangs — testing here surfaces the real reason.
  try {
    const cloned = structuredClone({
      localFiles: job.localFiles,
      driveFiles: job.driveFiles,
      rounds: job.rounds,
      settings: job.settings,
      useWasm: job.useWasm,
    });
    console.log("[main] structuredClone(job) succeeded", {
      clonedFiles: (cloned as { localFiles: File[] }).localFiles.length,
    });
  } catch (cloneErr) {
    console.error("[main] structuredClone(job) FAILED — this is why the worker is hung:", cloneErr);
  }

  // Diagnostic 2: send a raw ping via direct postMessage to verify the
  // basic worker channel works, separate from Comlink.
  if (workerInstance) {
    try {
      workerInstance.postMessage({ __ping: "from-main", ts: Date.now() });
      console.log("[main] raw ping postMessage sent to worker");
    } catch (pingErr) {
      console.error("[main] raw ping postMessage FAILED:", pingErr);
    }
  }

  // Comlink.proxy lets the worker call back into our progress handler.
  const progress = onProgress ? Comlink.proxy(onProgress) : undefined;
  console.log("[main] runInWorker → calling worker.run() …", {
    localFiles: job.localFiles.length,
    driveFiles: job.driveFiles.length,
    hasProgress: !!progress,
  });
  // Watchdog: if the await hasn't resolved/rejected in 10 seconds, scream.
  // This tells us the RPC is hanging vs. genuinely processing a big file.
  const watchdog = setTimeout(() => {
    console.warn(
      "[main] runInWorker watchdog: 10s elapsed and worker.run() has neither " +
        "resolved nor thrown. This means the Comlink RPC is hung — the worker " +
        "either never received the message or never sent a response.",
    );
  }, 10_000);
  try {
    const result = await a.run(job, progress);
    clearTimeout(watchdog);
    console.log("[main] runInWorker ← worker.run() returned");
    return result;
  } catch (err) {
    clearTimeout(watchdog);
    console.error("[main] runInWorker ← worker.run() threw", err);
    throw err;
  }
}

export function terminateWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    api = null;
  }
}
