// Tool-agnostic stepper. Renders one circular badge per step plus a label;
// active step is filled with the primary accent, completed steps with the
// success color and a check icon. Click-back is allowed for any step at or
// before the current one.

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRunStore } from "@/state/useRunStore";
import type { ToolStep } from "@/tools/types";

export interface StepperProps {
  steps: ReadonlyArray<ToolStep>;
  /** Optional bridge into the active tool's store. If omitted we fall back to
   *  the cdna-display run store (legacy behaviour, single-tool app). */
  useCurrentStep?: () => string;
  useSetStep?: () => (stepId: string) => void;
  useRunStatus?: () => string;
}

function fallbackUseCurrentStep(): string {
  return useRunStore((s) => s.currentStep);
}

function fallbackUseSetStep(): (s: string) => void {
  return useRunStore((s) => s.setStep);
}

function fallbackUseRunStatus(): string {
  return useRunStore((s) => s.status);
}

export function Stepper({
  steps,
  useCurrentStep = fallbackUseCurrentStep,
  useSetStep = fallbackUseSetStep,
  useRunStatus = fallbackUseRunStatus,
}: StepperProps) {
  const currentStep = useCurrentStep();
  const setStep = useSetStep();
  const status = useRunStatus();
  const currentIdx = steps.findIndex((s) => s.id === currentStep);

  return (
    <nav aria-label="Pipeline progress" className="border-b bg-card">
      <ol className="mx-auto flex max-w-6xl items-stretch gap-0 px-4 py-3">
        {steps.map((step, i) => {
          // The terminal step (last in the list) is "done" only when the run
          // actually finished — visiting it on its own isn't enough.
          const isLast = i === steps.length - 1;
          const done = i < currentIdx || (isLast && status === "done");
          const active = step.id === currentStep;
          const reachable = status !== "running" && i <= currentIdx;
          return (
            <li key={step.id} className="flex flex-1 items-center">
              <button
                type="button"
                onClick={() => reachable && setStep(step.id)}
                disabled={!reachable}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition",
                  active && "bg-primary/5",
                  reachable && !active && "hover:bg-muted",
                  !reachable && "opacity-50 cursor-not-allowed",
                )}
                aria-current={active ? "step" : undefined}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    active && "bg-primary text-primary-foreground",
                    done && !active && "bg-success text-success-foreground",
                    !active && !done && "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span className="flex flex-col">
                  <span
                    className={cn(
                      "text-sm font-semibold leading-tight",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                  <span className="text-xs text-muted-foreground leading-tight">
                    {step.blurb}
                  </span>
                </span>
              </button>
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    "h-px w-6 flex-shrink-0 mx-1",
                    i < currentIdx ? "bg-success" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
