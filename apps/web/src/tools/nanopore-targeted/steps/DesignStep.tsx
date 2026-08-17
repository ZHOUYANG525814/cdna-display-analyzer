import { useMemo, useState } from "react";
import { normalizeReference, translateDna } from "@cdna/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { targetedDesignErrors, useTargetedNanoporeStore } from "@/state/useTargetedNanoporeStore";
import { sanitizeDna } from "@/lib/validation";
import { NANOPORE_INPUT_LIMITS } from "../inputValidation";
import { aminoAcidTargetLabel } from "../targetNaming";

export function DesignStep() {
  const s = useTargetedNanoporeStore();
  const [direct, setDirect] = useState("");
  const reference = normalizeReference(s.referenceSeq);
  const cdsEnd = s.cdsEnd || reference.length;
  const codons = useMemo(() => {
    if (!reference || s.cdsStart < 1 || cdsEnd > reference.length || cdsEnd < s.cdsStart) return [];
    const out: Array<{ aaPos: number; ntStart: number; dna: string; aa: string }> = [];
    for (let nt = s.cdsStart, aaPos = 1; nt + 2 <= cdsEnd; nt += 3, aaPos++) {
      const dna = reference.slice(nt - 1, nt + 2);
      out.push({ aaPos, ntStart: nt, dna, aa: /N/.test(dna) ? "?" : translateDna(dna) });
    }
    return out;
  }, [reference, s.cdsStart, cdsEnd]);
  const errors = targetedDesignErrors({ ...s, cdsEnd });

  const addDirect = () => {
    const values = direct.split(/[\s,;]+/).filter(Boolean);
    for (const token of values) {
      const ntMode = /^nt:/i.test(token);
      const value = Number(token.replace(/^(?:aa|nt):/i, ""));
      if (!Number.isInteger(value) || value < 1) continue;
      const selected = ntMode ? codons.find((c) => c.ntStart === value) : codons.find((c) => c.aaPos === value);
      if (selected) s.addSiteByNt(selected.ntStart);
    }
    setDirect("");
  };

  return <div className="space-y-6">
    <Card><CardHeader><CardTitle>Reference and CDS</CardTitle><CardDescription>Paste the full amplicon in the coding orientation. For a reverse-strand CDS, paste its reverse complement as the reference.</CardDescription></CardHeader>
      <CardContent className="space-y-3"><Textarea className="min-h-32 font-mono" placeholder="Amplicon reference (FASTA header optional)" value={s.referenceSeq} onChange={(e) => {
        const v = sanitizeDna(e.target.value.replace(/^>[^\n]*\n/, ""), NANOPORE_INPUT_LIMITS.maxReferenceBases); s.setReferenceSeq(v); if (!s.cdsEnd) s.setCds({ cdsEnd: v.length });
      }} /><div className="grid grid-cols-2 gap-3"><label className="text-xs">CDS start (nt, 1-based)<Input type="number" value={s.cdsStart} onChange={(e) => s.setCds({ cdsStart: Number(e.target.value) })} /></label><label className="text-xs">CDS end (inclusive)<Input type="number" value={cdsEnd} onChange={(e) => s.setCds({ cdsEnd: Number(e.target.value) })} /></label></div></CardContent></Card>

    <Card><CardHeader><CardTitle>Target codons</CardTitle><CardDescription>Select one or more codons. Distant targets can be linked when one read covers the full amplicon.</CardDescription></CardHeader>
      <CardContent className="space-y-3"><div className="grid gap-3 lg:grid-cols-2"><div className="flex gap-2 self-start"><Input value={direct} onChange={(e) => setDirect(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addDirect(); }} placeholder="AA:116,117 or nt:346"/><Button variant="outline" onClick={addDirect}>Add</Button></div><div className="rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><strong className="text-foreground">How target positions are defined</strong><p className="mt-1">Choose the codons intentionally diversified in the library (for example, NNK sites) from the experimental design or reference annotation. <code>AA:n</code> counts from the CDS start; <code>nt:n</code> is the 1-based first nucleotide in the full amplicon and must fall on a CDS codon boundary.</p><p className="mt-1">Targets are calling coordinates, not alignment anchors. Orientation and alignment use the amplicon reference; the selected codons are masked only when protected-region identity is calculated. With 2+ targets, linkage is reported only when one full-QC read calls every target.</p></div></div>
        <div className="max-h-56 overflow-auto rounded border p-2"><div className="flex flex-wrap gap-1">{codons.map((c) => { const active = s.sites.some((x) => x.ntStart === c.ntStart); return <button key={c.ntStart} type="button" onClick={() => active ? s.removeSite(s.sites.find((x) => x.ntStart === c.ntStart)!.id) : s.addSiteByNt(c.ntStart)} className={`w-14 rounded border px-1 py-1 font-mono text-xs ${active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"}`} title={`AA ${c.aaPos}; nt ${c.ntStart}-${c.ntStart + 2}; ${c.dna}`}>{c.aa}{c.aaPos}</button>; })}</div></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Target</th><th>AA position</th><th>nt</th><th>Reference</th><th>Context (±3 aa)</th><th /></tr></thead><tbody>{s.sites.map((site) => { const c = codons.find((x) => x.ntStart === site.ntStart); const idx = c ? codons.indexOf(c) : -1; const target = c ? aminoAcidTargetLabel(reference, s.cdsStart, site.ntStart).name : "?"; return <tr key={site.id} className="border-t"><td className="font-mono font-medium">{target}</td><td>{c?.aaPos ?? "?"}</td><td>{site.ntStart}-{site.ntStart + 2}</td><td className="font-mono">{c?.dna}/{c?.aa}</td><td className="font-mono">{idx >= 0 ? codons.slice(Math.max(0, idx - 3), idx + 4).map((x) => x.aa).join("") : "—"}</td><td><button onClick={() => s.removeSite(site.id)}>×</button></td></tr>; })}</tbody></table></div>
      </CardContent></Card>
    {errors.length > 0 && <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{errors.map((error) => <div key={error}>• {error}</div>)}</div>}
    <div className="flex justify-between"><Button variant="outline" onClick={() => s.setStep("inputs")}>Back</Button><Button disabled={errors.length > 0} onClick={() => { if (!s.cdsEnd) s.setCds({ cdsEnd }); s.setStep("analyze"); }}>Continue to Analyze</Button></div>
  </div>;
}
