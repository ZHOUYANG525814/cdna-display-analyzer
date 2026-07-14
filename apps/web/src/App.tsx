// App shell. Renders the active tool's stepper + active step, with a
// top-of-page tool switcher that routes between cDNA-DISPLAY and Nanopore
// (and any future sibling tools listed in tools/registry.ts).

import { useEffect } from "react";
import { Stepper } from "@/components/Stepper";
import { useAppStore } from "@/state/useAppStore";
import { tools, toolById } from "@/tools/registry";

export function App() {
  const activeToolId = useAppStore((s) => s.activeToolId);
  const setActiveTool = useAppStore((s) => s.setActiveTool);
  const tool = toolById(activeToolId);
  // Mirror the active tool id onto <html data-tool="..."> so the per-tool CSS
  // variable overrides in index.css take effect. Any element under <html>
  // automatically picks up the swap — no per-component theming code needed.
  useEffect(() => {
    document.documentElement.dataset.tool = activeToolId;
  }, [activeToolId]);

  // Logo click → jump back to the active tool's first step (Sources). Keeps
  // the user's data intact — this is navigation, not a reset. Lets a user
  // who clicked too far quickly get back without hunting through the stepper.
  const setStep = tool.useSetStep?.();
  const goHome = () => {
    if (setStep && tool.steps.length > 0) setStep(tool.steps[0]!.id);
  };
  // Each tool owns its own currentStep field (cdna-display uses useRunStore,
  // nanopore-ssm uses useNanoporeStore). The Tool definition optionally
  // provides a hook to read the active step; if absent we use the first step.
  const ActiveStepFromHook = tool.useCurrentStep?.();
  const ActiveStep =
    tool.steps.find((s) => s.id === ActiveStepFromHook)?.Component ?? tool.steps[0]!.Component;
  const Icon = tool.icon;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <button
            type="button"
            onClick={goHome}
            className="group flex items-center gap-2 rounded-md px-1.5 py-0.5 transition hover:bg-muted/60"
            title="Back to first step"
          >
            {Icon ? <Icon className="h-5 w-5 text-primary transition group-hover:scale-110" /> : null}
            <h1 className="text-base font-semibold tracking-tight">{tool.name}</h1>
          </button>
          <div className="flex items-center gap-3">
            <ToolSwitcher activeId={activeToolId} onChange={setActiveTool} />
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Browser-only · no upload
            </span>
          </div>
        </div>
      </header>

      <Stepper
        steps={tool.steps}
        {...(tool.useCurrentStep ? { useCurrentStep: tool.useCurrentStep } : {})}
        {...(tool.useSetStep ? { useSetStep: tool.useSetStep } : {})}
      />

      <main className="mx-auto max-w-7xl px-4 py-8">
        <ActiveStep />
      </main>

      <SiteFooter />
    </div>
  );
}

function ToolSwitcher({
  activeId,
  onChange,
}: {
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border bg-muted/50 p-0.5 text-xs">
      {tools.map((t) => {
        const Icon = t.icon;
        const isActive = t.id === activeId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            title={t.description}
            className={
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors " +
              (isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            <span className="font-medium">{t.shortName ?? t.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-6 text-center text-xs text-muted-foreground">
        <div className="text-sm font-medium text-foreground">Zhouyang Zhou</div>
        <div className="mt-0.5">Nagoya University</div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <a
            href="https://molbiotech.wixsite.com/molbiotech"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Lab website
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="https://github.com/zhouyang525814-netizen/cdna-display-analyzer"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Source on GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
