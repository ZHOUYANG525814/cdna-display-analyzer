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
    api = Comlink.wrap<PipelineWorkerApi>(workerInstance);
  }
  return api;
}

export async function runInWorker(
  job: PipelineJob,
  onProgress?: (msg: PipelineProgressMsg) => void,
): Promise<PipelineOutcome> {
  const a = ensureWorker();
  // Comlink.proxy lets the worker call back into our progress handler.
  const progress = onProgress ? Comlink.proxy(onProgress) : undefined;
  return await a.run(job, progress);
}

export function terminateWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    api = null;
  }
}
