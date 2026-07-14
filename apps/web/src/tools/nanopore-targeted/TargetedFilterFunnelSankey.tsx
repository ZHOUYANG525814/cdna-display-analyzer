import { useMemo } from "react";
import { ResponsiveContainer, Sankey, Tooltip } from "recharts";
import type { TargetedNanoporeOutcome } from "@/worker/types";
import { ChartPanel } from "@/tools/cdna-display/viz/ChartPanel";
import { buildTargetedSankeyData, type TargetedSankeyNode } from "./viz";

export function TargetedFilterFunnelSankey({ outcome }: { outcome: TargetedNanoporeOutcome }) {
  const data = useMemo(() => buildTargetedSankeyData(outcome), [outcome]);
  if (!data.links.length) return <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">No reads to chart.</div>;
  const height = Math.max(300, data.nodes.length * 17);
  return <ChartPanel filename="nanopore_filter_funnel_sankey"><div style={{ height }}><ResponsiveContainer width="100%" height="100%"><Sankey data={data} nodePadding={12} nodeWidth={12} margin={{ left: 105, right: 145, top: 8, bottom: 8 }} link={{ stroke: "hsl(var(--muted-foreground))", strokeOpacity: .16 }} node={NodeRect as never}><Tooltip formatter={(value) => Number(value).toLocaleString()} contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }} /></Sankey></ResponsiveContainer></div></ChartPanel>;
}

function NodeRect(props: { x: number; y: number; width: number; height: number; payload: TargetedSankeyNode & { value: number }; containerWidth: number }) {
  const { x, y, width, height, payload, containerWidth } = props;
  const left = x < containerWidth / 2;
  const color = payload.kind === "pass" ? "hsl(var(--success))" : payload.kind === "drop" ? "hsl(var(--warning))" : "hsl(var(--primary))";
  return <g><rect x={x} y={y} width={width} height={height} rx={2} fill={color} fillOpacity={.86}/><text textAnchor={left ? "start" : "end"} x={left ? x + width + 6 : x - 6} y={y + height / 2} dy=".355em" fontSize={10} fill="hsl(var(--foreground))">{payload.name}<tspan fill="hsl(var(--muted-foreground))"> · {payload.value.toLocaleString()}</tspan></text></g>;
}
