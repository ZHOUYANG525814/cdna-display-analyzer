import * as Comlink from "comlink";
import type { CdnaWorkerApi } from "./cdna.worker";
import type { StreamCsvOptions, StreamCsvResult } from "../tools/cdna-display/viz/csvParse";
import type { PipelineJob, PipelineLogMsg, PipelineOutcome, PipelineProgressMsg } from "./types";
import { createWorkerHandle } from "./workerHandle";
import { recordTelemetry } from "../lib/telemetry";

const handle = createWorkerHandle<CdnaWorkerApi>("cdna-display", () =>
  new Worker(new URL("./cdna.worker.ts", import.meta.url), { type: "module", name: "cdna-pipeline" }),
);

export function setCdnaWorkerErrorHandler(handler: (message: string) => void): void {
  handle.setErrorHandler(handler);
}

export async function runInCdnaWorker(
  job: PipelineJob,
  onProgress?: (message: PipelineProgressMsg) => void,
  onLog?: (message: PipelineLogMsg) => void,
  refreshDriveToken?: () => Promise<string>,
): Promise<PipelineOutcome> {
  const startedAt = performance.now();
  try {
    const api = await handle.getApi();
    const outcome = await api.run(
      job,
      onProgress ? Comlink.proxy(onProgress) : undefined,
      onLog ? Comlink.proxy(onLog) : undefined,
      refreshDriveToken ? Comlink.proxy(refreshDriveToken) : undefined,
    );
    recordTelemetry({ toolId: "cdna-display", phase: "pipeline-total", status: "ok", startedAt, durationMs: performance.now() - startedAt });
    return outcome;
  } catch (error) {
    recordTelemetry({ toolId: "cdna-display", phase: "pipeline-total", status: "error", startedAt, durationMs: performance.now() - startedAt });
    throw error;
  }
}

export async function parseCsvInCdnaWorker(
  blob: Blob,
  options: StreamCsvOptions = {},
): Promise<StreamCsvResult> {
  return (await handle.getApi()).parseCsv(blob, options);
}

export function terminateCdnaWorker(): void { handle.terminate(); }
export async function initializeCdnaWorker(): Promise<void> { await handle.getApi(); }
