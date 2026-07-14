import { useMemo } from "react";
import type { NanoporeAnalyzerRow } from "@cdna/core";
import { ChartPanel } from "@/tools/cdna-display/viz/ChartPanel";

const FALLBACK_COLOR = "#9CA3AF";
const COLORS: Record<string, string> = { A:"#B58900",V:"#B58900",L:"#B58900",I:"#B58900",M:"#B58900",F:"#B58900",W:"#B58900",P:"#B58900",S:"#16A34A",T:"#16A34A",N:"#16A34A",Q:"#16A34A",K:"#2563EB",R:"#2563EB",H:"#2563EB",D:"#DC2626",E:"#DC2626",G:"#6B7280",C:"#6B7280",Y:"#6B7280","*":"#000000",X:FALLBACK_COLOR };
const MAX_BITS = Math.log2(20), COL_W = 32, PLOT_H = 132, AXIS_W = 34, MAX_SITES = 96;

interface Props { rows: ReadonlyArray<NanoporeAnalyzerRow>; roundNames: ReadonlyArray<string>; siteNames: ReadonlyArray<string>; }
interface Letter { aa: string; bits: number; }
interface Column { site: string; letters: Letter[]; total: number; }

export function TargetSiteSequenceLogo({ rows, roundNames, siteNames }: Props) {
  const visibleSites = siteNames.slice(0, MAX_SITES);
  const panels = useMemo(() => roundNames.map((round) => ({ round, columns: buildColumns(rows, round, visibleSites) })), [rows, roundNames, visibleSites.join("|")]);
  if (!rows.length) return <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No callable amino-acid counts are available for a sequence logo.</div>;
  return <div className="space-y-5">{panels.map((panel) => <div key={panel.round}><div className="mb-2 flex justify-between text-xs"><span className="font-medium">{panel.round}</span><span className="text-muted-foreground">read-count weighted · {visibleSites.length} targets</span></div><ChartPanel filename={`nanopore_target_logo_${panel.round}`}><Logo columns={panel.columns} /></ChartPanel></div>)}{siteNames.length > MAX_SITES && <p className="text-xs text-muted-foreground">Logo display is capped at the first {MAX_SITES} targets for browser safety; the master matrix contains all targets.</p>}<p className="text-xs text-muted-foreground">Letter height = amino-acid frequency × information content. Unlike a whole-protein NGS logo, each column is one user-confirmed target codon.</p></div>;
}

function buildColumns(rows: ReadonlyArray<NanoporeAnalyzerRow>, round: string, sites: ReadonlyArray<string>): Column[] {
  return sites.map((site) => {
    const counts = new Map<string, number>(); let total = 0;
    for (const row of rows) if (row.Target === site) { const aa = String(row.Variant_AA); const count = Math.max(0, Number(row[`Count_${round}`]) || 0); counts.set(aa, (counts.get(aa) ?? 0) + count); total += count; }
    let entropy = 0; for (const count of counts.values()) if (count > 0 && total > 0) { const f = count / total; entropy -= f * Math.log2(f); }
    const information = total ? Math.max(0, MAX_BITS - entropy) : 0;
    const letters = [...counts].filter(([, count]) => count > 0).map(([aa, count]) => ({ aa, bits: count / total * information })).sort((a, b) => a.bits - b.bits);
    return { site, letters, total };
  });
}

function Logo({ columns }: { columns: Column[] }) {
  const width = AXIS_W + columns.length * COL_W + 8, height = PLOT_H + 35;
  return <div className="overflow-x-auto rounded-md border bg-white p-2"><svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: width, maxHeight: height }}><line x1={AXIS_W} y1={4} x2={AXIS_W} y2={PLOT_H + 4} stroke="#d1d5db" />{[0,2,4].map((v) => { const y = PLOT_H + 4 - v / MAX_BITS * PLOT_H; return <g key={v}><line x1={AXIS_W-3} y1={y} x2={AXIS_W} y2={y} stroke="#9ca3af"/><text x={AXIS_W-5} y={y+3} fontSize="8" fill="#6b7280" textAnchor="end">{v}</text></g>; })}{columns.map((col, index) => { let bottom = PLOT_H + 4; const x = AXIS_W + index * COL_W; return <g key={col.site}>{col.letters.map((letter) => { const h = letter.bits / MAX_BITS * PLOT_H; if (h < 1) return null; const top = bottom - h; const node = <LogoLetter key={letter.aa} aa={letter.aa} color={COLORS[letter.aa] ?? FALLBACK_COLOR} x={x} y={top} width={COL_W - 2} height={h} />; bottom = top; return node; })}<text x={x + COL_W / 2} y={PLOT_H + 20} textAnchor="middle" fontSize="8" fill="#4b5563" transform={`rotate(35 ${x + COL_W / 2} ${PLOT_H + 20})`}>{col.site}</text></g>; })}</svg></div>;
}

function LogoLetter({ aa, color, x, y, width, height }: { aa: string; color: string; x: number; y: number; width: number; height: number }) {
  const natural = 16, capRatio = .72, scaleY = height / (natural * capRatio);
  return <g transform={`translate(${x}, ${y}) scale(1, ${scaleY})`}><text x={width / 2} y={natural * capRatio} fontSize={natural} fontFamily="IBM Plex Mono, ui-monospace, monospace" fontWeight={700} fill={color} textAnchor="middle" textLength={width} lengthAdjust="spacingAndGlyphs">{aa}</text></g>;
}
