// Main-thread handle for the pipeline worker. One persistent worker per
// session — spinning a new worker per job costs ~50ms of WASM init time we
// don't want to repeat.

import * as Comlink from "comlink";
import type { PipelineWorkerApi } from "./pipeline.worker";
import type {
  StreamCsvOptions,
  StreamCsvResult,
} from "../tools/cdna-display/viz/csvParse";
import type {
  NanoporeJob,
  NanoporeOutcome,
  TargetedNanoporeJob,
  TargetedNanoporeOutcome,
  PipelineJob,
  PipelineLogMsg,
  PipelineOutcome,
  PipelineProgressMsg,
} from "./types";

let workerInstance: Worker | null = null;
let api: Comlink.Remote<PipelineWorkerApi> | null = null;
let workerReady: Promise<void> | null = null;
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

    // CRITICAL: module workers with top-level await silently drop messages
    // sent during the worker's TLA suspension (a Chrome quirk that has
    // bitten this project in production). The worker posts `{__ready: true}`
    // after Comlink.expose; we hold `workerReady` until then so the first
    // RPC call doesn't go out into the void.
    workerReady = new Promise<void>((resolve, reject) => {
      const onReady = (e: MessageEvent) => {
        if (e.data && typeof e.data === "object" && (e.data as { __ready?: boolean }).__ready) {
          console.log("[main] worker signalled __ready — RPC channel is live");
          workerInstance!.removeEventListener("message", onReady);
          resolve();
        }
      };
      workerInstance!.addEventListener("message", onReady);
      // Timeout so a permanently-dead worker doesn't hang the UI forever.
      setTimeout(() => {
        if (workerReady) {
          reject(new Error("Worker failed to signal __ready within 15 seconds"));
        }
      }, 15_000);
    });

    api = Comlink.wrap<PipelineWorkerApi>(workerInstance);
  }
  return api;
}

export async function runInWorker(
  job: PipelineJob,
  onProgress?: (msg: PipelineProgressMsg) => void,
  onLog?: (msg: PipelineLogMsg) => void,
): Promise<PipelineOutcome> {
  const a = ensureWorker();

  // Wait for the worker to signal __ready before sending the call. Without
  // this, the worker's TLA suspension causes Chrome to silently drop the
  // first postMessage, hanging the RPC forever.
  console.log("[main] waiting for worker __ready …");
  await workerReady;
  console.log("[main] worker is ready — sending run() call");

  // Comlink.proxy lets the worker call back into our progress + log handlers.
  const progress = onProgress ? Comlink.proxy(onProgress) : undefined;
  const log = onLog ? Comlink.proxy(onLog) : undefined;
  try {
    const result = await a.run(job, progress, log);
    console.log("[main] worker.run() returned");
    return result;
  } catch (err) {
    console.error("[main] worker.run() threw", err);
    throw err;
  }
}

/** Same as `runInWorker` but routes to the Nanopore SSM pipeline inside the
 *  worker. Same persistent worker instance; same __ready handshake. */
export async function runNanoporeInWorker(
  job: NanoporeJob,
  onProgress?: (msg: PipelineProgressMsg) => void,
  onLog?: (msg: PipelineLogMsg) => void,
): Promise<NanoporeOutcome> {
  const a = ensureWorker();

  console.log("[main] (nanopore) waiting for worker __ready …");
  await workerReady;
  console.log("[main] (nanopore) worker is ready — sending runNanopore() call");

  const progress = onProgress ? Comlink.proxy(onProgress) : undefined;
  const log = onLog ? Comlink.proxy(onLog) : undefined;
  try {
    const result = await a.runNanopore(job, progress, log);
    console.log("[main] worker.runNanopore() returned");
    return result;
  } catch (err) {
    console.error("[main] worker.runNanopore() threw", err);
    throw err;
  }
}

export async function runTargetedNanoporeInWorker(
  job: TargetedNanoporeJob,
  onProgress?: (msg: PipelineProgressMsg) => void,
  onLog?: (msg: PipelineLogMsg) => void,
): Promise<TargetedNanoporeOutcome> {
  const a = ensureWorker();
  await workerReady;
  const progress = onProgress ? Comlink.proxy(onProgress) : undefined;
  const log = onLog ? Comlink.proxy(onLog) : undefined;
  return a.runTargetedNanopore(job, progress, log);
}

/** Parse the analyzer's CSV blob inside the worker so the streaming pass
 *  (multi-second on a 758 MB blob) doesn't freeze the main thread. Returns
 *  the same StreamCsvResult shape the legacy in-page parser produced. */
export async function parseCsvInWorker(
  blob: Blob,
  opts: StreamCsvOptions = {},
): Promise<StreamCsvResult> {
  const a = ensureWorker();
  await workerReady;
  return a.parseCsv(blob, opts);
}

export function terminateWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    api = null;
  }
}
