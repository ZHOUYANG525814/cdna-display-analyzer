// Tool registration interface. Each analysis pipeline lives under tools/<id>/
// and exports a Tool definition. The app shell (App.tsx, Stepper.tsx) is
// purely a renderer for whichever Tool is active — no tool-specific knowledge
// leaks into the shell.
//
// The registry currently ships cdna-display and one unified Nanopore tool. To add another:
//   1. Create tools/<new-id>/ with its own steps + pipeline helpers
//   2. Export a Tool definition from tools/<new-id>/index.ts
//   3. Add a tools/registry.ts and a tool-selector UI somewhere in the shell
// No changes needed to Stepper or App.tsx itself.

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

export interface ToolStep {
  /** Stable identifier; what the run store stores as currentStep. */
  id: string;
  /** Short label shown in the stepper (e.g. "Sources"). */
  label: string;
  /** One-line description shown under the label. */
  blurb: string;
  /** The step's screen. Receives no props — pulls state via Zustand store hooks. */
  Component: ComponentType;
}

export interface Tool {
  /** Stable identifier; used as URL fragment / persistence key when we add multi-tool routing. */
  id: string;
  /** Human-readable name shown in the app header. */
  name: string;
  /** Compact name for the tool-switcher pill (defaults to `name`). */
  shortName?: string;
  /** One-line tagline for tool-picker UI and pill tooltips. */
  description: string;
  icon?: LucideIcon;
  /** Step list in display order. */
  steps: ToolStep[];
  /** Hook returning the active step id for this tool. Each tool owns its own
   *  store; this hook bridges in. Omit to render the first step always. */
  useCurrentStep?: () => string;
  /** Hook returning a setter for the active step id. Drives stepper click-back. */
  useSetStep?: () => (stepId: string) => void;
}
