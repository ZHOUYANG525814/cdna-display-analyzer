// Sankey diagram of the read-filtering funnel:
//   Total reads → {low_quality | no_anchor | ambiguous | barcode_mismatch | per-round assigned}
//   per-round assigned → {discard_truncated | discard_stop_codon | passed_qc}
//
// Read this as "which buckets are bleeding reads": wide bands going to discards
// mean tightening primers or QC thresholds would help; wide bands to passed_qc
// mean the library + chemistry are good.
//
// Note: discard_length_indel is intentionally omitted — when the CDS window is
// frozen by absolute offsets from the Fw anchor end, the engine cannot detect
// length indels independently, so the bucket is always zero and would clutter
// the diagram.

import { useMemo } from "react";
import { Sankey, Tooltip, ResponsiveContainer } from "recharts";
import type { PipelineOutcome } from "@/worker/types";
import { ChartPanel } from "./ChartPanel";

interface SankeyNode {
  name: string;
}
interface SankeyLink {
  source: number;
  target: number;
  value: number;
}

// Color tokens (HSL strings) — keep in sync with tailwind / shadcn palette.
const COLOR_TOTAL = "hsl(var(--primary))";
const COLOR_ROUND = "hsl(var(--primary))";
const COLOR_PASSED = "hsl(var(--success))";
const COLOR_DISCARD = "hsl(var(--warning))";
const COLOR_UNASSIGNED = "hsl(var(--destructive))";

function classifyNode(name: string): string {
  if (name === "Total reads") return COLOR_TOTAL;
  if (name.startsWith("Round_")) return COLOR_ROUND;
  if (name.startsWith("Passed QC ")) return COLOR_PASSED;
  if (name.startsWith("Truncated ") || name.startsWith("Stop ") || name.startsWith("Low-Q CDS "))
    return COLOR_DISCARD;
  return COLOR_UNASSIGNED;
}

// Custom rectangle: rounded corners + palette-aware fill. Recharts default
// rectangles are flat and grey; this is the single biggest aesthetic win.
function SankeyNodeRect(props: {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: SankeyNode & { value: number };
  containerWidth: number;
}) {
  const { x, y, width, height, payload, containerWidth } = props;
  const isOnLeftHalf = x < containerWidth / 2;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={classifyNode(payload.name)}
        fillOpacity={0.85}
        rx={2}
      />
      <text
        textAnchor={isOnLeftHalf ? "start" : "end"}
        x={isOnLeftHalf ? x + width + 6 : x - 6}
        y={y + height / 2}
        dy="0.355em"
        fontSize={11}
        fill="hsl(var(--foreground))"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {payload.name}
        <tspan fill="hsl(var(--muted-foreground))"> · {payload.value.toLocaleString()}</tspan>
      </text>
    </g>
  );
}

interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

/** Build the {nodes, links} structure consumed by Recharts' Sankey from the
 *  pipeline outcome. Zero-valued links are dropped — Sankey renders them as
 *  artifacts otherwise. */
function buildSankeyData(outcome: PipelineOutcome): SankeyData {
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const addNode = (name: string): number => {
    nodes.push({ name });
    return nodes.length - 1;
  };
  const addLink = (source: number, target: number, value: number) => {
    if (value > 0) links.push({ source, target, value });
  };

  const total = addNode("Total reads");

  // Left fan-out — unassigned buckets that capture reads before any round.
  const u = outcome.unassignedBreakdown;
  const nLowQ = addNode("Low Q-score");
  const nNoAnchor = addNode("No Fw anchor");
  const nAmbig = addNode("Ambiguous primer");
  const nBcMis = addNode("Barcode mismatch");
  addLink(total, nLowQ, u.low_quality);
  addLink(total, nNoAnchor, u.no_anchor);
  addLink(total, nAmbig, u.ambiguous);
  addLink(total, nBcMis, u.barcode_mismatch);

  // Per-round funnel.
  for (const roundName of outcome.roundNames) {
    const s = outcome.statsByRound[roundName];
    if (!s) continue;
    const rNode = addNode(roundName);
    addLink(total, rNode, s.total_assigned);

    addLink(rNode, addNode(`Truncated · ${roundName}`), s.discard_truncated);
    addLink(rNode, addNode(`Low-Q CDS · ${roundName}`), s.discard_low_quality_cds ?? 0);
    addLink(rNode, addNode(`Stop · ${roundName}`), s.discard_stop_codon);
    addLink(rNode, addNode(`Passed QC · ${roundName}`), s.passed_qc);
  }

  return { nodes, links };
}

export function FilterFunnelSankey({ outcome }: { outcome: PipelineOutcome }) {
  const data = useMemo(() => buildSankeyData(outcome), [outcome]);

  // Sparse-data guard: if NO reads were processed (empty FASTQ), Recharts'
  // Sankey draws a degenerate diagram. Show a friendly placeholder instead.
  const totalLinks = data.links.reduce((acc, l) => acc + l.value, 0);
  if (totalLinks === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        No reads to chart — pipeline returned an empty dataset.
      </div>
    );
  }

  // Height scales with the number of nodes so labels don't collide on big runs.
  const height = Math.max(280, data.nodes.length * 18);

  return (
    <ChartPanel filename="filter_funnel_sankey" className="w-full" >
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            nodePadding={14}
            nodeWidth={12}
            margin={{ left: 110, right: 130, top: 8, bottom: 8 }}
            link={{ stroke: "hsl(var(--muted-foreground))", strokeOpacity: 0.15 }}
            node={SankeyNodeRect as never}
          >
            <Tooltip
              formatter={(value) => Number(value).toLocaleString()}
              contentStyle={{
                background: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                fontSize: 12,
              }}
            />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </ChartPanel>
  );
}
