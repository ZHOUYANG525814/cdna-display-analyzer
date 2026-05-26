// Sequence logo — WebLogo-style stacked-letter motif viewer.
//
// For each round we take the top-N peptides by read count, restrict to the
// modal peptide length (so positions actually align), and render each column
// as a stack of letters with height ∝ information content × frequency.
//
// Information content per position = log₂(20) − H_pos, where H_pos is the
// Shannon entropy of the AA distribution at that position. A fully conserved
// column has IC = log₂(20) ≈ 4.32 bits; a uniformly-random column has IC = 0.
//
// Implementation is pure SVG — no external logo library, ~150 lines total.
// Letters are scaled with `textLength` + `lengthAdjust` for true variable
// width-fill, and `transform="scale(1, sy)"` for the vertical stretch so the
// glyph height matches its information weight.
//
// Color scheme: Clustal-style biochemistry groups (hydrophobic gold, polar
// green, basic blue, acidic red, special grey). Standard in publication.

import { useMemo } from "react";
import type { PeptideRecord } from "./csvParse";

const TOP_N_PER_ROUND = 100;
const MAX_LENGTH = 32; // truncate ultra-long peptides so the logo stays readable

const COLOR_BY_AA: Record<string, string> = {
  // Hydrophobic
  A: "#B58900", V: "#B58900", L: "#B58900", I: "#B58900", M: "#B58900",
  F: "#B58900", W: "#B58900", P: "#B58900",
  // Polar uncharged
  S: "#16A34A", T: "#16A34A", N: "#16A34A", Q: "#16A34A",
  // Basic
  K: "#2563EB", R: "#2563EB", H: "#2563EB",
  // Acidic
  D: "#DC2626", E: "#DC2626",
  // Special
  G: "#6B7280", C: "#6B7280", Y: "#6B7280",
  "*": "#000000",
  X: "#9CA3AF",
};

interface LetterStack {
  aa: string;
  height: number; // in bits
  color: string;
}

interface PositionColumn {
  position: number;
  totalBits: number;
  letters: LetterStack[]; // sorted ascending so smallest renders at the bottom
}

interface RoundLogo {
  round: string;
  positions: PositionColumn[];
  aligned: number;
  modalLength: number;
  total: number;
}

function buildLogo(round: string, rows: ReadonlyArray<PeptideRecord>): RoundLogo {
  // Pick the top-N peptides by count in this specific round (NOT the matrix's
  // global sort — round-specific gives the right answer per round).
  const sortedByRoundCount = [...rows]
    .filter((r) => (r.count[round] ?? 0) > 0)
    .sort((a, b) => (b.count[round] ?? 0) - (a.count[round] ?? 0));
  const top = sortedByRoundCount.slice(0, TOP_N_PER_ROUND);

  // Modal-length filter: AA positions are only meaningful when sequences are
  // the same length. Cluster by length; keep the largest cluster.
  const lengthCounts = new Map<number, number>();
  for (const r of top) {
    lengthCounts.set(r.peptide.length, (lengthCounts.get(r.peptide.length) ?? 0) + 1);
  }
  let modalLength = 0;
  let modalCount = 0;
  for (const [L, c] of lengthCounts) {
    if (c > modalCount) {
      modalLength = L;
      modalCount = c;
    }
  }
  if (modalLength === 0) {
    return { round, positions: [], aligned: 0, modalLength: 0, total: top.length };
  }

  const aligned = top.filter((r) => r.peptide.length === modalLength);
  const L = Math.min(modalLength, MAX_LENGTH);
  const positions: PositionColumn[] = [];
  for (let p = 0; p < L; p++) {
    const freq = new Map<string, number>();
    for (const r of aligned) {
      const aa = r.peptide.charAt(p).toUpperCase();
      freq.set(aa, (freq.get(aa) ?? 0) + 1);
    }
    const N = aligned.length;
    // Shannon entropy → information content.
    let H = 0;
    for (const c of freq.values()) {
      const f = c / N;
      if (f > 0) H -= f * Math.log2(f);
    }
    const IC = Math.max(0, Math.log2(20) - H);

    const letters: LetterStack[] = [];
    for (const [aa, c] of freq) {
      const f = c / N;
      const h = f * IC;
      if (h > 0.005) {
        letters.push({ aa, height: h, color: COLOR_BY_AA[aa] ?? "#9CA3AF" });
      }
    }
    letters.sort((a, b) => a.height - b.height);
    positions.push({ position: p + 1, totalBits: IC, letters });
  }
  return { round, positions, aligned: aligned.length, modalLength, total: top.length };
}

interface Props {
  rows: ReadonlyArray<PeptideRecord>;
  roundNames: ReadonlyArray<string>;
}

