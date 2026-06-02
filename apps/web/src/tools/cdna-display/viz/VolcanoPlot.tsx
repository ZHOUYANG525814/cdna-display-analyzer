// Volcano plot — log2 fold change (X) vs −log10(BH-adjusted p-value) (Y).
// Each point is one peptide; points in the upper-right corner are both
// significantly enriched (low FDR) and strongly enriched (high log2FC).
//
// Two panels: stepwise (R_{i} vs R_{i-1}) and global (R_last vs R_0) — the
// global panel only appears when ≥ 3 rounds are present, otherwise it's just
// a duplicate of the single stepwise comparison.
//
// Thresholds:
//   - FDR < 0.05   → significant (horizontal cutoff line)
//   - |log2FC| > 1 → ≥ 2× enriched (vertical cutoff line)
// Points clearing both are coloured red; everything else is muted grey.

import { useMemo } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Cell,
} from "recharts";
import type { PeptideRecord } from "./csvParse";
import { computeEnrichmentTests } from "./stats";
import { ChartPanel } from "./ChartPanel";

// Phase 6.13: dual-threshold visualization. We surface the FDR<0.05 hit count
// (the standard reporting threshold) AND the stricter FDR<0.01 count so users
// can tell at a glance how robust the signal is.
const FDR_THRESHOLD = 0.05;
const FDR_STRICT = 0.01;
const LFC_THRESHOLD = 1;
// Phase 6.15: dropped from 5000 → 1500. Recharts SVG slows noticeably past
// ~2k scatter points; significant hits are kept in full regardless of cap,
// so reducing the background sample only affects the gray "cloud" density.
const MAX_POINTS_PER_PANEL = 1500;

interface VolcanoPoint {
  x: number; // log2 fold change
  y: number; // -log10(FDR)
  peptide: string;
  fdr: number;
  significant: boolean;
  /** True for the first 20 rows in the (sort-by-Centered_Enrich-desc) matrix
   *  — the same Top-20-by-enrichment cohort the dedicated table renders.
   *  Drawn as a third layer with a distinct color/size so the chart visibly
   *  surfaces "these are the headline hits". */
  topAnchor: boolean;
}

interface Panel {
  title: string;
  significantCount: number;       // FDR < 0.05 AND |log2FC| > 1
  strictHitCount: number;          // FDR < 0.01 AND |log2FC| > 1
  totalAvailable: number;
  totalPlotted: number;
  points: VolcanoPoint[];
}

function buildPanel(
  rows: ReadonlyArray<PeptideRecord>,
  src: string,
  dest: string,
  label: string,
  totalsByRound: Record<string, number>,
  firstRound: string,
): Panel {
  // Fast path (Phase 6.15): when src is the first round, the analyzer has
  // already written Pval_Enrich_<dest>_vs_<first> + FDR_q_<dest>_vs_<first>
  // into the CSV — surfaced as row.pval[dest] / row.fdr[dest] by the parser.
  // Use those instead of recomputing Fisher's exact on the main thread; the
  // re-run is the volcano's main bottleneck on million-peptide libraries.
  //
  // Phase 6.16: X-axis switched from raw `Enrich_Global` (column removed)
  // to `Centered_Enrich`. Z (and therefore the p-value) is computed off the
  // raw fold-change, but centering only shifts the mean — the SE is
  // unchanged — so the volcano's "significant" region (FDR cutoff line) is
  // identical to before. The X-axis interpretation changes: "shift from the
  // library median" instead of "raw log₂ fold-change".
  const usePrecomputed =
    src === firstRound &&
    rows.length > 0 &&
    Number.isFinite(rows[0]!.pval[dest]) &&
    Number.isFinite(rows[0]!.fdr[dest]);

  type RowStat = { peptide: string; log2FC: number; fdr: number };
  let stats: RowStat[];
  if (usePrecomputed) {
    stats = rows.map((r) => ({
      peptide: r.peptide,
      // Centered_Enrich = raw log₂FC − library median. Anchored on the
      // canonical fold-change column emitted by the analyzer.
      log2FC: r.centered[dest] ?? 0,
      fdr: r.fdr[dest] ?? 1,
    }));
  } else {
    const tests = computeEnrichmentTests(
      rows,
      src,
      dest,
      totalsByRound[src] ?? 0,
      totalsByRound[dest] ?? 0,
    );
    stats = tests.map((t) => ({ peptide: t.peptide, log2FC: t.log2FC, fdr: t.fdr }));
  }

  let sig = 0;
  let strict = 0;
  const TOP_K_ANCHOR = 20;
  const allPoints: VolcanoPoint[] = stats.map((t, i) => {
    const significant = t.fdr < FDR_THRESHOLD && t.log2FC > LFC_THRESHOLD;
    if (significant) sig++;
    if (t.fdr < FDR_STRICT && t.log2FC > LFC_THRESHOLD) strict++;
    return {
      x: t.log2FC,
      y: -Math.log10(Math.max(t.fdr, 1e-300)),
      peptide: t.peptide,
      fdr: t.fdr,
      significant,
      // First K rows correspond to Top-K-by-enrichment because the analyzer
      // pre-sorts on Centered_Enrich desc.
      topAnchor: i < TOP_K_ANCHOR,
    };
  });

  // Hierarchical subsample (Phase 6.16.1, visually distinct in Phase 6.16.2):
  //   1. First K rows by sort order (= Top-K-by-enrichment cohort) — always
  //      kept AND rendered in a distinct teal layer with larger markers.
  //   2. All FDR/LFC-significant points — always kept (red layer).
  //   3. Stride sample of remaining background up to MAX_POINTS_PER_PANEL.
  let points = allPoints;
  if (allPoints.length > MAX_POINTS_PER_PANEL) {
    const seen = new Set<number>();
    const keep: VolcanoPoint[] = [];
    const take = (idx: number) => {
      if (idx < 0 || idx >= allPoints.length || seen.has(idx)) return;
      seen.add(idx);
      keep.push(allPoints[idx]!);
    };
    // (1) anchor on first K rows
    for (let i = 0; i < Math.min(TOP_K_ANCHOR, allPoints.length); i++) take(i);
    // (2) all significant points
    for (let i = 0; i < allPoints.length; i++) {
      if (allPoints[i]!.significant) take(i);
    }
    // (3) stride sample of remaining background
    const remaining = MAX_POINTS_PER_PANEL - keep.length;
    if (remaining > 0) {
      const rest: number[] = [];
      for (let i = 0; i < allPoints.length; i++) if (!seen.has(i)) rest.push(i);
      const stride = Math.max(1, Math.floor(rest.length / remaining));
      for (let i = 0; i < rest.length && keep.length < MAX_POINTS_PER_PANEL; i += stride) {
        take(rest[i]!);
      }
    }
    points = keep;
  }

  return {
    title: `${label}: ${dest} vs ${src}`,
    significantCount: sig,
    strictHitCount: strict,
    totalPlotted: points.length,
    totalAvailable: allPoints.length,
    points,
  };
}

