import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, ArrowLeft } from "lucide-react";
import { useRunStore } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { exportOutcome } from "@/adapters/BrowserExporter";
import { FilterFunnelSankey } from "@/tools/cdna-display/viz/FilterFunnelSankey";
import { CountHistogram } from "@/tools/cdna-display/viz/CountHistogram";
import { EnrichmentScatter } from "@/tools/cdna-display/viz/EnrichmentScatter";
import { RankAbundance } from "@/tools/cdna-display/viz/RankAbundance";
import { SequenceLogo } from "@/tools/cdna-display/viz/SequenceLogo";
import { VolcanoPlot } from "@/tools/cdna-display/viz/VolcanoPlot";
import {
  parseEnrichmentMatrix,
  parsePerRoundCounts,
} from "@/tools/cdna-display/viz/csvParse";

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
  // reference). Read its bytes asynchronously here, then parse top-20 once.
  // For very large CSVs this is still fast — Blob.text() streams + decodes
  // off the main thread in modern browsers.
  const [csvText, setCsvText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (outcome.csvBlob) {
      void outcome.csvBlob.text().then((t) => {
        if (!cancelled) setCsvText(t);
      });
    } else {
      setCsvText(null);
    }
    return () => {
      cancelled = true;
    };
  }, [outcome.csvBlob]);
  const topPeptides = useMemo(() => parseTopPeptides(csvText, 20), [csvText]);

  // Two parses serve different needs:
  //  - `parsedMatrix` is capped at 50k rows because the per-peptide UI
  //    (volcano, scatter, top-20 table, sequence logo) only ever needs the
  //    most-enriched head; the analyzer already sorts by global enrichment.
  //  - `perRoundCounts` walks the full CSV and pulls *only* the Count_*
  //    columns into compact number arrays. That keeps the rank-abundance
  //    plot and read-count histogram honest about the whole library — those
  //    summaries are meaningless if biased by an enrichment-sorted top-N.
  const parsedMatrix = useMemo(
    () => parseEnrichmentMatrix(csvText ?? "", 50_000),
    [csvText],
  );
  const perRoundCounts = useMemo(
    () => parsePerRoundCounts(csvText ?? ""),
    [csvText],
  );

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
          <Button onClick={() => exportOutcome(outcome, { projectName: state.projectName })}>
            <Download className="mr-1.5 h-4 w-4" /> Download all
          </Button>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-muted-foreground space-y-1">
            <li>• <code className="font-mono text-xs">Master_Enrichment_Matrix.csv</code> — the full peptide matrix</li>
            <li>• <code className="font-mono text-xs">run_stats.json</code> — per-round demultiplex counts (machine-readable)</li>
            <li>• <code className="font-mono text-xs">QC_Summary_Report.txt</code> — human-readable summary</li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Pipeline ran in {elapsed.toFixed(1)}s · {state.useWasm ? "WASM scoring" : "TS scoring"}
          </p>
        </CardContent>
      </Card>

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
            <RankAbundance
              countsByRound={perRoundCounts.countsByRound}
              totalsByRound={perRoundCounts.totalsByRound}
              roundNames={perRoundCounts.roundNames}
            />
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
            <CountHistogram
              countsByRound={perRoundCounts.countsByRound}
              roundNames={perRoundCounts.roundNames}
            />
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
            <SequenceLogo
              rows={parsedMatrix.rows}
              roundNames={parsedMatrix.roundNames}
            />
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
            <EnrichmentScatter
              rows={parsedMatrix.rows}
              roundNames={parsedMatrix.roundNames}
            />
          </CardContent>
        </Card>
      )}

      {parsedMatrix.rows.length > 0 && parsedMatrix.roundNames.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Volcano plot — statistical significance</CardTitle>
            <CardDescription>
              For each peptide, a one-sided Fisher's exact test (or
              Yates-corrected χ² for large counts) compares its count in the
              later vs earlier round, with Benjamini–Hochberg FDR correction.
              Red points clear both FDR &lt; 0.05 and log₂FC &gt; 1
              (≥ 2× enrichment) — these are the publication-grade hits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VolcanoPlot
              rows={parsedMatrix.rows}
              totalsByRound={perRoundCounts.totalsByRound}
              roundNames={parsedMatrix.roundNames}
            />
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
                    <th className="pb-2 pr-3 font-medium text-right">GC%</th>
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
                      <td className="py-1.5 pr-3 font-mono text-right">{r.gc.toFixed(1)}</td>
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

// Parse the analyzer CSV (returned from the worker) and pluck the top-20 rows
// to render in the dashboard. We avoid transferring the full row objects
// across the worker boundary — the CSV is already in hand and is the source
// of truth anyway.
interface TopRow {
  peptide: string;
  gc: number;
  rpm: Record<string, number>;
  sortValue: number;
}
function parseTopPeptides(
  csv: string | null,
  limit: number,
): { rows: TopRow[]; totalRows: number; sortColumn: string; roundColumns: string[] } {
  const empty = { rows: [], totalRows: 0, sortColumn: "", roundColumns: [] };
  if (!csv) return empty;

  // Bounded scan: walk forward via indexOf to find the first (limit + 1)
  // newlines so we never materialize the whole CSV as a string array. The
  // analyzer already sorts the rows, so the top-N is the first N data rows.
  const headerEnd = csv.indexOf("\n");
  if (headerEnd === -1) return empty;
  const headers = csv.slice(0, headerEnd).split(",");
  const idx = (name: string) => headers.indexOf(name);
  const pepCol = idx("Peptide_Seq");
  const gcCol = idx("GC_Percent");
  const rpmCols = headers
    .map((h, i) => ({ h, i }))
    .filter((x) => x.h.startsWith("RPM_"));
  const enrichGlobalCols = headers
    .map((h, i) => ({ h, i }))
    .filter((x) => x.h.startsWith("Enrich_Global_"));
  const sortCol =
    enrichGlobalCols.length > 0
      ? enrichGlobalCols[enrichGlobalCols.length - 1]!
      : rpmCols[0];
  if (!sortCol) return empty;

  const rows: TopRow[] = [];
  let lineStart = headerEnd + 1;
  while (rows.length < limit) {
    const lineEnd = csv.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? csv.length : lineEnd;
    if (end > lineStart) {
      const cells = csv.slice(lineStart, end).split(",");
      const rpm: Record<string, number> = {};
      for (const { h, i } of rpmCols) rpm[h] = Number(cells[i]);
      rows.push({
        peptide: cells[pepCol] ?? "",
        gc: Number(cells[gcCol]),
        rpm,
        sortValue: Number(cells[sortCol.i]),
      });
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  // Count remaining rows by counting newlines past where we stopped — cheap
  // O(n) char scan, no string allocations.
  let totalRows = rows.length;
  for (let i = lineStart; i < csv.length; i++) {
    if (csv.charCodeAt(i) === 10) totalRows++;
  }

  return {
    rows,
    totalRows,
    sortColumn: sortCol.h,
    roundColumns: rpmCols.map((x) => x.h),
  };
}
