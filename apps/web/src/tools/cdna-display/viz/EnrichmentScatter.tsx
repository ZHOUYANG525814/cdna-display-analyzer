// Pairwise enrichment scatter plot.
//
// One panel per pair of rounds (R_{i-1} → R_i for stepwise, R_0 → R_last for
// global). X = log10(RPM in earlier round + 1), Y = log10(RPM in later round + 1).
// Points above the y = x diagonal are enriched in the later round; the
// strongest hits sit in the top-left (low in earlier, high in later).
//
// Sparse-data handling:
//   - log10(x+1) handles zeros gracefully (placed at log10(1) = 0).
//   - At most MAX_POINTS plotted per panel; we keep the top-N by enrichment
//     and a random sample of the rest so the diagonal cloud stays visible.

import { useMemo } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { PeptideRecord } from "./csvParse";
import { ChartPanel } from "./ChartPanel";

const MAX_POINTS = 2000;
const HIGHLIGHT_TOP = 50;

interface ScatterPoint {
  x: number;
  y: number;
  peptide: string;
  enrich: number;
  highlighted: boolean;
}

interface Panel {
  title: string;
  xLabel: string;
  yLabel: string;
  points: ScatterPoint[];
  totalPlotted: number;
  totalAvailable: number;
}

/** Sub-sample so we never feed more than MAX_POINTS to Recharts. We always
 *  keep the top-N enriched (they're the publication-worthy hits) and add a
 *  uniform random tail to preserve the background cloud's density. */
function subsample(rows: PeptideRecord[], destRound: string): PeptideRecord[] {
  if (rows.length <= MAX_POINTS) return rows;
  // Rows are already sorted desc by enrichment for the destination round in
  // the analyzer's output. Take top-N + random sample of remainder.
  const top = rows.slice(0, HIGHLIGHT_TOP);
  const rest = rows.slice(HIGHLIGHT_TOP);
  const targetTail = MAX_POINTS - HIGHLIGHT_TOP;
  const stride = Math.max(1, Math.floor(rest.length / targetTail));
  const sampled: PeptideRecord[] = [];
  for (let i = 0; i < rest.length && sampled.length < targetTail; i += stride) {
    sampled.push(rest[i]!);
  }
  return [...top, ...sampled];
  // destRound is unused but kept in the signature so future per-round
  // weighting (e.g. stratified sample) is a small change.
  void destRound;
}

function buildPanel(
  rows: ReadonlyArray<PeptideRecord>,
  srcRound: string,
  destRound: string,
  enrichKey: "stepwise" | "centered",
): Panel {
  const sub = subsample([...rows], destRound);
  const points: ScatterPoint[] = sub
    .map((r, idx) => {
      const xRaw = r.rpm[srcRound] ?? 0;
      const yRaw = r.rpm[destRound] ?? 0;
      // Phase 6.16: "global" mode now reads `Centered_Enrich_<dest>_vs_<first>`
      // (the canonical fold-change column post-removal of Enrich_Global).
      const enrich = r[enrichKey][destRound];
      return {
        x: Math.log10(xRaw + 1),
        y: Math.log10(yRaw + 1),
        peptide: r.peptide,
        enrich: typeof enrich === "number" && Number.isFinite(enrich) ? enrich : 0,
        highlighted: idx < HIGHLIGHT_TOP,
      };
    })
    // Filter out (0, 0) — they sit on top of each other and add no signal.
    .filter((p) => p.x > 0 || p.y > 0);

  return {
    title:
      enrichKey === "centered"
        ? `Centered enrichment · ${destRound} vs ${srcRound}`
        : `Stepwise · ${destRound} vs ${srcRound}`,
    xLabel: `log₁₀(RPM + 1) · ${srcRound}`,
    yLabel: `log₁₀(RPM + 1) · ${destRound}`,
    points,
    totalPlotted: points.length,
    totalAvailable: rows.length,
  };
}

interface Props {
  rows: ReadonlyArray<PeptideRecord>;
  roundNames: ReadonlyArray<string>;
}