interface Props {
  rows: ReadonlyArray<PeptideRecord>;
  /** Round name → passed_qc total. The p-value's library-size denominator
   *  comes from here, NOT from summing the (possibly capped) rows. */
  totalsByRound: Record<string, number>;
  roundNames: ReadonlyArray<string>;
}

export function VolcanoPlot({ rows, totalsByRound, roundNames }: Props) {
  const panels = useMemo<Panel[]>(() => {
    if (rows.length === 0 || roundNames.length < 2) return [];
    const firstRound = roundNames[0]!;
    const out: Panel[] = [];
    for (let i = 1; i < roundNames.length; i++) {
      out.push(
        buildPanel(rows, roundNames[i - 1]!, roundNames[i]!, "Stepwise", totalsByRound, firstRound),
      );
    }
    if (roundNames.length >= 3) {
      out.push(
        buildPanel(
          rows,
          firstRound,
          roundNames[roundNames.length - 1]!,
          "Global",
          totalsByRound,
          firstRound,
        ),
      );
    }
    return out;
  }, [rows, totalsByRound, roundNames]);

  if (panels.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        Volcano plot needs ≥ 2 rounds.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {panels.map((p, i) => (
        <VolcanoPanel key={i} panel={p} />
      ))}
    </div>
  );
}

function VolcanoTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: VolcanoPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-md border bg-background/95 px-2.5 py-2 text-[11px] shadow-md backdrop-blur-sm">
      <div className="break-all font-mono text-xs font-semibold text-foreground">{p.peptide}</div>
      <div className="mt-1 space-y-0.5 text-muted-foreground">
        <div>
          log₂FC ={" "}
          <span className="font-mono tabular-nums text-foreground">{p.x.toFixed(2)}</span>
        </div>
        <div>
          FDR ={" "}
          <span className="font-mono tabular-nums text-foreground">{p.fdr.toExponential(2)}</span>
        </div>
        {p.topAnchor ? (
          <div className="font-medium text-primary">Top 20 by enrichment</div>
        ) : p.significant ? (
          <div className="font-medium text-destructive">significant (FDR &lt; 0.05)</div>
        ) : null}
      </div>
    </div>
  );
}

