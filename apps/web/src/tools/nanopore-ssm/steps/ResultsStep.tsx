// Nanopore SSM — Results step. Renders the outcome from runNanoporeInWorker:
// per-round yield table, per-site variant tables (tabbed), haplotype tab when
// ≥2 sites enabled linkage, and CSV download buttons.

import { useMemo } from "react";
import { ArrowLeft, Download, RotateCcw } from "lucide-react";
import { useNanoporeStore } from "@/state/useNanoporeStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NanoporeOutcome } from "@/state/useNanoporeStore";
import { NANOPORE_METHODS } from "@cdna/core";
import { MethodsCard } from "@/components/MethodsCard";

export function ResultsStep() {
  const outcome = useNanoporeStore((s) => s.outcome);
  const projectName = useNanoporeStore((s) => s.projectName);
  const goPrev = useNanoporeStore((s) => s.goPrev);
  const setStep = useNanoporeStore((s) => s.setStep);
  const resetRun = useNanoporeStore((s) => s.resetRun);

  if (!outcome) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No results yet</CardTitle>
            <CardDescription>
              Run the pipeline on the Run step first; results land here once
              extraction + analysis complete.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => setStep("run")}>
              Back to Run
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <ResultsLoaded outcome={outcome} projectName={projectName} onPrev={goPrev} onReset={() => { resetRun(); setStep("sources"); }} />;
}

/** Pull the active Nanopore settings into the shape MethodsCard expects.
 *  Kept as a hook so the cell-by-cell rendering doesn't re-read the store. */
function useMethodsSettings(): ReadonlyArray<{ label: string; value: string }> {
  const pipelineMode = useNanoporeStore((s) => s.pipelineMode);
  const reportHaplotype = useNanoporeStore((s) => s.reportHaplotype);
  const minMeanPhredRead = useNanoporeStore((s) => s.minMeanPhredRead);
  const minMeanPhredRoi = useNanoporeStore((s) => s.minMeanPhredRoi);
  return [
    { label: "Pipeline mode", value: pipelineMode },
    { label: "Min mean read Phred", value: `≥ ${minMeanPhredRead}` },
    { label: "Min mean ROI Phred", value: `≥ ${minMeanPhredRoi}` },
    { label: "Report linked haplotype", value: reportHaplotype ? "yes" : "no" },
  ];
}

