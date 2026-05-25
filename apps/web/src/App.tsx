// App shell. Reads the active tool from tools/cdna-display (today the only
// one) and renders its header + stepper + active step. When a second tool
// is added, this file picks the active one from a registry / URL route —
// no other change is needed.

import { Stepper } from "@/components/Stepper";
import { useRunStore } from "@/state/useRunStore";
import { cdnaDisplayTool } from "@/tools/cdna-display";

const tool = cdnaDisplayTool;

export function App() {
  const currentStep = useRunStore((s) => s.currentStep);
  const ActiveStep = tool.steps.find((s) => s.id === currentStep)?.Component;
  const Icon = tool.icon;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            {Icon ? <Icon className="h-5 w-5 text-primary" /> : null}
            <h1 className="text-base font-semibold tracking-tight">{tool.name}</h1>
          </div>
          <span className="text-xs text-muted-foreground">Browser-only · no upload</span>
        </div>
      </header>

      <Stepper steps={tool.steps} />

      <main className="mx-auto max-w-7xl px-4 py-8">
        {ActiveStep ? <ActiveStep /> : null}
      </main>
    </div>
  );
}
