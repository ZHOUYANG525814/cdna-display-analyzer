import * as Comlink from "comlink";
import { recordTelemetry } from "../lib/telemetry";

export interface WorkerHandle<T extends object> {
  getApi(): Promise<Comlink.Remote<T>>;
  setErrorHandler(handler: (message: string) => void): void;
  terminate(): void;
}

/** Owns one lazy module worker and its ready handshake. Each analysis tool
 * gets a separate handle, so loading/cancelling one tool cannot initialize or
 * terminate another tool's code. */
export function createWorkerHandle<T extends object>(
  toolId: string,
  createWorker: () => Worker,
): WorkerHandle<T> {
  let worker: Worker | null = null;
  let api: Comlink.Remote<T> | null = null;
  let ready: Promise<void> | null = null;
  let errorHandler: ((message: string) => void) | null = null;

  const ensure = (): void => {
    if (worker && api && ready) return;
    const startedAt = performance.now();
    performance.mark(`worker:${toolId}:create`);
    worker = createWorker();
    api = Comlink.wrap<T>(worker);
    ready = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error(`${toolId} worker failed to signal ready within 30 seconds.`));
      }, 30_000);
      const onReady = (event: MessageEvent) => {
        if (!event.data || typeof event.data !== "object" || !event.data.__ready) return;
        window.clearTimeout(timeout);
        worker?.removeEventListener("message", onReady);
        const durationMs = performance.now() - startedAt;
        performance.mark(`worker:${toolId}:ready`);
        performance.measure(
          `worker:${toolId}:initialization`,
          `worker:${toolId}:create`,
          `worker:${toolId}:ready`,
        );
        window.dispatchEvent(new CustomEvent("cdna:worker-ready", {
          detail: { toolId, durationMs, workerTs: event.data.ts ?? null },
        }));
        recordTelemetry({
          toolId,
          phase: "worker-initialization",
          status: "ok",
          startedAt,
          durationMs,
          detail: { workerTs: event.data.ts ?? null },
        });
        resolve();
      };
      worker!.addEventListener("message", onReady);
    });
    worker.onerror = (event) => {
      const message =
        `Worker error: ${event.message || "(no message)"} @ ` +
        `${event.filename || "?"}:${event.lineno || "?"}`;
      errorHandler?.(message);
    };
    worker.onmessageerror = () => {
      errorHandler?.("Worker postMessage clone error: the job or result is not cloneable.");
    };
  };

  return {
    async getApi() {
      ensure();
      await ready;
      return api!;
    },
    setErrorHandler(handler) {
      errorHandler = handler;
    },
    terminate() {
      worker?.terminate();
      worker = null;
      api = null;
      ready = null;
    },
  };
}
