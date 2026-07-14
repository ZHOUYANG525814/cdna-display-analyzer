import { useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Download, RefreshCw } from "lucide-react";
import { TARGETED_NANOPORE_METHODS } from "@cdna/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MethodsCard } from "@/components/MethodsCard";
import { TARGETED_EXPORT_FILES, exportTargetedOutcome, methodSettings, type TargetedExportSnapshot } from "@/adapters/TargetedNanoporeExporter";
import { useTargetedNanoporeStore } from "@/state/useTargetedNanoporeStore";

export function ResultsStep() {
  const s = useTargetedNanoporeStore();
  const o = s.runState.outcome;
  const [exporting, setExporting] = useState(false);
  if (!o) return <div className="space-y-4"><p>No completed run is available.</p><Button onClick={() => s.setStep("run")}>Go to Run</Button></div>;
  const last = o.roundNames[o.roundNames.length - 1]!;
  const total = o.roundNames.reduce((n, r) => n + o.statsByRound[r]!.total_reads, 0);
  const full = o.roundNames.reduce((n, r) => n + o.statsByRound[r]!.full_qc_passed, 0);
  const callable = o.roundNames.reduce((n, r) => n + o.siteNames.reduce((m, site) => m + o.statsByRound[r]!.sites[site]!.passed_qc, 0), 0);
  const scored = o.hitCounts.reduce((n, hit) => n + hit.total, 0);
  const snapshot: TargetedExportSnapshot = { projectName: s.projectName, referenceSeq: s.referenceSeq, cdsStart: s.cdsStart, cdsEnd: s.cdsEnd, cdsStrand: s.cdsStrand, sites: s.sites, settings: s.settings, reportHaplotypes: s.reportHaplotypes, startedAt: s.runState.startedAt, finishedAt: s.runState.finishedAt };
  const downloadAll = async () => { setExporting(true); try { await exportTargetedOutcome(o, snapshot); } finally { setExporting(false); } };
  return <div className="space-y-6">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Total reads" value={total} /><Metric label="Full-read QC passed" value={full} note={`${pct(full, total)} yield`} /><Metric label="Callable site observations" value={callable} note="full + independently rescued" /><Metric label="Scored comparisons" value={scored} note="eligible variant × round tests" /></div>

    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Download complete results</CardTitle><CardDescription>Mirrors the NGS result package while retaining Nanopore-specific funnels and lossless DNA counts. Large count tables are stream-compressed as gzip.</CardDescription></div><Button onClick={() => void downloadAll()} disabled={exporting}><Download className="mr-2 h-4 w-4" />{exporting ? "Preparing…" : "Download all"}</Button></div></CardHeader><CardContent><div className="grid gap-x-6 gap-y-2 text-xs md:grid-cols-2">{TARGETED_EXPORT_FILES.map(([name, description]) => {
      const conditional = name.includes("Haplotype") && (!s.reportHaplotypes || o.siteNames.length < 2);
      return <div key={name} className="flex gap-2"><span className="font-mono text-foreground">{name}</span><span className="text-muted-foreground">— {conditional ? "not generated for this run" : description}</span></div>;
    })}</div><p className="mt-3 text-xs text-muted-foreground">Your browser may ask permission for multiple downloads. Input FASTQ sequences are never copied into outputs; all aggregate counts, QC counters, settings and provenance are exported.</p></CardContent></Card>

    <MethodsCard doc={TARGETED_NANOPORE_METHODS} settings={methodSettings(snapshot)} libraryMedian={o.libraryMedianFitness} hitCounts={o.hitCounts} />

    <Card><CardHeader><CardTitle>QC logic and abnormal events</CardTitle><CardDescription>The central rule is to preserve valid site evidence without allowing uncertain sequence to become a false variant.</CardDescription></CardHeader><CardContent className="grid gap-3 text-sm md:grid-cols-2">
      <Logic title="Substitution outside targets">Retained while target-masked protected identity passes. Many fixed-region mismatches lower identity and can indicate a wrong reference or poor base-calling.</Logic>
      <Logic title="Substitution inside a target">Called only when all three codon bases are projected, unambiguous and ≥ target Q. Intended NNK changes do not penalize protected identity.</Logic>
      <Logic title="Insertion / deletion at a target">Only the overlapping site becomes non-callable and enters target_indel. A valid distant site on the same read is retained.</Logic>
      <Logic title="Insertion / deletion in protected sequence">Small events are CIGAR-projected and tolerated up to the fixed 30-nt budget. Larger protected disruption fails the whole read.</Logic>
      <Logic title="Partial read rescue">A site can be counted with two passing 30-nt flanks. It contributes to per-site counts but never to a multi-site haplotype.</Logic>
      <Logic title="Off-NNK and stop calls">Kept in exact counts and callability QC as evidence of synthesis error, base-calling error or unexpected biology; never silently converted to WT.</Logic>
    </CardContent></Card>

    <Card><CardHeader><CardTitle>Per-round sequencing yield</CardTitle><CardDescription>Comparable to the NGS yield table, with full-reference alignment and site rescue shown separately.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full text-right text-xs"><thead><tr><th className="text-left">Round</th><th>Total reads</th><th>Aligned</th><th>Full QC</th><th>Full yield</th><th>Callable sites</th><th>Rescued sites</th><th>Haplotypes</th></tr></thead><tbody>{o.roundNames.map((round) => { const x = o.statsByRound[round]!; const c = o.siteNames.reduce((n, site) => n + x.sites[site]!.passed_qc, 0); const rescued = o.siteNames.reduce((n, site) => n + x.sites[site]!.callable_rescued, 0); return <tr className="border-t" key={round}><td className="text-left font-medium">{round}</td><td>{x.total_reads.toLocaleString()}</td><td>{x.aligned.toLocaleString()}</td><td>{x.full_qc_passed.toLocaleString()}</td><td>{pct(x.full_qc_passed, x.total_reads)}</td><td>{c.toLocaleString()}</td><td>{rescued.toLocaleString()}</td><td>{x.haplotype_passed_qc.toLocaleString()}</td></tr>; })}</tbody></table></CardContent></Card>

    <Card><CardHeader><CardTitle>Nanopore QC funnel</CardTitle><CardDescription>These primary reasons are exclusive, so the total can be audited without double counting. Overlapping diagnostics remain in run_stats.json.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full text-right text-xs"><thead><tr><th className="text-left">Round</th><th>Malformed</th><th>Duplicate</th><th>Low read Q</th><th>Concatemer</th><th>Alignment fail</th><th>Partial</th><th>Low align ID</th><th>Low protected ID</th><th>Protected indel</th></tr></thead><tbody>{o.roundNames.map((round) => { const x = o.statsByRound[round]!, d = x.primary_drop_reasons; return <tr className="border-t" key={round}><td className="text-left font-medium">{round}</td><td>{d.malformed_fastq}</td><td>{d.duplicate_read_id}</td><td>{d.low_read_q}</td><td>{d.concatemer_or_chimera}</td><td>{d.alignment_failed}</td><td>{d.partial_reference}</td><td>{d.low_alignment_identity}</td><td>{d.low_protected_identity}</td><td>{d.protected_indel}</td></tr>; })}</tbody></table></CardContent></Card>

    <Card><CardHeader><CardTitle>Site callability</CardTitle><CardDescription>Full and rescued calls form each site's denominator; only full-QC calls form haplotypes.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full text-right text-xs"><thead><tr><th className="text-left">Round / site</th><th>Callable</th><th>Full</th><th>Rescued</th><th>WT</th><th>Target indel</th><th>Low base Q</th><th>Not covered</th><th>Ambiguous</th><th>Off-NNK</th><th>Stop</th></tr></thead><tbody>{o.roundNames.flatMap((round) => o.siteNames.map((site) => { const x = o.statsByRound[round]!.sites[site]!; return <tr className="border-t" key={`${round}:${site}`}><td className="text-left">{round} / {site}</td><td>{x.passed_qc}</td><td>{x.callable_full}</td><td>{x.callable_rescued}</td><td>{x.wt_count}</td><td>{x.target_indel}</td><td>{x.low_quality}</td><td>{x.not_covered}</td><td>{x.ambiguous}</td><td>{x.off_design}</td><td>{x.stop_codon}</td></tr>; }))}</tbody></table></CardContent></Card>

    <Card><CardHeader><CardTitle>Enrichment preview</CardTitle><CardDescription>Same statistical convention as the existing Nanopore/NGS helper layer. Downloaded CSV contains every row; this table previews up to 100.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full text-right text-xs"><thead><tr><th className="text-left">Site</th><th className="text-left">AA</th><th className="text-left">Dominant DNA</th><th>Score?</th><th>Count R0</th><th>Count {last}</th><th>Fitness</th><th>Centered</th><th>Variance</th><th>FDR q</th></tr></thead><tbody>{o.perSiteRowsPreview.slice(0, 100).map((row, i) => <tr className="border-t" key={i}><td className="text-left">{row.Site}</td><td className="text-left">{row.Variant_AA}</td><td className="text-left font-mono">{row.Dominant_DNA}</td><td>{row.Score_Eligible === "yes" ? "yes" : "—"}</td><td>{Number(row["Count_Round 0"] ?? 0).toLocaleString()}</td><td>{Number(row[`Count_${last}`] ?? 0).toLocaleString()}</td><td>{fmt(row[`Fitness_vs_WT_${last}`])}</td><td>{fmt(row[`Centered_Fitness_${last}`])}</td><td>{fmt(row[`Var_Fitness_${last}`])}</td><td>{fmt(row[`FDR_q_${last}`])}</td></tr>)}</tbody></table></CardContent></Card>

    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"><AlertTriangle className="mr-2 inline h-4 w-4" /><strong>Low-throughput interpretation:</strong> Nanopore data often lack enough independent counts for stable tail inference. No replicate dispersion is estimated, so Z/p/FDR are count-model diagnostics and generally overstate certainty relative to biological replicates. NGS-style diversity/logo plots are intentionally omitted when they add visual confidence without statistical support.</div>
    <div className="flex flex-wrap justify-between gap-2"><Button variant="outline" onClick={() => s.setStep("run")}><ArrowLeft className="mr-2 h-4 w-4" />Back to run</Button><Button onClick={s.prepareNextRun}><RefreshCw className="mr-2 h-4 w-4" />Next run</Button></div>
    <p className="text-center text-xs text-muted-foreground">Next run preserves the reference, CDS, target sites and QC values, but clears project name, FASTQ assignments and results.</p>
  </div>;
}

function Metric({ label, value, note }: { label: string; value: number; note?: string }) { return <Card><CardContent className="pt-5"><div className="text-xs text-muted-foreground">{label}</div><div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>{note && <div className="text-[11px] text-muted-foreground">{note}</div>}</CardContent></Card>; }
function Logic({ title, children }: { title: string; children: ReactNode }) { return <div className="rounded-md border p-3"><div className="mb-1 font-medium">{title}</div><p className="text-xs text-muted-foreground">{children}</p></div>; }
function pct(value: number, denominator: number): string { return `${(denominator ? value / denominator * 100 : 0).toFixed(2)}%`; }
function fmt(value: unknown): string { if (value == null || value === "") return "—"; const n = Number(value); return Number.isFinite(n) ? n.toFixed(4) : "—"; }
