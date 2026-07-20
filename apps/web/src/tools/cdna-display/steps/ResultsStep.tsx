import { useEffect, useState } from "react";
import { Download, RefreshCw, ArrowLeft } from "lucide-react";
import { useRunStore } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CDNA_EXPORT_FILES, exportOutcome } from "@/adapters/BrowserExporter";
import { FilterFunnelSankey } from "@/tools/cdna-display/viz/FilterFunnelSankey";
import { CountHistogram } from "@/tools/cdna-display/viz/CountHistogram";
import { EnrichmentScatter } from "@/tools/cdna-display/viz/EnrichmentScatter";
import { RankAbundance } from "@/tools/cdna-display/viz/RankAbundance";
import { SequenceLogo } from "@/tools/cdna-display/viz/SequenceLogo";
import { VolcanoPlot } from "@/tools/cdna-display/viz/VolcanoPlot";
import type { StreamCsvResult } from "@/tools/cdna-display/viz/csvParse";
import { parseCsvInWorker } from "@/worker/workerClient";
import { CDNA_METHODS } from "@cdna/core";
import { MethodsCard } from "@/components/MethodsCard";
import { LazyMount } from "@/components/LazyMount";

export function ResultsStep() {
  const state = useRunStore();
  const outcome = state.outcome;
  if (!outcome) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>No results yet</CardTitle>
            <CardDescription>Run the pipeline first.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const totalAssigned = Object.values(outcome.statsByRound).reduce((a, s) => a + s.total_assigned, 0);
  const totalPassed = Object.values(outcome.statsByRound).reduce((a, s) => a + s.passed_qc, 0);
  const totalReads = totalAssigned + outcome.globalUnassigned;
  const yieldPct = totalReads > 0 ? (totalPassed / totalReads) * 100 : 0;
  const elapsed = state.startedAt && state.finishedAt ? (state.finishedAt - state.startedAt) / 1000 : 0;

  // The CSV crosses the worker boundary as a Blob (cheap structured clone by
  // reference). On multi-GB runs the CSV can total several GB — well past
  // V8's ~537 MB single-string ceiling — so we DON'T call `blob.text()`.
  // Instead, the worker does a single streaming pass with `blob.stream()` +
  // an incremental TextDecoder, fills the top-N preview, the capped matrix,
  // and the per-round count sample, then ships the result back via Comlink.
  // The main thread stays responsive throughout — without this, the parse
  // freezes the UI for ~30-60 s on a 758 MB CSV.
  const [parsed, setParsed] = useState<StreamCsvResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (outcome.csvBlob) {
      setParsed(null);
      // Phase 6.15.1: matrixLimit dropped 50k → 5k. The matrix only feeds
      // EnrichmentScatter (2k cap), Volcano (1.5k cap), and SequenceLogo
      // (top 100), so 5k is plenty. The Comlink structured-clone return
      // from the worker shrinks ~10× — eliminates the multi-second freeze
      // on result delivery for million-peptide libraries.
      void parseCsvInWorker(outcome.csvBlob, {
        matrixLimit: 5_000,
        topLimit: 20,
      })
        .then((r) => {
          if (!cancelled) setParsed(r);
        })
        .catch((err) => {
          // Soft-fail: dashboard widgets just render empty. Download still works.
          if (!cancelled) {
            console.error("[ResultsStep] parseCsvInWorker failed:", err);
            setParsed(null);
          }
        });
    } else {
      setParsed(null);
    }
    return () => {
      cancelled = true;
    };
  }, [outcome.csvBlob]);

  // Same three views the dashboard expects; produced together by the
  // streaming parser:
  //   - top:           head N rows for the preview table (analyzer pre-sorted)
  //   - matrix:        capped row table for volcano / scatter / logo / etc.
  //   - perRoundCounts: full per-round count arrays for rank-abundance + histogram
  const topPeptides = parsed?.top ?? { rows: [], totalRows: 0, sortColumn: "", roundColumns: [] };
  const bottomPeptides = parsed?.bottom ?? { rows: [], totalRows: 0, sortColumn: "", roundColumns: [] };
  const parsedMatrix = parsed?.matrix ?? { rows: [], roundNames: [] };
  const perRoundCounts = parsed?.perRoundCounts ?? {
    countsByRound: {},
    totalsByRound: {},
    nByRound: {},
    roundNames: [],
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Stat label="Total reads" value={totalReads.toLocaleString()} />
        <Stat label="Passed QC" value={totalPassed.toLocaleString()} tone="success" />
        <Stat label="Yield" value={`${yieldPct.toFixed(2)}%`} tone="success" />
        <Stat label="Unique peptides" value={topPeptides.totalRows.toLocaleString()} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Downloads</CardTitle>
            <CardDescription>All artifacts save locally — nothing is uploaded.</CardDescription>
          </div>
          <Button
            onClick={() =>
              void exportOutcome(outcome, { projectName: state.projectName, gzipCsv: true })
            }
          >
            <Download className="mr-1.5 h-4 w-4" /> Download all
          </Button>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-muted-foreground space-y-1">{CDNA_EXPORT_FILES.map(([name, description]) => <li key={name}>• <code className="font-mono text-xs">{name}</code> — {description}</li>)}</ul>
          {topPeptides.totalRows > 1_000_000 ? (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
              <span className="font-medium text-warning">⚠ </span>
              <span className="text-foreground/90">
                CSV has{" "}
                <span className="font-mono tabular-nums">
                  {topPeptides.totalRows.toLocaleString()}
                </span>{" "}
                rows — Excel truncates at 1,048,576. Use pandas / DuckDB /
                <code className="font-mono mx-1">zcat … | head</code> instead.
                Rows are sorted by <code className="font-mono">{topPeptides.sortColumn}</code>{" "}
                desc, so depleted variants (negative enrichment, important
                for ML negative training data) live at the bottom of the file
                — see "Bottom 20" table below to confirm they're there.
              </span>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            Pipeline ran in {elapsed.toFixed(1)}s · {state.useWasm ? "WASM scoring" : "TS scoring"}
          </p>
        </CardContent>
      </Card>

      {/* Methods & column reference. Phase 6.14: same content as the
          QC_Summary_Report.txt download, rendered inline so users can read
          column definitions while looking at the dashboard. Default-
          collapsed so the dashboard's main viz stays above the fold. */}
      <MethodsCard
        doc={CDNA_METHODS}
        pseudocount={state.pseudocount}
        settings={[
          { label: "Pipeline mode", value: state.pipelineMode },
          { label: "WASM scoring", value: state.useWasm ? "on" : "off" },
          { label: "Min mean read Phred", value: `≥ ${state.minMeanPhred.toFixed(1)}` },
          { label: "Min mean CDS Phred", value: `≥ ${state.minMeanPhredCds.toFixed(1)}` },
          { label: "Discard premature stops", value: state.filterStop ? "yes" : "no" },
          { label: "Enrichment pseudocount (RPM)", value: state.pseudocount.toString() },
        ]}
        libraryMedian={outcome.libraryMedianEnrich}
        hitCounts={outcome.hitCounts}
      />

      <Card>
        <CardHeader>
          <CardTitle>Per-round yield</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Round</th>
                  <th className="pb-2 pr-4 font-medium text-right">Assigned</th>
                  <th className="pb-2 pr-4 font-medium text-right">Truncated</th>
                  <th className="pb-2 pr-4 font-medium text-right">Low-Q CDS</th>
                  <th className="pb-2 pr-4 font-medium text-right">Stop</th>
                  <th className="pb-2 pr-4 font-medium text-right">Passed</th>
                  <th className="pb-2 font-medium">Yield</th>
                </tr>
              </thead>
              <tbody>
                {outcome.roundNames.map((r) => {
                  const s = outcome.statsByRound[r]!;
                  const y = s.total_assigned > 0 ? (s.passed_qc / s.total_assigned) * 100 : 0;
                  return (
                    <tr key={r} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{r}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{s.total_assigned.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{s.discard_truncated.toLocaleString()}</td>
                      <td
                        className="py-2 pr-4 text-right font-mono text-xs"
                        title="Read passed the global mean-Phred filter but the CDS region itself was too noisy (B2 fix)."
                      >
                        {(s.discard_low_quality_cds ?? 0).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{s.discard_stop_codon.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs text-success">{s.passed_qc.toLocaleString()}</td>
                      <td className="py-2 w-40">
                        <YieldBar pct={y} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap gap-3 text-xs">
            <Badge variant="outline">Unassigned: {outcome.globalUnassigned.toLocaleString()}</Badge>
            <Badge variant="outline">low_quality {outcome.unassignedBreakdown.low_quality.toLocaleString()}</Badge>
            <Badge variant="outline">no_anchor {outcome.unassignedBreakdown.no_anchor.toLocaleString()}</Badge>
            <Badge variant="outline">ambiguous {outcome.unassignedBreakdown.ambiguous.toLocaleString()}</Badge>
            <Badge variant="outline">barcode_mismatch {outcome.unassignedBreakdown.barcode_mismatch.toLocaleString()}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filtering funnel</CardTitle>
          <CardDescription>
            Every read enters from the left. Wide bands going to discard buckets
            indicate where the experiment is losing throughput. Hover any band
            for exact counts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FilterFunnelSankey outcome={outcome} />
        </CardContent>
      </Card>

      {parsedMatrix.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Rank-abundance</CardTitle>
            <CardDescription>
              Each peptide ranked by RPM, plotted log–log. A straight line ≈
              power-law (selection has converged on a few dominant peptides);
              a concave curve ≈ log-normal (library is still diverse). The
              Gini coefficient summarises inequality (0 = uniform, 1 = one
              peptide dominates); α is the fitted power-law exponent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LazyMount minHeight={340}>
              <RankAbundance
                countsByRound={perRoundCounts.countsByRound}
                totalsByRound={perRoundCounts.totalsByRound}
                roundNames={perRoundCounts.roundNames}
              />
            </LazyMount>
          </CardContent>
        </Card>
      )}

      {parsedMatrix.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Read-count distribution per round</CardTitle>
            <CardDescription>
              Histogram of how often each unique peptide appears, on a log₁₀
              scale. The dashed curve is a log-normal fit. A narrow distribution
              shifted right means the round has converged on a few winners; a
              wide left-shifted distribution means the library is still diverse.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LazyMount minHeight={240}>
              <CountHistogram
                countsByRound={perRoundCounts.countsByRound}
                roundNames={perRoundCounts.roundNames}
              />
            </LazyMount>
          </CardContent>
        </Card>
      )}

      {parsedMatrix.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Sequence logo</CardTitle>
            <CardDescription>
              Per-position amino-acid composition of the top 100 peptides in
              each round, restricted to the modal length so positions align.
              Letter height is information content (bits) × frequency: tall
              stacks are conserved positions, short stacks are variable.
              Colors follow the Clustal biochemistry palette.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LazyMount minHeight={260}>
              <SequenceLogo
                rows={parsedMatrix.rows}
                roundNames={parsedMatrix.roundNames}
              />
            </LazyMount>
          </CardContent>
        </Card>
      )}

      {parsedMatrix.rows.length > 0 && parsedMatrix.roundNames.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Enrichment scatter</CardTitle>
            <CardDescription>
              Each point is one peptide. X = RPM in the earlier round, Y = RPM
              in the later round (both log-scaled). Points above the dashed
              y = x line are enriched in the later round. Top 50 hits
              highlighted in red.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LazyMount minHeight={320}>
              <EnrichmentScatter
                rows={parsedMatrix.rows}
                roundNames={parsedMatrix.roundNames}
              />
            </LazyMount>
          </CardContent>
        </Card>
      )}

      {parsedMatrix.rows.length > 0 && parsedMatrix.roundNames.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Volcano plot — statistical significance</CardTitle>
            <CardDescription>
              For each peptide, the analyzer's pre-computed Wald p-value (for
              the round-vs-first comparison) is shown with Benjamini–Hochberg
              FDR. For other stepwise pairs we fall back to a one-sided
              Fisher's exact test (or Yates-corrected χ² for large counts).
              Red points clear both FDR &lt; 0.05 and log₂FC &gt; 1
              (≥ 2× enrichment) — these are the publication-grade hits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LazyMount minHeight={340}>
              <VolcanoPlot
                rows={parsedMatrix.rows}
                totalsByRound={perRoundCounts.totalsByRound}
                roundNames={parsedMatrix.roundNames}
                pseudocount={state.pseudocount}
              />
            </LazyMount>
          </CardContent>
        </Card>
      )}

      {topPeptides.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Top 20 by enrichment</CardTitle>
            <CardDescription>
              Sorted by{" "}
              <code className="font-mono text-xs">{topPeptides.sortColumn}</code>. Full matrix in
              the CSV.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">#</th>
                    <th className="pb-2 pr-3 font-medium">Peptide</th>
                    {topPeptides.roundColumns.map((c) => (
                      <th key={c} className="pb-2 pr-3 font-medium text-right">{c}</th>
                    ))}
                    <th className="pb-2 font-medium text-right">{topPeptides.sortColumn}</th>
                  </tr>
                </thead>
                <tbody>
                  {topPeptides.rows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">{i + 1}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.peptide}</td>
                      {topPeptides.roundColumns.map((c) => (
                        <td key={c} className="py-1.5 pr-3 font-mono text-right">{r.rpm[c]?.toFixed(0) ?? "—"}</td>
                      ))}
                      <td className="py-1.5 font-mono text-right">{r.sortValue.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {bottomPeptides.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Bottom 20 (most depleted)</CardTitle>
            <CardDescription>
              The most negatively-enriched variants in the library — variants
              the selection actively dropped. Important ML negative-training
              data. Sorted ascending by{" "}
              <code className="font-mono text-xs">{bottomPeptides.sortColumn}</code>;
              row 1 here is the very last row in the downloaded CSV.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">#</th>
                    <th className="pb-2 pr-3 font-medium">Peptide</th>
                    {bottomPeptides.roundColumns.map((c) => (
                      <th key={c} className="pb-2 pr-3 font-medium text-right">{c}</th>
                    ))}
                    <th className="pb-2 font-medium text-right">{bottomPeptides.sortColumn}</th>
                  </tr>
                </thead>
                <tbody>
                  {bottomPeptides.rows.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">{i + 1}</td>
                      <td className="py-1.5 pr-3 font-mono">{r.peptide}</td>
                      {bottomPeptides.roundColumns.map((c) => (
                        <td key={c} className="py-1.5 pr-3 font-mono text-right">{r.rpm[c]?.toFixed(1) ?? "—"}</td>
                      ))}
                      <td className="py-1.5 font-mono text-right text-warning">
                        {r.sortValue.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="ghost" onClick={state.goPrev}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <Button variant="outline" onClick={state.resetAll}>
          <RefreshCw className="mr-1.5 h-4 w-4" /> New run
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "warning";
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={`mt-1 text-2xl font-semibold tabular-nums ${
            tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : ""
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function YieldBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full bg-success"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums w-12 text-right">{pct.toFixed(1)}%</span>
    </div>
  );
}
