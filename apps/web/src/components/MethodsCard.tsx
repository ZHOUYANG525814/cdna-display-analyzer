// Methods & column reference card for the Results page (Phase 6.14).
//
// Shared by both tools: takes a `MethodsDocument` (CDNA_METHODS or
// NANOPORE_METHODS, defined in @cdna/core), per-run parameters (settings,
// library median, hit counts), and renders an expandable card.
//
// Why shared: the doc structure is identical across tools; only the content
// differs. Keeping one component avoids drift in the layout/UX.
//
// Layout (default collapsed):
//
//   ▾ Methods used in this run · click to expand
//
//     ┌─ This run ──────────────────────────┐
//     │ WASM scoring: on                    │
//     │ Min mean read Phred: ≥ 20.0         │
//     │ ...                                 │
//     └─────────────────────────────────────┘
//
//     ┌─ Library median (diagnostic) ───────┐
//     │ Enrich_Global_R1_vs_R0:  +0.12      │
//     │ Enrich_Global_R3_vs_R0:  -0.04      │
//     │ (entries with |median| > 1 flagged) │
//     └─────────────────────────────────────┘
//
//     ┌─ FDR hit counts ────────────────────┐
//     │ R1 vs R0:    245 (q<0.05),  89 (q<0.01)  of 12,345
//     └─────────────────────────────────────┘
//
//     ┌─ Method choices ────────────────────┐
//     │ Pseudocount (RPM): 0.50 ...          │
//     └─────────────────────────────────────┘
//
//     ─ Variant identity ─
//       Peptide_Seq
//         summary text…
//         Formula: …
//         · note
//
//     ─ Raw and normalized counts ─
//       …

import { useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import type { MethodsDocument } from "@cdna/core";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface Props {
  doc: MethodsDocument;
  settings?: ReadonlyArray<{ label: string; value: string }>;
  libraryMedian?: Record<string, number>;
  hitCounts?: ReadonlyArray<{ label: string; q05: number; q01: number; total: number }>;
  pseudocount?: number;
  /** Whether the card body is expanded by default. Defaults to false so the
   *  Results page doesn't push the dashboard down on load. */
  defaultOpen?: boolean;
}

export function MethodsCard({
  doc,
  settings,
  libraryMedian,
  hitCounts,
  pseudocount,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left transition hover:bg-muted/40"
      >
        <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
          <div>
            <CardTitle className="flex items-center gap-1.5 text-base">
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Methods &amp; column reference
            </CardTitle>
            <CardDescription className="ml-5 text-xs">
              Formulas, statistical model, and per-column definitions for the downloadable CSV.
              Same content lands in the downloaded QC_Summary_Report.txt.
            </CardDescription>
          </div>
        </CardHeader>
      </button>
      {open ? (
        <CardContent className="space-y-5 pt-0 text-xs">
          {settings && settings.length > 0 ? <RunSettings rows={settings} /> : null}
          {libraryMedian && Object.keys(libraryMedian).length > 0 ? (
            <LibraryMedianBlock data={libraryMedian} />
          ) : null}
          {hitCounts && hitCounts.length > 0 ? <HitCountsBlock data={hitCounts} /> : null}
          <MethodChoices doc={doc} pseudocount={pseudocount} />
          {doc.sections.map((section) => (
            <Section key={section.title} title={section.title} columns={section.columns} />
          ))}
          {doc.mlRecipe ? <MLRecipeBlock recipe={doc.mlRecipe} /> : null}
          {doc.caveats.length > 0 ? <CaveatsBlock items={doc.caveats} /> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function RunSettings({ rows }: { rows: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        This run
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="font-mono text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LibraryMedianBlock({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data);
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Library-wide median (diagnostic)
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground/90">
        Values far from zero flag a systematic library-wide shift. A median more negative than
        −1 flags the dropout regime where the <code className="font-mono">Centered_*</code>{" "}
        score over-corrects toward enrichment.
      </p>
      <dl className="space-y-0.5">
        {entries.map(([key, val]) => {
          const flagged = val < -1 || val > 1;
          return (
            <div key={key} className="flex items-center justify-between gap-2">
              <dt className="break-all font-mono text-[11px] text-muted-foreground">{key}</dt>
              <dd className="flex items-center gap-1 font-mono tabular-nums">
                <span className={flagged ? "text-warning" : "text-foreground"}>
                  {val.toFixed(3)}
                </span>
                {flagged ? (
                  <AlertTriangle className="h-3 w-3 text-warning" aria-label="flagged" />
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function HitCountsBlock({
  data,
}: {
  data: ReadonlyArray<{ label: string; q05: number; q01: number; total: number }>;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        FDR hit counts (this run)
      </div>
      <table className="w-full font-mono">
        <thead>
          <tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="py-1 pr-2">Comparison</th>
            <th className="py-1 px-2 text-right">q&lt;0.05</th>
            <th className="py-1 px-2 text-right">q&lt;0.01</th>
            <th className="py-1 pl-2 text-right">total</th>
          </tr>
        </thead>
        <tbody>
          {data.map((h) => (
            <tr key={h.label} className="border-b last:border-b-0">
              <td className="py-1 pr-2 text-foreground">{h.label}</td>
              <td className="py-1 px-2 text-right tabular-nums">{h.q05.toLocaleString()}</td>
              <td className="py-1 px-2 text-right tabular-nums">{h.q01.toLocaleString()}</td>
              <td className="py-1 pl-2 text-right tabular-nums text-muted-foreground">
                {h.total.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MethodChoices({ doc, pseudocount }: { doc: MethodsDocument; pseudocount?: number | undefined }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Method choices
      </div>
      <dl className="space-y-0.5">
        <Row label="Pseudocount (RPM)" value={(pseudocount ?? doc.pseudocount).toFixed(2)} />
        <Row label="P-value test" value={doc.pvalueMethod} />
        <Row label="Multiple testing" value={doc.fdrMethod} />
        <Row label="Centering scheme" value={doc.centeringMethod} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-foreground">{value}</dd>
    </div>
  );
}

function Section({
  title,
  columns,
}: {
  title: string;
  columns: ReadonlyArray<{
    name: string;
    summary: string;
    formula?: string;
    notes?: string[];
  }>;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-3">
        {columns.map((col) => (
          <li key={col.name} className="rounded-md border bg-background/50 p-2.5">
            <div className="mb-1 font-mono text-sm font-semibold text-foreground">{col.name}</div>
            <div className="text-foreground/90">{col.summary}</div>
            {col.formula ? (
              <pre className="mt-2 overflow-x-auto rounded-sm bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-foreground">
                {col.formula}
              </pre>
            ) : null}
            {col.notes && col.notes.length > 0 ? (
              <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                {col.notes.map((n, i) => (
                  <li key={i}>· {n}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MLRecipeBlock({
  recipe,
}: {
  recipe: NonNullable<MethodsDocument["mlRecipe"]>;
}) {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
        Using this CSV for machine learning
      </div>
      <p className="mb-2 text-[11px] text-foreground/90">{recipe.description}</p>
      <dl className="mb-2 space-y-0.5 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Input (X)</dt>
          <dd className="font-mono text-foreground/90">{recipe.inputColumn}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Target (y)</dt>
          <dd className="font-mono text-foreground/90">{recipe.targetColumn}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted-foreground">Weight (w)</dt>
          <dd className="font-mono text-foreground/90">{recipe.weightExpr}</dd>
        </div>
      </dl>
      {recipe.snippet ? (
        <pre className="overflow-x-auto rounded-sm bg-muted/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground">
          {recipe.snippet}
        </pre>
      ) : null}
    </div>
  );
}

function CaveatsBlock({ items }: { items: ReadonlyArray<string> }) {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-warning">
        <AlertTriangle className="h-3 w-3" /> Caveats
      </div>
      <ul className="space-y-1 text-[11px] text-foreground/90">
        {items.map((c, i) => (
          <li key={i}>· {c}</li>
        ))}
      </ul>
    </div>
  );
}
