import * as Comlink from "comlink";
import type { TargetedNanoporeWorkerApi } from "./targeted-nanopore.worker";
import type {
  PipelineLogMsg,
  PipelineProgressMsg,
  TargetedNanoporeJob,
  TargetedNanoporeOutcome,
} from "./types";
import { createWorkerHandle } from "./workerHandle";
import { recordTelemetry } from "../lib/telemetry";

const handle = createWorkerHandle<TargetedNanoporeWorkerApi>("nanopore-targeted", () =>
  new Worker(new URL("./targeted-nanopore.worker.ts", import.meta.url), {
    type: "module",
    name: "targeted-nanopore-pipeline",
  }),
);

export function setTargetedWorkerErrorHandler(handler: (message: string) => void): void {
  handle.setErrorHandler(handler);
}

export async function runInTargetedNanoporeWorker(
  job: TargetedNanoporeJob,
  onProgress?: (message: PipelineProgressMsg) => void,
  onLog?: (message: PipelineLogMsg) => void,
  refreshDriveToken?: () => Promise<string>,
): Promise<TargetedNanoporeOutcome> {
  const startedAt = performance.now();
  try {
    const api = await handle.getApi();
    const outcome = await api.run(
      job,
      onProgress ? Comlink.proxy(onProgress) : undefined,
      onLog ? Comlink.proxy(onLog) : undefined,
      refreshDriveToken ? Comlink.proxy(refreshDriveToken) : undefined,
    );
    recordTelemetry({ toolId: "nanopore-targeted", phase: "pipeline-total", status: "ok", startedAt, durationMs: performance.now() - startedAt });
    return outcome;
  } catch (error) {
    recordTelemetry({ toolId: "nanopore-targeted", phase: "pipeline-total", status: "error", startedAt, durationMs: performance.now() - startedAt });
    throw error;
  }
}

export function terminateTargetedNanoporeWorker(): void { handle.terminate(); }
export async function initializeTargetedNanoporeWorker(): Promise<void> { await handle.getApi(); }
