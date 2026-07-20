import { useMemo, useRef, useState } from "react";
import { normalizeReference, translateDna } from "@cdna/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TARGETED_USER_DEFAULTS, useTargetedNanoporeStore, targetedInputErrors } from "@/state/useTargetedNanoporeStore";
import { DriveAuthProvider, isDriveSignedIn } from "@/adapters/DriveAuthProvider";
import { showDrivePicker } from "@/adapters/DrivePicker";
import { sanitizeProjectName } from "@/lib/validation";
import { sanitizeDna } from "@/lib/validation";
import { NANOPORE_INPUT_LIMITS, peekNanoporeFastq, validateNanoporeDriveFile } from "../inputValidation";
import { buildNanoporeDemoRounds, NANOPORE_DEMO_REFERENCE, NANOPORE_DEMO_SITES } from "../demo";
import { aminoAcidTargetLabel } from "../targetNaming";
import { parseLockedConfig } from "@/adapters/TargetedNanoporeExporter";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;

export function InputsStep() {
  const s = useTargetedNanoporeStore();
  const [direct, setDirect] = useState("");
  const [driveError, setDriveError] = useState<string | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [configMessage, setConfigMessage] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  const configInput = useRef<HTMLInputElement>(null);
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
    const targetRound = s.rounds.find((r) => r.id === roundId);
    const remaining = NANOPORE_INPUT_LIMITS.maxFilesPerRound -
      (targetRound?.files.filter((source) => source.file || source.driveRef).length ?? 0);
    const accepted = picked.filter((file) => {
      const check = validateNanoporeDriveFile(file);
      if (!check.ok) setFileErrors((old) => [...old, `${file.name}: ${check.reason}`]);
      return check.ok;
    }).slice(0, Math.max(0, remaining));
    if (picked.length > accepted.length) setFileErrors((old) => [...old, `Round file limit is ${NANOPORE_INPUT_LIMITS.maxFilesPerRound}; excess Drive selections were rejected.`]);
    const expected = targetRound?.files.flatMap((source) => !source.file && !source.driveRef && source.expectedFileName ? [source.expectedFileName] : []) ?? [];
    if (expected.length > 0 && accepted.some((file) => !expected.includes(file.name))) {
      setConfigMessage({ tone: "warning", text: "One or more filenames differ from the config hints. They were accepted because sequencing-file identity is not locked; verify the round assignment." });
    }
    s.addDriveFiles(roundId, accepted);
  };

  const addLocal = async (roundId: string, list: FileList | null) => {
    if (!list) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    const targetRound = s.rounds.find((r) => r.id === roundId);
    const remaining = NANOPORE_INPUT_LIMITS.maxFilesPerRound -
      (targetRound?.files.filter((source) => source.file || source.driveRef).length ?? 0);
    for (const file of Array.from(list)) {
      const check = await peekNanoporeFastq(file);
      if (check.ok && accepted.length < remaining) accepted.push(file);
      else if (!check.ok) rejected.push(`${file.name}: ${check.reason}`);
      else rejected.push(`${file.name}: round file limit is ${NANOPORE_INPUT_LIMITS.maxFilesPerRound}.`);
    }
    if (rejected.length) setFileErrors((old) => [...old, ...rejected]);
    const expected = targetRound?.files.flatMap((source) => !source.file && !source.driveRef && source.expectedFileName ? [source.expectedFileName] : []) ?? [];
    if (expected.length > 0 && accepted.some((file) => !expected.includes(file.name))) {
      setConfigMessage({ tone: "warning", text: "One or more filenames differ from the config hints. They were accepted because sequencing-file identity is not locked; verify the round assignment." });
    }
    s.addLocalFiles(roundId, accepted);
  };

  const importLockedConfig = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("Locked config exceeds the 2 MB safety limit.");
      const parsed = parseLockedConfig(await file.text());
      s.loadLockedConfig(parsed);
      setFileErrors([]);
      setDriveError(null);
      setConfigMessage({
        tone: "success",
        text: "Locked config imported. Filenames are hints only; reselect and verify every sequencing file before running.",
      });
    } catch (error) {
      setConfigMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const loadDemo = () => {
    useTargetedNanoporeStore.setState({
      currentStep: "inputs", projectName: "Nanopore_targeted_demo",
      rounds: buildNanoporeDemoRounds(), referenceSeq: NANOPORE_DEMO_REFERENCE,
      cdsStart: 1, cdsEnd: NANOPORE_DEMO_REFERENCE.length, cdsStrand: "+",
      sites: NANOPORE_DEMO_SITES.map((site) => ({ ...site })),
      settings: { ...TARGETED_USER_DEFAULTS }, qcLocked: false, reportHaplotypes: true,
      runState: {
        status: "idle", error: null, outcome: null, startedAt: null, finishedAt: null,
        progress: null, perSourceBytes: {}, log: [],
      },
    });
    setFileErrors([]); setDriveError(null);
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
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>Project and rounds</CardTitle><CardDescription>Round 0 is the fixed baseline. Multiple FASTQs inside one round are merged as technical shards.</CardDescription></div><div className="flex gap-2"><input ref={configInput} className="hidden" type="file" accept=".json,application/json" onChange={(event) => { void importLockedConfig(event.target.files?.[0]); event.target.value = ""; }} /><Button variant="outline" onClick={() => configInput.current?.click()}>Import locked config</Button><Button variant="secondary" onClick={loadDemo}>Load demo</Button></div></div></CardHeader>
      <CardContent className="space-y-4">
        <Input placeholder="Project name" value={s.projectName} onChange={(e) => s.setProjectName(sanitizeProjectName(e.target.value))} />
        {s.rounds.map((round) => <div key={round.id} className="rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between"><strong>Round {round.round}</strong>{round.round > 1 && <Button size="sm" variant="ghost" onClick={() => s.removeRound(round.id)}>Remove round</Button>}</div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-xs font-medium hover:bg-accent">Add local reads<input className="hidden" type="file" multiple accept=".fastq,.fq,.fastqsanger,.fastq.gz,.fq.gz,.fastqsanger.gz" onChange={(e) => { void addLocal(round.id, e.target.files); e.target.value = ""; }} /></label>
            <Button size="sm" variant="outline" onClick={() => void pickDrive(round.id)}>Add from Google Drive</Button>
          </div>
          <div className="mt-2 space-y-1">{round.files.map((src) => {
            const actual = src.file?.name ?? src.driveRef?.name;
            const mismatch = actual && src.expectedFileName && actual !== src.expectedFileName;
            return <div key={src.id} className="flex items-center justify-between rounded bg-muted px-2 py-1 text-xs"><span>{actual ?? src.expectedFileName} <span className="text-muted-foreground">({src.file ? "local" : src.driveRef ? "Drive" : "expected — select file"})</span>{mismatch ? <span className="ml-2 text-amber-700 dark:text-amber-400">expected: {src.expectedFileName}</span> : null}</span><button onClick={() => s.removeSource(round.id, src.id)}>×</button></div>;
          })}</div>
          {round.files.some((src) => src.expectedFileName) && <p className="mt-2 text-xs text-muted-foreground">Filename hints do not verify sequencing-file identity.</p>}
        </div>)}
        <Button variant="outline" onClick={s.addRound}>Add next round</Button>
        {driveError && <p className="text-sm text-destructive">{driveError}</p>}
        {configMessage && <p className={`rounded border p-2 text-xs ${configMessage.tone === "error" ? "border-destructive/40 text-destructive" : configMessage.tone === "warning" ? "border-amber-400/50 text-amber-700 dark:text-amber-400" : "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"}`}>{configMessage.text}</p>}
        {fileErrors.length > 0 && <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"><div className="mb-1 flex justify-between"><strong>Rejected by input whitelist</strong><button onClick={() => setFileErrors([])}>clear</button></div>{fileErrors.map((error, i) => <div key={`${error}:${i}`}>• {error}</div>)}</div>}
        <p className="text-xs text-muted-foreground">Accepted: .fastq, .fq, .fastqsanger, .fastq.gz, .fq.gz, .fastqsanger.gz. The first decompressed record is checked before acceptance.</p>
      </CardContent></Card>

    <Card><CardHeader><CardTitle>Reference and CDS</CardTitle><CardDescription>Paste the full amplicon in the coding orientation. For a reverse-strand CDS, paste its reverse complement as the reference.</CardDescription></CardHeader>
      <CardContent className="space-y-3"><Textarea className="min-h-32 font-mono" placeholder="Amplicon reference (FASTA header optional)" value={s.referenceSeq} onChange={(e) => {
        const v = sanitizeDna(e.target.value.replace(/^>[^\n]*\n/, ""), NANOPORE_INPUT_LIMITS.maxReferenceBases); s.setReferenceSeq(v); if (!s.cdsEnd) s.setCds({ cdsEnd: v.length });
      }} /><div className="grid grid-cols-2 gap-3"><label className="text-xs">CDS start (nt, 1-based)<Input type="number" value={s.cdsStart} onChange={(e) => s.setCds({ cdsStart: Number(e.target.value) })} /></label><label className="text-xs">CDS end (inclusive)<Input type="number" value={cdsEnd} onChange={(e) => s.setCds({ cdsEnd: Number(e.target.value) })} /></label></div></CardContent></Card>

    <Card><CardHeader><CardTitle>Target codons</CardTitle><CardDescription>Click amino acids or enter AA positions (e.g. 116,117). Use an explicit nt: prefix for amplicon coordinates (e.g. nt:346).</CardDescription></CardHeader>
      <CardContent className="space-y-3"><div className="flex gap-2"><Input value={direct} onChange={(e) => setDirect(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addDirect(); }} placeholder="AA: 116,117 or nt:346"/><Button variant="outline" onClick={addDirect}>Add</Button></div>
        <div className="max-h-56 overflow-auto rounded border p-2"><div className="flex flex-wrap gap-1">{codons.map((c) => { const active = s.sites.some((x) => x.ntStart === c.ntStart); return <button key={c.ntStart} type="button" onClick={() => active ? s.removeSite(s.sites.find((x) => x.ntStart === c.ntStart)!.id) : s.addSiteByNt(c.ntStart)} className={`w-14 rounded border px-1 py-1 font-mono text-xs ${active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"}`} title={`AA ${c.aaPos}; nt ${c.ntStart}-${c.ntStart + 2}; ${c.dna}`}>{c.aa}{c.aaPos}</button>; })}</div></div>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Target</th><th>AA position</th><th>nt</th><th>Reference</th><th>Context (±3 aa)</th><th /></tr></thead><tbody>{s.sites.map((site) => { const c = codons.find((x) => x.ntStart === site.ntStart); const idx = c ? codons.indexOf(c) : -1; const target = c ? aminoAcidTargetLabel(reference, s.cdsStart, site.ntStart).name : "?"; return <tr key={site.id} className="border-t"><td className="font-mono font-medium">{target}</td><td>{c?.aaPos ?? "?"}</td><td>{site.ntStart}-{site.ntStart + 2}</td><td className="font-mono">{c?.dna}/{c?.aa}</td><td className="font-mono">{idx >= 0 ? codons.slice(Math.max(0, idx - 3), idx + 4).map((x) => x.aa).join("") : "—"}</td><td><button onClick={() => s.removeSite(site.id)}>×</button></td></tr>; })}</tbody></table></div>
      </CardContent></Card>
    {errors.length > 0 && <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{errors.map((e) => <div key={e}>• {e}</div>)}</div>}
    <div className="flex justify-end"><Button disabled={errors.length > 0} onClick={() => { if (!s.cdsEnd) s.setCds({ cdsEnd }); s.setStep("qc"); }}>Continue to QC</Button></div>
  </div>;
}
