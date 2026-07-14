// Tool registration for the production Nanopore-SSM pipeline. It mirrors the
// cDNA tool's 5-step wizard layout and is wired through the Worker to the core
// dual-anchor engine. Theme overrides live in index.css under the data-tool
// selector.

import { Microscope } from "lucide-react";
import type { Tool } from "@/tools/types";
import { useNanoporeStore } from "@/state/useNanoporeStore";
import { SourcesStep } from "./steps/SourcesStep";
import { ConfigureStep } from "./steps/ConfigureStep";
import { PreviewStep } from "./steps/PreviewStep";
import { RunStep } from "./steps/RunStep";
import { ResultsStep } from "./steps/ResultsStep";

export const nanoporeSsmTool: Tool = {
  id: "nanopore-ssm",
  name: "Nanopore SSM Analyzer",
  shortName: "Nanopore",
  description:
    "Variant counting + WT-anchored enrichment for 1–2 site SSM libraries sequenced on Oxford Nanopore.",
  icon: Microscope,
  steps: [
    { id: "sources", label: "Sources", blurb: "FASTQs + mode", Component: SourcesStep },
    { id: "configure", label: "Configure", blurb: "Reference + anchors", Component: ConfigureStep },
    { id: "preview", label: "Preview", blurb: "Anchor alignment", Component: PreviewStep },
    { id: "run", label: "Run", blurb: "Extract + count", Component: RunStep },
    { id: "results", label: "Results", blurb: "Fitness vs WT", Component: ResultsStep },
  ],
  useCurrentStep: () => useNanoporeStore((s) => s.currentStep),
  // The Tool API takes step ids as plain strings; the store narrows to the
  // NanoporeStepId union. Cast at the boundary — invalid ids are filtered out
  // upstream by the Stepper before this is called.
  useSetStep: () => useNanoporeStore((s) => s.setStep as (stepId: string) => void),
};
