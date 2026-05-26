// Rank-abundance plot — log-log "ecologist's diagnostic" for selection
// convergence. For each round, peptides are sorted descending by RPM and
// plotted with rank on X and RPM on Y, both log₁₀-scaled.
//
// Interpretation:
//   - A straight line (linear on log-log) ≈ power law (Zipf / Pareto). Late
//     selection rounds usually look this way: a few peptides dominate, the
//     rest decay roughly as rank^{-α}.
//   - A concave curve (steeper at the head, levels off in the body) ≈ log-
//     normal. Early / unselected libraries look this way: many peptides at
//     similar frequency.
//   - The slope (α) on log-log gets steeper as selection converges.
//
// We compute two single-number summaries per round to make this quantitative:
//   - Power-law exponent α (slope on log-log via OLS).
//   - Gini coefficient (0 = uniform library, 1 = one peptide dominates).
//
// We subsample to ~200 log-spaced points per round so Recharts stays snappy
// even with 50 k peptides per round.

import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { PeptideRecord } from "./csvParse";

const PALETTE = [
  "hsl(188 78% 41%)", // teal-600 — primary
  "hsl(280 65% 55%)", // purple
  "hsl(35 92% 50%)", // orange
  "hsl(140 60% 45%)", // green
  "hsl(0 75% 60%)", // red
  "hsl(220 70% 55%)", // blue
];

const TARGET_POINTS = 200;

interface Props {
  rows: ReadonlyArray<PeptideRecord>;
  roundNames: ReadonlyArray<string>;
}

interface RoundSummary {
  round: string;
  n: number;
  gini: number;
  alpha: number; // -slope on log-log → power-law exponent
}

/** Standard Gini on sorted-ascending values:
 *  G = Σ_i (2i − n − 1) x_i / (n · Σ x_i). */
function giniCoefficient(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    sum += sorted[i]!;
    weighted += (2 * (i + 1) - n - 1) * sorted[i]!;
  }
  return sum > 0 ? weighted / (n * sum) : 0;
}

/** OLS slope of (log10 rank, log10 RPM) — head only, since the tail bends
 *  toward the noise floor and biases α downward if included naively. We use
 *  the top 80% of ranks to avoid the very-rare-singleton tail. */
function powerLawSlope(rpmsSortedDesc: number[]): number {
  const n = Math.floor(rpmsSortedDesc.length * 0.8);
  if (n < 3) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const v = rpmsSortedDesc[i]!;
    if (v <= 0) continue;
    const lr = Math.log10(i + 1);
    const lp = Math.log10(v);
    sx += lr;
    sy += lp;
    sxx += lr * lr;
    sxy += lr * lp;
    cnt++;
  }
  if (cnt < 2) return 0;
  const denom = cnt * sxx - sx * sx;
  if (denom === 0) return 0;
  return (cnt * sxy - sx * sy) / denom;
}

interface MergedPoint {
  rank: number; // log10 rank
  [round: string]: number | null;
}

export function RankAbundance({ rows, roundNames }: Props) {
  const data = useMemo(() => {
    if (rows.length === 0 || roundNames.length === 0) {
      return { points: [] as MergedPoint[], summaries: [] as RoundSummary[] };
    }

    const seriesByRound: Record<string, number[]> = {};
    const summaries: RoundSummary[] = [];
    for (const round of roundNames) {
      const rpms = rows
        .map((r) => r.rpm[round] ?? 0)
        .filter((v) => v > 0)
        .sort((a, b) => b - a);
      seriesByRound[round] = rpms;
      const slope = powerLawSlope(rpms);
      summaries.push({
        round,
        n: rpms.length,
        gini: giniCoefficient(rpms),
        alpha: -slope, // canonical α is positive
      });
    }

    const maxRank = Math.max(2, ...Object.values(seriesByRound).map((s) => s.length));
    const logMax = Math.log10(maxRank);
    const ranks: number[] = [];
    let lastRank = 0;
    for (let i = 0; i <= TARGET_POINTS; i++) {
      const r = Math.max(1, Math.round(Math.pow(10, (i / TARGET_POINTS) * logMax)));
      if (r !== lastRank) {
        ranks.push(r);
        lastRank = r;
      }
    }

    const points: MergedPoint[] = ranks.map((rank) => {
      const pt: MergedPoint = { rank: Math.log10(rank) };
      for (const round of roundNames) {
        const s = seriesByRound[round]!;
        pt[round] = rank <= s.length ? Math.log10(s[rank - 1]!) : null;
      }
      return pt;
    });

    return { points, summaries };
  }, [rows, roundNames]);

  if (data.summaries.every((s) => s.n === 0)) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        Rank-abundance plot needs at least one round with non-zero RPM.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3 lg:grid-cols-4">
        {data.summaries.map((s, i) => (
          <div key={s.round} className="rounded-md border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
              />
              <span className="font-medium">{s.round}</span>
            </div>
            <div className="mt-1 grid grid-cols-3 gap-1 text-[10px]">
              <div className="text-muted-foreground">Gini</div>
              <div className="text-muted-foreground">α</div>
              <div className="text-muted-foreground">N</div>
              <div className="font-mono">{s.gini.toFixed(2)}</div>
              <div className="font-mono">{s.alpha.toFixed(2)}</div>
              <div className="font-mono">{s.n.toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data.points}
            margin={{ top: 6, right: 16, left: 4, bottom: 26 }}
          >
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" />
            <XAxis
              dataKey="rank"
              type="number"
              tickFormatter={(v) => formatLog(Number(v))}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              label={{
                value: "rank",
                position: "insideBottom",
                offset: -16,
                style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
              }}
              domain={["dataMin", "dataMax"]}
            />
            <YAxis
              tickFormatter={(v) => formatLog(Number(v))}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              label={{
                value: "RPM",
                angle: -90,
                position: "insideLeft",
                offset: 14,
                style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
              }}
              width={50}
              domain={["dataMin", "dataMax"]}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                fontSize: 11,
              }}
              formatter={(v, key) => {
                if (v == null) return ["—", String(key)];
                const lin = Math.pow(10, Number(v));
                return [`${lin.toFixed(1)} RPM`, String(key)];
              }}
              labelFormatter={(v) => {
                const lin = Math.pow(10, Number(v));
                return `rank ≈ ${Math.round(lin).toLocaleString()}`;
              }}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} verticalAlign="top" height={20} />
            {roundNames.map((round, i) => (
              <Line
                key={round}
                type="monotone"
                dataKey={round}
                stroke={PALETTE[i % PALETTE.length] ?? "hsl(188 78% 41%)"}
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const SUPS: Record<string, string> = {
  "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

function formatLog(logVal: number): string {
  const rounded = Math.round(logVal);
  if (Math.abs(logVal - rounded) > 0.05) return "";
  return `10${String(rounded).split("").map((c) => SUPS[c] ?? c).join("")}`;
}
