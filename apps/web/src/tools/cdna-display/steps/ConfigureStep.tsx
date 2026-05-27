import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash2, FileUp, X, Cloud } from "lucide-react";
import { DriveAuthProvider } from "@/adapters/DriveAuthProvider";
import { showDrivePicker } from "@/adapters/DrivePicker";
import type { DriveFileRef } from "@/state/useRunStore";
import { useRunStore } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  LIMITS,
  peekFastq,
  sanitizeDna,
  sanitizeRoundName,
  validateFastqFileSync,
  validatePrimer,
  validateReference,
  validateRoundName,
} from "@/lib/validation";

export function ConfigureStep() {
  const {
    referenceSeq,
    setReferenceSeq,
    rounds,
    updateRound,
    addRound,
    removeRound,
    adaptive,
    setAdaptive,
    filterStop,
    setFilterStop,
    useWasm,
    setUseWasm,
    pipelineMode,
    goPrev,
    goNext,
  } = useRunStore();

  const fastaInput = useRef<HTMLInputElement>(null);
  const perRound = pipelineMode === "per-round";

  const onFasta = async (file: File) => {
    const text = await file.text();
    const seq = text
      .split("\n")
      .filter((l) => !l.startsWith(">") && l.trim().length > 0)
      .join("")
      .toUpperCase()
      .replace(/[^ACGTN]/g, "");
    setReferenceSeq(seq);
  };

  const refError = validateReference(referenceSeq);
  const refValid = refError == null;
  const allRoundsValid = rounds.every(
    (r) =>
      validateRoundName(r.name) == null &&
      validatePrimer(r.fwPrimer, "Forward") == null &&
      validatePrimer(r.rvPrimer, "Reverse") == null &&
      // In per-round mode, every round must have a FASTQ bound to it —
      // either local file OR drive ref.
      (!perRound || r.file != null || r.driveRef != null),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Reference sequence</CardTitle>
          <CardDescription>
            5'→3' DNA. Used in the next step to align each round's primers and pick CDS bounds.
            Non-ACGTN characters are stripped automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={referenceSeq}
            onChange={(e) =>
              setReferenceSeq(sanitizeDna(e.target.value, LIMITS.REFERENCE_MAX))
            }
            placeholder="Paste sequence here (ACGTN only)…"
            className="font-mono text-xs min-h-[120px]"
            spellCheck={false}
            maxLength={LIMITS.REFERENCE_MAX}
          />
          <div className="flex items-center justify-between text-xs">
            <span className={refValid ? "text-muted-foreground" : "text-destructive"}>
              {referenceSeq.length} bp{refError ? ` — ${refError}` : ""}
            </span>
            <div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => fastaInput.current?.click()}
              >
                <FileUp className="mr-1.5 h-3.5 w-3.5" /> Load FASTA
              </Button>
              <input
                ref={fastaInput}
                type="file"
                accept=".fasta,.fa,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFasta(f);
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              Rounds
              {perRound && (
                <Badge variant="outline" className="font-normal">
                  per-round mode · each round picks its own FASTQ
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Define one round per selection step. Round 0 is the unselected library by convention.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={addRound}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add round
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {rounds.map((r, i) => (
            <div
              key={r.id}
              className="rounded-lg border bg-card p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">#{i}</Badge>
                  <div>
                    <Input
                      value={r.name}
                      onChange={(e) =>
                        updateRound(r.id, { name: sanitizeRoundName(e.target.value) })
                      }
                      maxLength={LIMITS.ROUND_NAME_MAX}
                      className="h-8 w-44 font-mono text-xs"
                      aria-label="Round name"
                    />
                    {(() => {
                      const e = validateRoundName(r.name);
                      return e ? (
                        <p className="mt-0.5 text-[10px] text-destructive">{e}</p>
                      ) : null;
                    })()}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeRound(r.id)}
                  disabled={rounds.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <Label className="text-xs">Forward primer (5'→3', incl. barcode)</Label>
                  <Input
                    value={r.fwPrimer}
                    onChange={(e) =>
                      updateRound(r.id, {
                        fwPrimer: sanitizeDna(e.target.value, LIMITS.PRIMER_MAX),
                      })
                    }
                    maxLength={LIMITS.PRIMER_MAX}
                    className="mt-1 font-mono text-xs"
                    placeholder="e.g. AAACTTTAAGAAGGAGATATACAT"
                  />
                  {(() => {
                    const e = validatePrimer(r.fwPrimer, "Forward");
                    return e && r.fwPrimer.length > 0 ? (
                      <p className="mt-1 text-[10px] text-destructive">{e}</p>
                    ) : null;
                  })()}
                </div>
                <div>
                  <Label className="text-xs">Reverse primer (5'→3', anti-sense)</Label>
                  <Input
                    value={r.rvPrimer}
                    onChange={(e) =>
                      updateRound(r.id, {
                        rvPrimer: sanitizeDna(e.target.value, LIMITS.PRIMER_MAX),
                      })
                    }
                    maxLength={LIMITS.PRIMER_MAX}
                    className="mt-1 font-mono text-xs"
                    placeholder="e.g. TTTCCACGCCGCCCCCCGTCCT"
                  />
                  {(() => {
                    const e = validatePrimer(r.rvPrimer, "Reverse");
                    return e && r.rvPrimer.length > 0 ? (
                      <p className="mt-1 text-[10px] text-destructive">{e}</p>
                    ) : null;
                  })()}
                </div>
              </div>
              {perRound && (
                <RoundFilePicker
                  file={r.file}
                  driveRef={r.driveRef}
                  onPickLocal={(f) => updateRound(r.id, { file: f, driveRef: null })}
                  onPickDrive={(d) => updateRound(r.id, { file: null, driveRef: d })}
                  onClear={() => updateRound(r.id, { file: null, driveRef: null })}
                />
              )}
              <p className="text-xs text-muted-foreground">
                CDS Start / End are set in the next step, where you see the aligned region.
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filters & settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            label="Adaptive: allow length variation (in-frame indels)"
            value={adaptive}
            onChange={setAdaptive}
          />
          <ToggleRow
            label="Discard CDS with premature stop codons"
            value={filterStop}
            onChange={setFilterStop}
          />
          <ToggleRow
            label="Use WASM hot path (recommended)"
            value={useWasm}
            onChange={setUseWasm}
          />
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="ghost" onClick={goPrev}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <Button
          size="lg"
          disabled={!refValid || !allRoundsValid}
          onClick={goNext}
        >
          Continue to Preview <ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-input text-primary focus:ring-1 focus:ring-ring"
      />
      <span>{label}</span>
    </label>
  );
}

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;

function RoundFilePicker({
  file,
  driveRef,
  onPickLocal,
  onPickDrive,
  onClear,
}: {
  file: File | null;
  driveRef: DriveFileRef | null;
  onPickLocal: (f: File) => void;
  onPickDrive: (d: DriveFileRef) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [drivePicking, setDrivePicking] = useState(false);
  const driveConfigured = !!(CLIENT_ID && API_KEY);
  const driveSignedIn = isDriveSignedIn();
  const hasSource = file != null || driveRef != null;

  const handleLocal = async (f: File) => {
    setError(null);
    setWarning(null);
    const sync = validateFastqFileSync(f);
    if (!sync.ok) {
      setError(sync.reason ?? "File rejected.");
      return;
    }
    const peek = await peekFastq(f);
    if (!peek.ok && peek.level === "error") {
      setError(peek.reason ?? "File rejected.");
      return;
    }
    if (peek.level === "warning" && peek.reason) {
      setWarning(peek.reason);
    }
    onPickLocal(f);
  };

  const handleDrive = async () => {
    setError(null);
    setWarning(null);
    if (!CLIENT_ID || !API_KEY) {
      setError("Drive isn't configured (missing OAuth client ID or API key).");
      return;
    }
    const auth = new DriveAuthProvider({ clientId: CLIENT_ID });
    if (!auth.isSignedIn()) {
      // Triggering OAuth from Configure would reload the page and wipe all
      // the primer/CDS state the user just typed. Instead, send them back
      // to Sources to sign in there first.
      setError(
        "You're not signed in to Google Drive yet — sign in via the Sources step (Drive tab) first, then come back here to pick files.",
      );
      return;
    }
    try {
      setDrivePicking(true);
      const token = await auth.getToken();
      const projectNumber = CLIENT_ID.split("-")[0]!;
      const picked = await showDrivePicker({
        oauthToken: token,
        apiKey: API_KEY,
        appId: projectNumber,
      });
      if (picked.length === 0) return;
      const first = picked[0]!;
      // Light sanity-check the filename even on Drive files.
      if (!/\.(fastq|fq)$/i.test(first.name)) {
        setWarning(`${first.name} doesn't end in .fastq/.fq — accepted, but it may not parse.`);
      }
      onPickDrive({ id: first.id, name: first.name, sizeBytes: first.sizeBytes });
    } catch (e) {
      setError(`Drive pick failed: ${(e as Error).message}`);
    } finally {
      setDrivePicking(false);
    }
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <Label className="text-xs">FASTQ for this round</Label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={hasSource && file ? "outline" : !hasSource ? "default" : "outline"}
          size="sm"
          onClick={() => inputRef.current?.click()}
        >
          <FileUp className="mr-1.5 h-3.5 w-3.5" />
          {file ? "Replace local…" : "Pick local…"}
        </Button>
        {driveConfigured && (
          <Button
            type="button"
            variant={driveRef ? "outline" : "outline"}
            size="sm"
            disabled={!driveSignedIn || drivePicking}
            onClick={() => void handleDrive()}
            title={
              driveSignedIn
                ? "Pick a FASTQ from your Google Drive"
                : "Sign in via Sources → Drive tab first to enable Drive picking"
            }
          >
            <Cloud className="mr-1.5 h-3.5 w-3.5" />
            {drivePicking ? "Opening…" : driveRef ? "Replace Drive…" : "Pick from Drive…"}
          </Button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".fastq,.fq"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleLocal(f);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
        {file && (
          <>
            <span className="truncate font-mono text-xs text-muted-foreground" title={file.name}>
              {file.name}
            </span>
            <span className="text-xs text-muted-foreground">· {formatBytes(file.size)}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setError(null);
                setWarning(null);
                onClear();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {driveRef && (
          <>
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={driveRef.name}
            >
              <Cloud className="mr-1 inline-block h-3 w-3 text-primary" />
              {driveRef.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {driveRef.sizeBytes != null ? `· ${formatBytes(driveRef.sizeBytes)}` : ""}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setError(null);
                setWarning(null);
                onClear();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {!hasSource && (
          <span className="text-xs text-muted-foreground">No file bound</span>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {warning && !error && <p className="mt-2 text-xs text-warning">{warning}</p>}
    </div>
  );
}

/** Lightweight check that runs every render — reads sessionStorage directly
 *  to avoid pulling the full DriveAuthProvider just to test "are we signed
 *  in". Mirrors DriveAuthProvider's internal cache key. */
function isDriveSignedIn(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  const raw = sessionStorage.getItem("cdna_drive_token");
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { token?: string; expiresAt?: number };
    return !!parsed.token && (parsed.expiresAt ?? 0) > Date.now();
  } catch {
    return false;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