export function SequenceLogo({ rows, roundNames }: Props) {
  const logos = useMemo<RoundLogo[]>(() => {
    return roundNames.map((r) => buildLogo(r, rows));
  }, [rows, roundNames]);

  const renderable = logos.filter((l) => l.positions.length > 0);
  if (renderable.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        Not enough same-length peptides to build a logo.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {logos.map((l, i) =>
        l.positions.length === 0 ? null : (
          <div key={i}>
            <div className="mb-2 flex items-baseline justify-between text-xs">
              <span className="font-medium">{l.round}</span>
              <span className="font-mono text-muted-foreground">
                top {TOP_N_PER_ROUND} · {l.aligned.toLocaleString()} aligned at {l.modalLength} aa
              </span>
            </div>
            <LogoSvg logo={l} />
          </div>
        ),
      )}
      <ColorLegend />
    </div>
  );
}

const COL_W = 22;
const PLOT_H = 120;
const AXIS_W = 32;
const LABEL_H = 18;
const MAX_BITS = Math.log2(20);

function LogoSvg({ logo }: { logo: RoundLogo }) {
  const W = AXIS_W + logo.positions.length * COL_W + 8;
  const H = PLOT_H + LABEL_H + 6;

  return (
    <div className="overflow-x-auto rounded-md border bg-white p-2">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: W, maxHeight: H }}>
        {/* y-axis line */}
        <line
          x1={AXIS_W}
          y1={4}
          x2={AXIS_W}
          y2={PLOT_H + 4}
          stroke="hsl(var(--border))"
          strokeWidth={1}
        />
        {/* y-axis ticks: 0, half, max */}
        {[0, MAX_BITS / 2, MAX_BITS].map((v) => {
          const y = PLOT_H + 4 - (v / MAX_BITS) * PLOT_H;
          return (
            <g key={v}>
              <line
                x1={AXIS_W - 3}
                y1={y}
                x2={AXIS_W}
                y2={y}
                stroke="hsl(var(--border))"
                strokeWidth={1}
              />
              <text
                x={AXIS_W - 5}
                y={y + 3}
                fontSize={9}
                fill="hsl(var(--muted-foreground))"
                textAnchor="end"
              >
                {v.toFixed(1)}
              </text>
            </g>
          );
        })}
        <text
          x={10}
          y={PLOT_H / 2 + 4}
          fontSize={9}
          fill="hsl(var(--muted-foreground))"
          textAnchor="middle"
          transform={`rotate(-90, 10, ${PLOT_H / 2 + 4})`}
        >
          bits
        </text>

        {logo.positions.map((col) => {
          const x = AXIS_W + (col.position - 1) * COL_W;
          let yBottom = PLOT_H + 4;
          return (
            <g key={col.position}>
              {col.letters.map((l) => {
                const h = (l.height / MAX_BITS) * PLOT_H;
                if (h < 1) {
                  return null;
                }
                const yTop = yBottom - h;
                const node = (
                  <LogoLetter
                    key={l.aa}
                    aa={l.aa}
                    color={l.color}
                    x={x}
                    y={yTop}
                    width={COL_W - 2}
                    height={h}
                  />
                );
                yBottom = yTop;
                return node;
              })}
              <text
                x={x + COL_W / 2}
                y={PLOT_H + LABEL_H}
                fontSize={9}
                fill="hsl(var(--muted-foreground))"
                textAnchor="middle"
              >
                {col.position}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LogoLetter({
  aa,
  color,
  x,
  y,
  width,
  height,
}: {
  aa: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  // Trick to get true variable-height letters: render a fixed-em-size glyph
  // then scale the wrapping <g> non-uniformly. textLength stretches the
  // horizontal axis to exactly `width`. The vertical scale uses an empirical
  // factor for cap-height-to-em ratio of ~0.72 (IBM Plex Mono Bold).
  const NATURAL = 16;
  const CAP_RATIO = 0.72;
  const sy = height / (NATURAL * CAP_RATIO);
  return (
    <g transform={`translate(${x}, ${y}) scale(1, ${sy})`}>
      <text
        x={width / 2}
        y={NATURAL * CAP_RATIO}
        fontSize={NATURAL}
        fontFamily="IBM Plex Mono, ui-monospace, monospace"
        fontWeight={700}
        fill={color}
        textAnchor="middle"
        textLength={width}
        lengthAdjust="spacingAndGlyphs"
      >
        {aa}
      </text>
    </g>
  );
}

function ColorLegend() {
  const groups: Array<{ label: string; color: string; aas: string }> = [
    { label: "Hydrophobic", color: "#B58900", aas: "A V L I M F W P" },
    { label: "Polar", color: "#16A34A", aas: "S T N Q" },
    { label: "Basic", color: "#2563EB", aas: "K R H" },
    { label: "Acidic", color: "#DC2626", aas: "D E" },
    { label: "Special", color: "#6B7280", aas: "G C Y" },
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
      {groups.map((g) => (
        <span key={g.label} className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: g.color }}
          />
          <span className="font-medium">{g.label}</span>
          <span className="font-mono">{g.aas}</span>
        </span>
      ))}
    </div>
  );
}