export function EnrichmentScatter({ rows, roundNames }: Props) {
  const panels = useMemo<Panel[]>(() => {
    if (rows.length === 0 || roundNames.length < 2) return [];
    const out: Panel[] = [];
    // Stepwise comparisons R_i vs R_{i-1}.
    for (let i = 1; i < roundNames.length; i++) {
      out.push(buildPanel(rows, roundNames[i - 1]!, roundNames[i]!, "stepwise"));
    }
    // Global: last vs first. Only meaningful if we have ≥ 3 rounds (otherwise
    // it's the same as the only stepwise comparison).
    if (roundNames.length >= 3) {
      out.push(
        buildPanel(rows, roundNames[0]!, roundNames[roundNames.length - 1]!, "centered"),
      );
    }
    return out;
  }, [rows, roundNames]);

  if (panels.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        Enrichment scatter needs ≥ 2 rounds with peptide-level data.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {panels.map((p, i) => (
        <ScatterPanel key={i} panel={p} />
      ))}
    </div>
  );
}

function ScatterTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ScatterPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-md border bg-background/95 px-2.5 py-2 text-[11px] shadow-md backdrop-blur-sm">
      <div className="break-all font-mono text-xs font-semibold text-foreground">{p.peptide}</div>
      <div className="mt-1 space-y-0.5 text-muted-foreground">
        <div>
          log₁₀(earlier) ={" "}
          <span className="font-mono tabular-nums text-foreground">{p.x.toFixed(2)}</span>
        </div>
        <div>
          log₁₀(later) ={" "}
          <span className="font-mono tabular-nums text-foreground">{p.y.toFixed(2)}</span>
        </div>
        <div>
          enrichment ={" "}
          <span className="font-mono tabular-nums text-foreground">{p.enrich.toFixed(2)}</span>
        </div>
        {p.highlighted ? <div className="font-medium text-destructive">top hit</div> : null}
      </div>
    </div>
  );
}

function ScatterPanel({ panel }: { panel: Panel }) {
  // Recharts needs the data flat — we pre-split highlighted from background
  // so they render in two layers (background underneath, highlights on top).
  const background = panel.points.filter((p) => !p.highlighted);
  const highlighted = panel.points.filter((p) => p.highlighted);

  const maxAxis = Math.max(
    1,
    ...panel.points.map((p) => Math.max(p.x, p.y)),
  );
  const filename = `scatter_${panel.title.replace(/[^a-zA-Z0-9]+/g, "_")}`;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="font-medium">{panel.title}</span>
        <span className="font-mono text-muted-foreground">
          {panel.totalPlotted.toLocaleString()} pts shown
          {panel.totalPlotted < panel.totalAvailable && (
            <> · top {HIGHLIGHT_TOP} highlighted</>
          )}
        </span>
      </div>
      <ChartPanel filename={filename} className="h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, Math.ceil(maxAxis)]}
              tickFormatter={(v: number) => v.toFixed(1)}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              label={{
                value: panel.xLabel,
                position: "insideBottom",
                offset: -14,
                style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[0, Math.ceil(maxAxis)]}
              tickFormatter={(v: number) => v.toFixed(1)}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              label={{
                value: panel.yLabel,
                angle: -90,
                position: "insideLeft",
                offset: 14,
                style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
              }}
              width={42}
            />
            <ZAxis range={[14, 14]} />
            {/* y = x reference: points above are enriched in the later round. */}
            <ReferenceLine
              segment={[
                { x: 0, y: 0 },
                { x: Math.ceil(maxAxis), y: Math.ceil(maxAxis) },
              ]}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: "3 3" }} />
            <Scatter
              name="Background"
              data={background}
              fill="hsl(var(--muted-foreground))"
              fillOpacity={0.35}
            >
              {background.map((_, i) => (
                <Cell key={i} />
              ))}
            </Scatter>
            <Scatter
              name="Top hits"
              data={highlighted}
              fill="hsl(var(--destructive))"
              fillOpacity={0.85}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </ChartPanel>
    </div>
  );
}