function ResultsLoaded({
  outcome,
  projectName,
  onPrev,
  onReset,
}: {
  outcome: NanoporeOutcome;
  projectName: string;
  onPrev: () => void;
  onReset: () => void;
}) {
  // Settings recap rows for the MethodsCard. Reads the active Nanopore-store
  // values so the card reflects exactly the parameters the engine ran with.
  const settings = useMethodsSettings();

  // Aggregate totals across rounds for the stat-card row.
  const totals = useMemo(() => {
    let passedQc = 0;
    let wt = 0;
    for (const r of Object.values(outcome.statsByRound)) {
      for (const s of Object.values(r.sites)) {
        passedQc += s.passed_qc;
        wt += s.wt_count;
      }
    }
    return { passedQc, wt };
  }, [outcome.statsByRound]);

  const uniqueVariants = useMemo(() => {
    // Unique Variant_AA across all sites in the preview (cap = 200 per site).
    const seen = new Set<string>();
    for (const row of outcome.perSiteRowsPreview) {
      seen.add(`${row.Site}|${row.Variant_AA}`);
    }
    return seen.size;
  }, [outcome.perSiteRowsPreview]);

  const showHaplotype = outcome.haplotypeRowsPreview.length > 0;

  const onDownload = (blob: Blob | null, name: string) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = projectName.trim().replace(/[^a-zA-Z0-9_.\-]/g, "_") || "nanopore_run";
    a.download = `${safe}__${name}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Passed QC (all sites)" value={totals.passedQc.toLocaleString()} />
        <StatCard label="WT-baseline reads" value={totals.wt.toLocaleString()} />
        <StatCard label="Sites" value={String(outcome.siteNames.length)} />
        <StatCard label="Unique variants (top 200/site)" value={uniqueVariants.toLocaleString()} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-round yield</CardTitle>
          <CardDescription>
            Each row is one round; each column is one site's passed-QC count.
            Anchor-miss columns reflect reads where the site's anchor pair
            wasn't found in the read.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="py-1.5 font-medium">Round</th>
                  {outcome.siteNames.map((s) => (
                    <th key={s} className="py-1.5 font-medium">
                      {s} · passed
                    </th>
                  ))}
                  {outcome.siteNames.map((s) => (
                    <th key={`${s}-wt`} className="py-1.5 font-medium">
                      {s} · WT
                    </th>
                  ))}
                  {showHaplotype && <th className="py-1.5 font-medium">Haplotype · passed</th>}
                </tr>
              </thead>
              <tbody className="font-mono">
                {outcome.roundNames.map((r) => {
                  const stats = outcome.statsByRound[r];
                  if (!stats) return null;
                  return (
                    <tr key={r} className="border-b last:border-0">
                      <td className="py-1.5 font-sans font-medium">{r}</td>
                      {outcome.siteNames.map((s) => (
                        <td key={`${r}-${s}-p`} className="py-1.5 text-muted-foreground">
                          {(stats.sites[s]?.passed_qc ?? 0).toLocaleString()}
                        </td>
                      ))}
                      {outcome.siteNames.map((s) => (
                        <td key={`${r}-${s}-w`} className="py-1.5 text-muted-foreground">
                          {(stats.sites[s]?.wt_count ?? 0).toLocaleString()}
                        </td>
                      ))}
                      {showHaplotype && (
                        <td className="py-1.5 text-muted-foreground">
                          {stats.haplotype_passed_qc.toLocaleString()}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Variant tables</CardTitle>
          <CardDescription>
            Top variants per site, sorted by Fitness_vs_WT of the last round.
            Showing up to 200 rows per site; download the full CSV below for everything.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue={outcome.siteNames[0] ?? "site_1"}>
            <TabsList>
              {outcome.siteNames.map((s) => (
                <TabsTrigger key={s} value={s}>
                  {s}
                </TabsTrigger>
              ))}
              {showHaplotype && (
                <TabsTrigger value="__haplotype__" className="font-mono">
                  haplotype
                </TabsTrigger>
              )}
            </TabsList>

            {outcome.siteNames.map((s) => (
              <TabsContent key={s} value={s} className="mt-3">
                <PerSiteTable
                  rows={outcome.perSiteRowsPreview.filter((r) => r.Site === s).slice(0, 50)}
                  roundNames={outcome.roundNames}
                  wtDna={outcome.resolvedWtBySite[s] ?? ""}
                />
              </TabsContent>
            ))}

            {showHaplotype && (
              <TabsContent value="__haplotype__" className="mt-3">
                <HaplotypeTable
                  rows={outcome.haplotypeRowsPreview.slice(0, 50)}
                  roundNames={outcome.roundNames}
                />
              </TabsContent>
            )}
          </Tabs>
        </CardContent>
      </Card>

      {/* Methods & column reference (Phase 6.14). Default-collapsed so the
          dashboard's main viz stays above the fold. Renders the same
          content that gets appended to the downloaded QC report. */}
      <MethodsCard
        doc={NANOPORE_METHODS}
        settings={settings}
        libraryMedian={outcome.libraryMedianFitness}
        hitCounts={outcome.hitCounts}
      />

      <div className="flex justify-between">
        <Button variant="outline" onClick={onPrev}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => onDownload(outcome.perSiteCsvBlob, "enrichment_per_site.csv")}
            disabled={!outcome.perSiteCsvBlob}
          >
            <Download className="mr-2 h-4 w-4" />
            Per-site CSV
          </Button>
          {showHaplotype && (
            <Button
              variant="outline"
              onClick={() => onDownload(outcome.haplotypeCsvBlob, "enrichment_haplotype.csv")}
              disabled={!outcome.haplotypeCsvBlob}
            >
              <Download className="mr-2 h-4 w-4" />
              Haplotype CSV
            </Button>
          )}
          <Button variant="outline" onClick={onReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            New run
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums text-primary">{value}</div>
      </CardContent>
    </Card>
  );
}

function PerSiteTable({
  rows,
  roundNames,
  wtDna,
}: {
  rows: { [k: string]: string | number | boolean }[];
  roundNames: ReadonlyArray<string>;
  wtDna: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        No variants extracted at this site.
      </div>
    );
  }
  const lastRound = roundNames[roundNames.length - 1] ?? "";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="border-b text-left text-muted-foreground">
          <tr>
            <th className="py-1.5 font-medium">AA</th>
            <th className="py-1.5 font-medium">Codon</th>
            {roundNames.map((r) => (
              <th key={`c-${r}`} className="py-1.5 text-right font-medium">
                {r}
              </th>
            ))}
            <th className="py-1.5 text-right font-medium">Fitness · {lastRound}</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((row, i) => {
            const fit = Number(row[`Fitness_vs_WT_${lastRound}`] ?? 0);
            const isWt = String(row.Dominant_DNA) === wtDna;
            return (
              <tr key={i} className="border-b last:border-0">
                <td className="py-1.5 font-sans font-semibold">
                  {isWt ? (
                    <Badge variant="outline" className="border-primary text-primary">
                      {String(row.Variant_AA)} (WT)
                    </Badge>
                  ) : (
                    String(row.Variant_AA)
                  )}
                </td>
                <td className="py-1.5">{String(row.Dominant_DNA)}</td>
                {roundNames.map((r) => (
                  <td key={`v-${r}-${i}`} className="py-1.5 text-right text-muted-foreground">
                    {Number(row[`Count_${r}`] ?? 0).toLocaleString()}
                  </td>
                ))}
                <td
                  className={
                    "py-1.5 text-right font-semibold " +
                    (fit > 0
                      ? "text-success"
                      : fit < 0
                        ? "text-destructive"
                        : "text-muted-foreground")
                  }
                >
                  {fit > 0 ? "+" : ""}
                  {fit.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HaplotypeTable({
  rows,
  roundNames,
}: {
  rows: { [k: string]: string | number | boolean }[];
  roundNames: ReadonlyArray<string>;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        No haplotypes extracted.
      </div>
    );
  }
  const lastRound = roundNames[roundNames.length - 1] ?? "";
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        Each row is the combined codon string across every site — only counted
        when all sites extract cleanly from the same read. Preserves linkage
        for epistasis analysis.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="py-1.5 font-medium">Haplotype AA</th>
              <th className="py-1.5 font-medium">DNA</th>
              {roundNames.map((r) => (
                <th key={`c-${r}`} className="py-1.5 text-right font-medium">
                  {r}
                </th>
              ))}
              <th className="py-1.5 text-right font-medium">Fitness · {lastRound}</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((row, i) => {
              const fit = Number(row[`Fitness_vs_WT_${lastRound}`] ?? 0);
              return (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1.5 font-sans font-semibold">{String(row.Haplotype_AA)}</td>
                  <td className="py-1.5">{String(row.Haplotype_DNA)}</td>
                  {roundNames.map((r) => (
                    <td key={`v-${r}-${i}`} className="py-1.5 text-right text-muted-foreground">
                      {Number(row[`Count_${r}`] ?? 0).toLocaleString()}
                    </td>
                  ))}
                  <td
                    className={
                      "py-1.5 text-right font-semibold " +
                      (fit > 0
                        ? "text-success"
                        : fit < 0
                          ? "text-destructive"
                          : "text-muted-foreground")
                    }
                  >
                    {fit > 0 ? "+" : ""}
                    {fit.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
