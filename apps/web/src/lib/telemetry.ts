export type TelemetryPhase =
  | "tool-import"
  | "worker-initialization"
  | "pipeline-total";

export interface BrowserTelemetryEntry {
  toolId: string;
  phase: TelemetryPhase;
  status: "ok" | "error";
  startedAt: number;
  durationMs: number;
  detail?: Record<string, string | number | boolean | null>;
}

declare global {
  interface Window {
    /** Stable, read-only-by-convention interface consumed by Playwright. */
    __CDNA_TELEMETRY__?: BrowserTelemetryEntry[];
    __CDNA_BENCHMARK__?: {
      initializeWorker(toolId: string): Promise<void>;
    };
  }
}

const workerInitializers = new Map<string, () => Promise<void>>();

export function registerWorkerInitializer(toolId: string, initialize: () => Promise<void>): void {
  workerInitializers.set(toolId, initialize);
  window.__CDNA_BENCHMARK__ ??= {
    async initializeWorker(requestedToolId: string) {
      const initializer = workerInitializers.get(requestedToolId);
      if (!initializer) throw new Error(`Tool ${requestedToolId} has not been loaded.`);
      await initializer();
    },
  };
}

export function recordTelemetry(entry: BrowserTelemetryEntry): void {
  const entries = window.__CDNA_TELEMETRY__ ??= [];
  entries.push(Object.freeze({ ...entry }));
  window.dispatchEvent(new CustomEvent("cdna:telemetry", { detail: entry }));
}
