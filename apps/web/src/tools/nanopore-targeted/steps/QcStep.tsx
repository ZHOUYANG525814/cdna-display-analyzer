import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TARGETED_USER_DEFAULTS, useTargetedNanoporeStore, type TargetedCallingSettings } from "@/state/useTargetedNanoporeStore";

type EditableKey = "minReadQ" | "minProtectedIdentity" | "minTargetBaseQ" | "minInputCountToScore";
const FIELDS: Array<{ key: EditableKey; label: string; min: number; max: number; step: number; description: string; consequence: string }> = [
  { key: "minReadQ", label: "Minimum read Q", min: 0, max: 30, step: 1, description: "Uses Dorado qs:f when present; otherwise recalculates the ONT arithmetic mean error probability from FASTQ qualities.", consequence: "Lower values rescue noisy reads but increase alignment and false target-call risk; higher values reduce throughput." },
  { key: "minProtectedIdentity", label: "Minimum protected identity", min: 0.8, max: 1, step: 0.01, description: "Identity outside target codons after the full-reference affine-gap alignment. Intended NNK codons are masked.", consequence: "Lower values tolerate more background base-calling errors; values near 1 can discard real Nanopore reads or expose a wrong reference." },
  { key: "minTargetBaseQ", label: "Minimum target base Q", min: 0, max: 40, step: 1, description: "All three projected bases of a target codon must meet this value. Failure affects that site only.", consequence: "Lower values retain more site calls but can convert base-caller errors into substitutions; higher values make codon calls more conservative." },
  { key: "minInputCountToScore", label: "Minimum Round 0 count to score", min: 0, max: 100000, step: 1, description: "Eligibility threshold for Z, p, BH-FDR and median centering in the primary amino-acid table.", consequence: "This never deletes counts. Below-threshold variants remain in raw/RPM outputs with inferential fields blank." },
];

export function QcStep() {
  const s = useTargetedNanoporeStore();
  const valid = FIELDS.every(({ key, min, max }) => Number.isFinite(s.settings[key]) && s.settings[key] >= min && s.settings[key] <= max);
  return <div className="space-y-6">
    <Card><CardHeader><CardTitle>QC parameters</CardTitle><CardDescription>Recommended defaults are marked, but every study-level value remains editable. Structural safeguards are versioned and fixed for reproducibility.</CardDescription></CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{FIELDS.map((field) => {
        const recommended = TARGETED_USER_DEFAULTS[field.key];
        const modified = s.settings[field.key] !== recommended;
        return <label key={field.key} className="space-y-2 rounded-md border p-3 text-sm">
          <span className="flex flex-wrap items-center justify-between gap-2 font-medium"><span>{field.label}</span><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">Recommended default: {recommended}</span></span>
          <Input aria-label={field.label} type="number" min={field.min} max={field.max} step={field.step} value={s.settings[field.key]} onChange={(e) => s.setSettings({ [field.key]: Number(e.target.value) } as Partial<TargetedCallingSettings>)} />
          <p className="text-xs text-muted-foreground">{field.description}</p><p className="text-xs text-muted-foreground"><strong>Changing it:</strong> {field.consequence}</p>
          {modified && <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">Modified from the recommended default</span>}
        </label>;
      })}</CardContent>
    </Card>
    <Card><CardHeader><CardTitle>System-managed structural safeguards</CardTitle><CardDescription>Shown for auditability; these are not user-tunable because changing them alters coordinate and rescue semantics.</CardDescription></CardHeader><CardContent className="grid gap-2 text-xs sm:grid-cols-2">
      <Fixed label="Minimum reference coverage" value="90%" /><Fixed label="Minimum full-alignment identity" value="85%" /><Fixed label="Maximum protected indel bases" value="30 nt" /><Fixed label="Partial rescue flanks" value="30 nt on each side" /><Fixed label="Concatemer screen" value="read length ≥ 1.5× reference" />
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Read-preserving QC model</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
      <p>1. Globally poor, malformed, duplicate and concatemer/chimeric reads enter explicit, mutually exclusive drop buckets.</p>
      <p>2. One full-reference affine-gap alignment projects every event. Target codons are masked only for protected-region identity—not from calling.</p>
      <p>3. A protected substitution is tolerated while total protected identity passes. A target substitution becomes a codon call only when all three bases pass target Q.</p>
      <p>4. A target-overlapping insertion/deletion makes only that site non-callable. Small protected indels are tolerated up to 30 nt; larger protected disruption fails whole-read QC.</p>
      <p>5. Partial reads can rescue an independently callable site when both 30-nt flanks pass protected identity. Rescued calls never enter haplotypes.</p>
      <p>6. Complete high-Q off-NNK and stop codons remain visible as design/QC signals. They are not silently discarded.</p>
      <p>7. Statistics reuse the NGS helpers: pseudocount 1, four-term Poisson delta variance, two-sided p and per-site BH-FDR. Without replicates this is counting—not total biological—uncertainty.</p>
    </CardContent></Card>
    <label className="flex items-start gap-2 rounded-md border p-3 text-sm"><input className="mt-1" type="checkbox" checked={s.reportHaplotypes} onChange={(e) => s.setReportHaplotypes(e.target.checked)} /><span><strong>Report target-only haplotypes</strong> <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">Recommended for 2+ sites</span><span className="mt-1 block text-xs text-muted-foreground">Uses full-QC reads only; partial rescued calls stay in independent site counts so uncertain sites do not fragment haplotypes.</span></span></label>
    <div className="flex justify-between"><Button variant="outline" onClick={() => s.setStep("inputs")}>Back</Button><Button disabled={!valid} onClick={() => { s.setQcLocked(true); s.setStep("run"); }}>Lock QC and continue</Button></div>
  </div>;
}

function Fixed({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 rounded bg-muted/40 px-3 py-2"><span className="text-muted-foreground">{label}</span><span className="font-mono">{value}</span></div>; }
