import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useTargetedNanoporeStore } from "@/state/useTargetedNanoporeStore";
import { DriveAuthProvider } from "@/adapters/DriveAuthProvider";
import { runTargetedNanoporeInWorker } from "@/worker/workerClient";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

export function RunStep() {
  const s = useTargetedNanoporeStore();
  const [progress, setProgress] = useState<Record<number, { bytes: number; total: number | null; reads: number; name: string }>>({});
  const running = s.runState.status === "running";
  const run = async () => {
    s.setRunState({ status: "running", error: null, outcome: null, startedAt: Date.now(), finishedAt: null });
    try {
      const localFiles: File[] = [], driveFiles: NonNullable<(typeof s.rounds)[number]["files"][number]["driveRef"]>[] = [];
      const localRounds: number[] = [], driveRounds: number[] = [];
      for (const round of s.rounds) for (const src of round.files) {
        if (src.file) { localFiles.push(src.file); localRounds.push(round.round); }
        else if (src.driveRef) { driveFiles.push(src.driveRef); driveRounds.push(round.round); }
      }
      let driveToken: string | undefined;
      if (driveFiles.length) {
        if (!CLIENT_ID) throw new Error("Google Drive OAuth is not configured.");
        driveToken = await new DriveAuthProvider({ clientId: CLIENT_ID }).getToken();
      }
      const outcome = await runTargetedNanoporeInWorker({
        localFiles, driveFiles, ...(driveToken ? { driveToken } : {}),
        sourceRoundIndices: [...localRounds, ...driveRounds],
        roundNames: s.rounds.map((r) => `Round ${r.round}`), reference: s.referenceSeq,
        sites: s.sites.map((site) => ({ name: site.name, ntStart: site.ntStart, length: 3, design: "NNK" as const })),
        settings: { ...s.settings, reportHaplotypes: s.sites.length >= 2 },
      }, (p) => setProgress((old) => ({ ...old, [p.sourceIndex]: { bytes: p.bytesProcessed, total: p.totalBytes, reads: p.recordsProcessed, name: p.fileName } })));
      s.setRunState({ status: "done", outcome, finishedAt: Date.now() });
      s.setStep("results");
    } catch (error) { s.setRunState({ status: "error", error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() }); }
  };
  return <div className="space-y-6"><Card><CardHeader><CardTitle>Ready to stream</CardTitle><CardDescription>{s.rounds.length} rounds · {s.rounds.reduce((n, r) => n + r.files.length, 0)} FASTQ files · {s.sites.length} target codons. Files are processed sequentially and never buffered in full.</CardDescription></CardHeader><CardContent className="space-y-3">{Object.entries(progress).map(([i, p]) => <div key={i}><div className="mb-1 flex justify-between text-xs"><span>{p.name}</span><span>{p.reads.toLocaleString()} reads</span></div><Progress value={p.total ? p.bytes / p.total * 100 : undefined} /></div>)}{s.runState.error && <p className="text-sm text-destructive">{s.runState.error}</p>}</CardContent></Card>
    <div className="flex justify-between"><Button variant="outline" disabled={running} onClick={() => s.setStep("qc")}>Back</Button><Button disabled={running || !s.qcLocked} onClick={() => void run()}>{running ? "Analyzing…" : "Run analysis"}</Button></div></div>;
}
