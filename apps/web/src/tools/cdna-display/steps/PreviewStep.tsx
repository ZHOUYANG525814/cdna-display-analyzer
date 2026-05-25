import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { useRunStore, type RoundForm } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { estimateReadLength, runPreview, type PreviewResult, type PreviewStatus } from "@/tools/cdna-display/preview";

export function PreviewStep() {
  const {
    referenceSeq,
    rounds,
    localFiles,
    estimatedReadLength,
    previewResults,
    setPreview,
    updateRound,
    goPrev,
    goNext,
  } = useRunStore();
  const [busy, setBusy] = useState(false);

  // Auto-run preview on entry; users almost always want it immediately.
  useEffect(() => {
    if (previewResults.length === 0) void doPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doPreview = async () => {
    setBusy(true);
    try {
      const estLen = await estimateReadLength(localFiles);
      const results = runPreview(referenceSeq, rounds, estLen);
      setPreview(estLen, results);
    } finally {
      setBusy(false);
    }
  };

  const allRoundsHaveCds = rounds.every(
    (r) =>
      r.cdsStart != null &&
      r.cdsEnd != null &&
      r.cdsEnd >= r.cdsStart &&
      (r.cdsEnd - r.cdsStart + 1) % 3 === 0,
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Anchor alignment & CDS</CardTitle>
            <CardDescription>
              For each round, the Fw primer's 3'-end (last 10 bp) is located in the reference.
              The visible strip below starts at position 1 right after the Fw anchor. Set CDS
              Start / End as 1-based positions in that strip — values may be negative to reach
              back into the Fw primer.
            </CardDescription>
          </div>
          <Button variant="outline" onClick={doPreview} disabled={busy}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            {busy ? "Aligning…" : "Re-align"}
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Estimated read length:{" "}
            <span className="font-mono text-foreground">{estimatedReadLength} bp</span>
          </p>
        </CardContent>
      </Card>

      {previewResults.map((pr) => {
        const round = rounds.find((r) => r.id === pr.roundId);
        if (!round) return null;
        return (
          <PreviewRoundCard
            key={pr.roundId}
            pr={pr}
            round={round}
            onPatch={(patch) => updateRound(round.id, patch)}
          />
        );
      })}

      <div className="flex justify-between">
        <Button variant="ghost" onClick={goPrev}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <Button size="lg" disabled={!allRoundsHaveCds || busy} onClick={goNext}>
          Continue to Run <ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function PreviewRoundCard({
  pr,
  round,
  onPatch,
}: {
  pr: PreviewResult;
  round: RoundForm;
  onPatch: (patch: Partial<RoundForm>) => void;
}) {
  const ok = pr.status === "ok-full" || pr.status === "ok-truncated";
  const cdsLen =
    round.cdsStart != null && round.cdsEnd != null && round.cdsEnd >= round.cdsStart
      ? round.cdsEnd - round.cdsStart + 1
      : null;
  const cdsFrameOk = cdsLen != null && cdsLen % 3 === 0;
  const aaLen = cdsFrameOk ? cdsLen / 3 : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">{round.name}</CardTitle>
          <StatusBadge status={pr.status} />
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          read capacity {pr.readCapacity} bp · distance to Rv{" "}
          {pr.distanceToRv != null ? `${pr.distanceToRv} bp` : "—"}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ok && (
          <Alert variant={pr.status === "fw-missing" ? "destructive" : "warning"}>
            <XCircle className="h-4 w-4" />
            <AlertTitle>
              {pr.status === "fw-missing" ? "Fw primer not found" : "Rv anchor not found"}
            </AlertTitle>
            <AlertDescription>{pr.message}</AlertDescription>
          </Alert>
        )}
        {ok && pr.status === "ok-truncated" && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Truncated read</AlertTitle>
            <AlertDescription>{pr.message}</AlertDescription>
          </Alert>
        )}
        {ok && (
          <AlignmentView
            seq={pr.visibleSeq}
            cdsStart={round.cdsStart}
            cdsEnd={round.cdsEnd}
          />
        )}
        {ok && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 items-end">
            <div>
              <Label className="text-xs">CDS Start (1-based)</Label>
              <Input
                type="number"
                value={round.cdsStart ?? ""}
                onChange={(e) =>
                  onPatch({ cdsStart: e.target.value === "" ? null : Number(e.target.value) })
                }
                className="mt-1 font-mono text-xs"
                placeholder="e.g. 1"
              />
            </div>
            <div>
              <Label className="text-xs">CDS End (1-based, inclusive)</Label>
              <Input
                type="number"
                value={round.cdsEnd ?? ""}
                onChange={(e) =>
                  onPatch({ cdsEnd: e.target.value === "" ? null : Number(e.target.value) })
                }
                className="mt-1 font-mono text-xs"
                placeholder={`e.g. ${pr.visibleSeq.length}`}
              />
            </div>
            <div className="text-xs">
              {cdsLen != null ? (
                <div
                  className={`rounded-md border px-3 py-2 ${
                    cdsFrameOk
                      ? "border-success/40 bg-success/10 text-success"
                      : "border-destructive/40 bg-destructive/10 text-destructive"
                  }`}
                >
                  CDS length: <span className="font-mono">{cdsLen} bp</span>
                  {cdsFrameOk ? (
                    <>
                      {" "}
                      · <span className="font-mono">{aaLen} aa</span>
                    </>
                  ) : (
                    " · not divisible by 3"
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-muted-foreground/30 bg-muted/40 px-3 py-2 text-muted-foreground">
                  Enter Start & End to see CDS length.
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Render the visible region as a numbered ruler over the sequence with the
 * CDS range highlighted via background color. Per-base spans keep the DOM
 * small (typical visible regions are 30–200 bp); React diffing handles the
 * live highlight update as the user types CDS Start / End.
 */
function AlignmentView({
  seq,
  cdsStart,
  cdsEnd,
}: {
  seq: string;
  cdsStart: number | null;
  cdsEnd: number | null;
}) {
  const WIDTH = 60;
  const lines: { offset: number; chunk: string }[] = [];
  for (let i = 0; i < seq.length; i += WIDTH) {
    lines.push({ offset: i, chunk: seq.slice(i, i + WIDTH) });
  }

  const hasCds = cdsStart != null && cdsEnd != null && cdsEnd >= cdsStart;
  // Clamp CDS to the visible region for the highlight only — coords < 1 mean
  // "reach back into Fw primer" and aren't shown here.
  const cdsLo = hasCds ? Math.max(1, cdsStart!) : -1;
  const cdsHi = hasCds ? Math.min(seq.length, cdsEnd!) : -2;

  return (
    <div className="overflow-x-auto rounded-md border bg-muted/20 p-3">
      <div className="font-mono text-[11px] leading-[1.4] tabular-nums">
        {lines.map(({ offset, chunk }) => (
          <div key={offset} className="mb-2 last:mb-0">
            <RulerLine offset={offset} length={chunk.length} />
            <SeqLine offset={offset} chunk={chunk} cdsLo={cdsLo} cdsHi={cdsHi} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RulerLine({ offset, length }: { offset: number; length: number }) {
  // Numbers every 10 bp aligned over the sequence position. Use a fixed-width
  // grid of single chars so monospace alignment is exact under tabular-nums.
  const cells: string[] = new Array(length).fill(" ");
  for (let i = 0; i < length; i++) {
    const pos = offset + i + 1;
    if (pos === offset + 1 || pos % 10 === 0) {
      const s = String(pos);
      for (let k = 0; k < s.length && i + k < length; k++) {
        cells[i + k] = s[k]!;
      }
    }
  }
  return (
    <div className="text-muted-foreground/70 whitespace-pre">{cells.join("")}</div>
  );
}

function SeqLine({
  offset,
  chunk,
  cdsLo,
  cdsHi,
}: {
  offset: number;
  chunk: string;
  cdsLo: number;
  cdsHi: number;
}) {
  // Group consecutive bases that share the same highlight state into a single
  // span — keeps the DOM tight even for 60-bp lines and makes selection /
  // copy-paste preserve runs of bases.
  const spans: { text: string; highlighted: boolean }[] = [];
  let cur: { text: string; highlighted: boolean } | null = null;
  for (let i = 0; i < chunk.length; i++) {
    const pos = offset + i + 1;
    const hi = pos >= cdsLo && pos <= cdsHi;
    if (!cur || cur.highlighted !== hi) {
      if (cur) spans.push(cur);
      cur = { text: chunk[i]!, highlighted: hi };
    } else {
      cur.text += chunk[i]!;
    }
  }
  if (cur) spans.push(cur);

  return (
    <div className="whitespace-pre">
      {spans.map((s, i) =>
        s.highlighted ? (
          <span
            key={i}
            className="bg-primary/25 text-primary-foreground"
            style={{ color: "hsl(var(--foreground))" }}
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PreviewStatus }) {
  switch (status) {
    case "ok-full":
      return (
        <Badge variant="success">
          <CheckCircle2 className="mr-1 h-3 w-3" /> Full read-through
        </Badge>
      );
    case "ok-truncated":
      return (
        <Badge variant="warning">
          <AlertTriangle className="mr-1 h-3 w-3" /> Truncated
        </Badge>
      );
    case "fw-missing":
    case "rv-missing":
      return (
        <Badge variant="destructive">
          <XCircle className="mr-1 h-3 w-3" /> Failed
        </Badge>
      );
  }
}