function VolcanoPanel({ panel }: { panel: Panel }) {
  // Three-layer partition (rendered bottom → top in the order they're declared):
  //   bg   — not significant, not top-K  (gray, small)
  //   sig  — FDR/LFC significant, not top-K (red)
  //   top  — Top-K-by-enrichment cohort (teal/primary, larger, always on top)
  const top = panel.points.filter((p) => p.topAnchor);
  const sig = panel.points.filter((p) => p.significant && !p.topAnchor);
  const bg = panel.points.filter((p) => !p.significant && !p.topAnchor);

  const absMaxX = Math.max(2, ...panel.points.map((p) => Math.abs(p.x)));
  const maxY = Math.max(2, ...panel.points.map((p) => p.y));
  const cutoffY = -Math.log10(FDR_THRESHOLD);
  const strictCutoffY = -Math.log10(FDR_STRICT);
  // Slug-safe filename for the download: "Stepwise: R1 vs R0" → "volcano_Stepwise_R1_vs_R0"
  const filename = `volcano_${panel.title.replace(/[^a-zA-Z0-9]+/g, "_")}`;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{panel.title}</span>
        {/* Dual-threshold hit badges. Phase 6.13: split FDR<0.05 and FDR<0.01
            so users can spot how robust the signal is at a glance. */}
        <div className="flex flex-wrap items-center gap-1.5 font-mono">
          <span
            className="rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-destructive"
            title={`FDR < ${FDR_THRESHOLD} AND log₂FC > ${LFC_THRESHOLD}`}
          >
            {panel.significantCount.toLocaleString()} hits · FDR&lt;{FDR_THRESHOLD}
          </span>
          {panel.strictHitCount > 0 ? (
            <span
              className="rounded-md border border-destructive/60 bg-destructive/20 px-1.5 py-0.5 text-destructive"
              title={`Stricter threshold: FDR < ${FDR_STRICT} AND log₂FC > ${LFC_THRESHOLD}`}
            >
              {panel.strictHitCount.toLocaleString()} · FDR&lt;{FDR_STRICT}
            </span>
          ) : null}
        </div>
      </div>
      <ChartPanel filename={filename} className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[-Math.ceil(absMaxX), Math.ceil(absMaxX)]}
              tickFormatter={(v) => Number(v).toFixed(0)}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              label={{
                value: "Centered log₂ fold change",
                position: "insideBottom",
                offset: -14,
                style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[0, Math.ceil(maxY)]}
              tickFormatter={(v) => Number(v).toFixed(0)}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              label={{
                value: "−log₁₀(FDR)",
                angle: -90,
                position: "insideLeft",
                offset: 14,
                style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
              }}
              width={42}
            />
            <ZAxis range={[16, 16]} />
            {/* FDR=0.05 reference line, now labeled. Phase 6.13. */}
            <ReferenceLine
              y={cutoffY}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="3 3"
              strokeWidth={1}
              label={{
                value: `FDR=${FDR_THRESHOLD}`,
                position: "insideTopRight",
                fill: "hsl(var(--muted-foreground))",
                fontSize: 9,
              }}
            />
            {/* FDR=0.01 reference line — only show if any hits clear it,
                otherwise it's just visual noise. */}
            {panel.strictHitCount > 0 && strictCutoffY <= Math.ceil(maxY) ? (
              <ReferenceLine
                y={strictCutoffY}
                stroke="hsl(var(--destructive))"
                strokeDasharray="2 4"
                strokeOpacity={0.5}
                strokeWidth={1}
                label={{
                  value: `FDR=${FDR_STRICT}`,
                  position: "insideTopRight",
                  fill: "hsl(var(--destructive))",
                  fontSize: 9,
                  fillOpacity: 0.7,
                }}
              />
            ) : null}
            <ReferenceLine
              x={LFC_THRESHOLD}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="3 3"
              strokeWidth={1}
              label={{
                value: `log₂FC=${LFC_THRESHOLD}`,
                position: "insideTopRight",
                fill: "hsl(var(--muted-foreground))",
                fontSize: 9,
              }}
            />
            <Tooltip content={<VolcanoTooltip />} cursor={{ strokeDasharray: "3 3" }} />
            <Scatter
              name="Not significant"
              data={bg}
              fill="hsl(var(--muted-foreground))"
              fillOpacity={0.3}
            />
            <Scatter
              name="Significant"
              data={sig}
              fill="hsl(var(--destructive))"
              fillOpacity={0.85}
            >
              {sig.map((_, i) => (
                <Cell key={i} />
              ))}
            </Scatter>
            {/* Top-20 cohort — always rendered last so they sit on top of
                everything else. Distinct primary/teal fill + larger marker +
                contrasting border so the user can spot them at a glance
                against the red "significant" mass. */}
            <Scatter
              name="Top 20 by enrichment"
              data={top}
              fill="hsl(var(--primary))"
              // Recharts' ScatterShapeProps is overconstrained for TS strict
              // mode; cast through `any` so we can pass a simple circle
              // renderer. The runtime contract (cx, cy, fill) is stable.
              shape={
                ((props: { cx?: number; cy?: number; fill?: string }) => (
                  <circle
                    cx={props.cx}
                    cy={props.cy}
                    r={5}
                    fill={props.fill}
                    stroke="hsl(var(--background))"
                    strokeWidth={1.5}
                  />
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                )) as any
              }
            />

          </ScatterChart>
        </ResponsiveContainer>
      </ChartPanel>
      <div className="mt-1 text-[10px] text-muted-foreground/80">
        <span className="inline-flex items-center gap-0.5 mr-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: "hsl(var(--primary))" }}
          />
          Top 20 by enrichment
        </span>
        <span className="inline-flex items-center gap-0.5 mr-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: "hsl(var(--destructive))" }}
          />
          FDR &lt; 0.05 &amp; log₂FC &gt; 1
        </span>
        · Subsampled to {panel.totalPlotted.toLocaleString()} of{" "}
        {panel.totalAvailable.toLocaleString()} variants.
      </div>
    </div>
  );
}
