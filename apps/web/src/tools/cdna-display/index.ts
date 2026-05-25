// Tool registration for the cDNA-DISPLAY pipeline. Bundles the step
// components + metadata into a Tool the app shell can render. The store
// (state/useRunStore.ts) currently mirrors this tool's state shape; when
// a second tool ships, that store will either generalize or split per-tool.

import { Dna } from "lucide-react";
import type { Tool } from "@/tools/types";
import { SourcesStep } from "./steps/SourcesStep";
import { ConfigureStep } from "./steps/ConfigureStep";
import { PreviewStep } from "./steps/PreviewStep";
import { RunStep } from "./steps/RunStep";
import { ResultsStep } from "./steps/ResultsStep";

export const cdnaDisplayTool: Tool = {
  id: "cdna-display",
  name: "cDNA-DISPLAY Analyzer",
  description:
    "Demultiplex + enrichment of cDNA/mRNA-display NGS selection rounds, streamed in-browser.",
  icon: Dna,
  steps: [
    { id: "sources", label: "Sources", blurb: "Select FASTQs", Component: SourcesStep },
    { id: "configure", label: "Configure", blurb: "Reference + primers", Component: ConfigureStep },
    { id: "preview", label: "Preview", blurb: "Align & pick CDS", Component: PreviewStep },
    { id: "run", label: "Run", blurb: "Demultiplex + analyze", Component: RunStep },
    { id: "results", label: "Results", blurb: "Download", Component: ResultsStep },
  ],
};
