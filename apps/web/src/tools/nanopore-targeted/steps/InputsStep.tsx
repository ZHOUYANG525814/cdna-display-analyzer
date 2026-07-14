import { useMemo, useState } from "react";
import { normalizeReference, translateDna } from "@cdna/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTargetedNanoporeStore, targetedInputErrors } from "@/state/useTargetedNanoporeStore";
import { DriveAuthProvider, isDriveSignedIn } from "@/adapters/DriveAuthProvider";
import { showDrivePicker } from "@/adapters/DrivePicker";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;

export function InputsStep() {
  const s = useTargetedNanoporeStore();
  const [direct, setDirect] = useState("");
  const [driveError, setDriveError] = useState<string | null>(null);
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
  const errors = targetedInputErrors({ ...s, cdsEnd });

  const pickDrive = async (roundId: string) => {
    setDriveError(null);
    if (!CLIENT_ID || !API_KEY) { setDriveError("Google Drive is not configured on this deployment."); return; }
    const auth = new DriveAuthProvider({ clientId: CLIENT_ID });
    if (!isDriveSignedIn()) sessionStorage.setItem("cdna_drive_pending_action", "open_picker");
    const token = await auth.getToken();
    const picked = await showDrivePicker({ oauthToken: token, apiKey: API_KEY, appId: CLIENT_ID.split("-")[0]!, title: `Add FASTQs to ${s.rounds.find((r) => r.id === roundId)?.round === 0 ? "Round 0" : "selected round"}` });
    s.addDriveFiles(roundId, picked);
  };

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
    <Card><CardHeader><CardTitle>Project and rounds</CardTitle><CardDescription>Round 0 is the fixed baseline. Multiple FASTQs inside one round are merged as technical shards.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <Input placeholder="Project name" value={s.projectName} onChange={(e) => s.setProjectName(e.target.value)} />
        {s.rounds.map((round) => <div key={round.id} className="rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between"><strong>Round {round.round}</strong>{round.round > 1 && <Button size="sm" variant="ghost" onClick={() => s.removeRound(round.id)}>Remove round</Button>}</div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-xs font-medium hover:bg-accent">Add local FASTQ<input className="hidden" type="file" multiple accept=".fastq,.fq,.fastq.gz,.fq.gz" onChange={(e) => s.addLocalFiles(round.id, Array.from(e.target.files ?? []))} /></label>
            <Button size="sm" variant="outline" onClick={() => void pickDrive(round.id)}>Add from Google Drive</Button>
          </div>
          <div className="mt-2 space-y-1">{round.files.map((src) => <div key={src.id} className="flex items-center justify-between rounded bg-muted px-2 py-1 text-xs"><span>{src.file?.name ?? src.driveRef?.name} <span className="text-muted-foreground">({src.file ? "local" : "Drive"})</span></span><button onClick={() => s.removeSource(round.id, src.id)}>×</button></div>)}</div>
        </div>)}
        <Button variant="outline" onClick={s.addRound}>Add next round</Button>
        {driveError && <p className="text-sm text-destructive">{driveError}</p>}
      </CardContent></Card>

    <Card><CardHeader><CardTitle>Reference and CDS</CardTitle><CardDescription>Paste the full amplicon in the coding orientation. For a reverse-strand CDS, paste its reverse complement as the reference.</CardDescription></CardHeader>
      <CardContent className="space-y-3"><Textarea className="min-h-32 font-mono" placeholder="Amplicon reference (FASTA header optional)" value={s.referenceSeq} onChange={(e) => {
        const v = e.target.value.replace(/^>[^\n]*\n/, ""); s.setReferenceSeq(v); if (!s.cdsEnd) s.setCds({ cdsEnd: normalizeReference(v).length });
      }} /><div className="grid grid-cols-2 gap-3"><label className="text-xs">CDS start (nt, 1-based)<Input type="number" value={s.cdsStart} onChange={(e) => s.setCds({ cdsStart: Number(e.target.value) })} /></label><label className="text-xs">CDS end (inclusive)<Input type="number" value={cdsEnd} onChange={(e) => s.setCds({ cdsEnd: Number(e.target.value) })} /></label></div></CardContent></Card>

    <Card><CardHeader><CardTitle>Target codons</CardTitle><CardDescription>Click amino acids or enter AA positions (e.g. 116,117). Use an explicit nt: prefix for amplicon coordinates (e.g. nt:346).</CardDescription></CardHeader>
      <CardContent className="space-y-3"><div className="flex gap-2"><Input value={direct} onChange={(e) => setDirect(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addDirect(); }} placeholder="AA: 116,117 or nt:346"/><Button variant="outline" onClick={addDirect}>Add</Button></div>
        <div className="max-h-56 overflow-auto rounded border p-2"><div className="flex flex-wrap gap-1">{codons.map((c) => { const active = s.sites.some((x) => x.ntStart === c.ntStart); return <button key={c.ntStart} type="button" onClick={() => active ? s.removeSite(s.sites.find((x) => x.ntStart === c.ntStart)!.id) : s.addSiteByNt(c.ntStart)} className={`w-14 rounded border px-1 py-1 font-mono text-xs ${active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"}`} title={`AA ${c.aaPos}; nt ${c.ntStart}-${c.ntStart + 2}; ${c.dna}`}>{c.aa}{c.aaPos}</button>; })}</div></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Site</th><th>AA</th><th>nt</th><th>WT</th><th>Context (±3 aa)</th><th /></tr></thead><tbody>{s.sites.map((site) => { const c = codons.find((x) => x.ntStart === site.ntStart); const idx = c ? codons.indexOf(c) : -1; return <tr key={site.id} className="border-t"><td>{site.name}</td><td>{c?.aaPos ?? "?"}</td><td>{site.ntStart}-{site.ntStart + 2}</td><td className="font-mono">{c?.dna}/{c?.aa}</td><td className="font-mono">{idx >= 0 ? codons.slice(Math.max(0, idx - 3), idx + 4).map((x) => x.aa).join("") : "—"}</td><td><button onClick={() => s.removeSite(site.id)}>×</button></td></tr>; })}</tbody></table></div>
      </CardContent></Card>
    {errors.length > 0 && <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{errors.map((e) => <div key={e}>• {e}</div>)}</div>}
    <div className="flex justify-end"><Button disabled={errors.length > 0} onClick={() => { if (!s.cdsEnd) s.setCds({ cdsEnd }); s.setStep("qc"); }}>Continue to QC</Button></div>
  </div>;
}
