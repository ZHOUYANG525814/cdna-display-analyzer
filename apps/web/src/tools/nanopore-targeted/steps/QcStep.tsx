import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTargetedNanoporeStore } from "@/state/useTargetedNanoporeStore";

export function QcStep() {
  const s = useTargetedNanoporeStore();
  const fields: Array<[string, "minReadQ" | "minProtectedIdentity" | "minTargetBaseQ" | "minInputCountToScore", number, number]> = [
    ["Minimum read Q", "minReadQ", 0, 30], ["Minimum protected identity", "minProtectedIdentity", 0.8, 1],
    ["Minimum target base Q", "minTargetBaseQ", 0, 40], ["Minimum Round 0 count to score", "minInputCountToScore", 0, 100000],
  ];
  const valid = s.settings.minReadQ >= 0 && s.settings.minProtectedIdentity > 0 && s.settings.minProtectedIdentity <= 1 && s.settings.minTargetBaseQ >= 0 && s.settings.minInputCountToScore >= 0;
  return <div className="space-y-6"><Card><CardHeader><CardTitle>QC parameters</CardTitle><CardDescription>Only four study-level controls are exposed. Structural alignment limits remain versioned system settings.</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">{fields.map(([label, key, min, max]) => <label key={key} className="text-sm">{label}<Input type="number" min={min} max={max} step={key === "minProtectedIdentity" ? 0.01 : 1} value={s.settings[key]} onChange={(e) => s.setSettings({ [key]: Number(e.target.value) })} /></label>)}</CardContent></Card>
    <Card><CardHeader><CardTitle>Read-preserving QC model</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>1. Dorado <code>qs:f</code> (or recalculated ONT mean Q) filters globally poor reads.</p><p>2. One full-reference affine-gap alignment masks target codons when checking protected identity.</p><p>3. Small substitutions/indels are projected through CIGAR. A target-overlapping indel drops that site only.</p><p>4. Partial reads can rescue an independently callable site when both 30-nt flanks pass protected identity. Rescued calls never enter haplotypes.</p><p>5. All complete high-Q codons are counted; NNK is not used as an exclusion rule. Stop codons remain visible.</p><p>6. Statistics use pseudocount 1, four-term Poisson delta variance, two-sided p and site-scoped BH-FDR. Without biological replicates, this is count uncertainty—not total biological uncertainty.</p></CardContent></Card>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.reportHaplotypes} onChange={(e) => s.setReportHaplotypes(e.target.checked)} />Report target-only haplotypes (full-QC reads only)</label>
    <div className="flex justify-between"><Button variant="outline" onClick={() => s.setStep("inputs")}>Back</Button><Button disabled={!valid} onClick={() => { s.setQcLocked(true); s.setStep("run"); }}>Lock QC and continue</Button></div>
  </div>;
}
