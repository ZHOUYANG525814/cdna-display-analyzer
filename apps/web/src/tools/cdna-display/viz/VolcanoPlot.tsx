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

const FDR_THRESHOLD = 0.05;
const LFC_THRESHOLD = 1;
const MAX_POINTS_PER_PANEL = 5000;

interface VolcanoPoint {
  x: number; // log2 fold change
  y: number; // -log10(FDR)
  peptide: string;
  fdr: number;
  significant: boolean;
}

interface Panel {
  title: string;
  significantCount: number;
  totalPlotted: number;
  totalAvailable: number;
  points: VolcanoPoint[];
}

function buildPanel(
  rows: ReadonlyArray<PeptideRecord>,
  src: string,
  dest: string,
  label: string,
): Panel {
  const tests = computeEnrichmentTests(rows, src, dest);
  let sig = 0;
  const allPoints: VolcanoPoint[] = tests.map((t) => {
    const significant = t.fdr < FDR_THRESHOLD && t.log2FC > LFC_THRESHOLD;
    if (significant) sig++;
    return {
      x: t.log2FC,
      y: -Math.log10(Math.max(t.fdr, 1e-300)),
      peptide: t.peptide,
      fdr: t.fdr,
      significant,
    };
  });

  // Keep all the significant points (they're the publication payload) and
  // subsample the rest so Recharts stays responsive on dense libraries.
  let points = allPoints;
  if (allPoints.length > MAX_POINTS_PER_PANEL) {
    const sigPts = allPoints.filter((p) => p.significant);
    const rest = allPoints.filter((p) => !p.significant);
    const tail = MAX_POINTS_PER_PANEL - sigPts.length;
    if (tail > 0 && rest.length > tail) {
      const stride = Math.max(1, Math.floor(rest.length / tail));
      const sampled: VolcanoPoint[] = [];
      for (let i = 0; i < rest.length && sampled.length < tail; i += stride) {
        sampled.push(rest[i]!);
      }
      points = [...sigPts, ...sampled];
    } else {
      points = [...sigPts, ...rest];
    }
  }

  return {
    title: `${label}: ${dest} vs ${src}`,
    significantCount: sig,
    totalPlotted: points.length,
    totalAvailable: allPoints.length,
    points,
  };
}

interface Props {
  rows: ReadonlyArray<PeptideRecord>;
  roundNames: ReadonlyArray<string>;
}

export function VolcanoPlot({ rows, roundNames }: Props) {
  const panels = useMemo<Panel[]>(() => {
    if (rows.length === 0 || roundNames.length < 2) return [];
    const out: Panel[] = [];
    for (let i = 1; i < roundNames.length; i++) {
      out.push(buildPanel(rows, roundNames[i - 1]!, roundNames[i]!, "Stepwise"));
    }
    if (roundNames.length >= 3) {
      out.push(
        buildPanel(rows, roundNames[0]!, roundNames[roundNames.length - 1]!, "Global"),
      );
    }
    return out;
  }, [rows, roundNames]);

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

function VolcanoPanel({ panel }: { panel: Panel }) {
  const sig = panel.points.filter((p) => p.significant);
  const bg = panel.points.filter((p) => !p.significant);

  const absMaxX = Math.max(2, ...panel.points.map((p) => Math.abs(p.x)));
  const maxY = Math.max(2, ...panel.points.map((p) => p.y));
  const cutoffY = -Math.log10(FDR_THRESHOLD);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="font-medium">{panel.title}</span>
        <span className="font-mono text-muted-foreground">
          {panel.significantCount.toLocaleString()} significant ·{" "}
          FDR &lt; {FDR_THRESHOLD} &amp; log₂FC &gt; {LFC_THRESHOLD}
        </span>
      </div>
      <div className="h-[300px]">
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
                value: "log₂ fold change",
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
            <ReferenceLine
              y={cutoffY}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <ReferenceLine
              x={LFC_THRESHOLD}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              contentStyle={{
                background: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                fontSize: 11,
              }}
              formatter={(value, key, item) => {
                const payload = (item as { payload?: VolcanoPoint }).payload;
                const v = Number(value);
                if (key === "x") return [v.toFixed(2), "log₂FC"];
                if (key === "y") {
                  const fdr = payload?.fdr ?? 1;
                  return [fdr.toExponential(2), "FDR"];
                }
                return String(value);
              }}
              labelFormatter={() => ""}
            />
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
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
