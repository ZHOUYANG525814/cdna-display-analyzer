import { ScanLine } from "lucide-react";
import type { Tool } from "@/tools/types";
import { useTargetedNanoporeStore } from "@/state/useTargetedNanoporeStore";
import { InputsStep } from "./steps/InputsStep";
import { QcStep } from "./steps/QcStep";
import { RunStep } from "./steps/RunStep";
import { ResultsStep } from "./steps/ResultsStep";
import { initializeTargetedNanoporeWorker, terminateTargetedNanoporeWorker } from "@/worker/targetedNanoporeWorkerClient";
import { registerWorkerInitializer } from "@/lib/telemetry";

registerWorkerInitializer("nanopore-targeted", initializeTargetedNanoporeWorker);

export const nanoporeTool: Tool = {
  id: "nanopore-targeted",
  name: "Nanopore Analyzer",
  shortName: "Nanopore",
  description: "Full-amplicon QC and Round 0-normalized enrichment for researcher-defined target codons.",
  icon: ScanLine,
  steps: [
    { id: "inputs", label: "Inputs", blurb: "Rounds + CDS + targets", Component: InputsStep },
    { id: "qc", label: "QC", blurb: "Review + lock", Component: QcStep },
    { id: "run", label: "Run", blurb: "Stream + align", Component: RunStep },
    { id: "results", label: "Results", blurb: "Enrichment + QC", Component: ResultsStep },
  ],
  useCurrentStep: () => useTargetedNanoporeStore((s) => s.currentStep),
  useSetStep: () => useTargetedNanoporeStore((s) => s.setStep as (id: string) => void),
  dispose: () => {
    terminateTargetedNanoporeWorker();
    const store = useTargetedNanoporeStore.getState();
    if (store.runState.status === "running") {
      store.setRunState({ status: "cancelled", finishedAt: Date.now() });
      store.appendRunLog({ tag: "warning", msg: "Cancelled because the tool was closed." });
    }
  },
};
