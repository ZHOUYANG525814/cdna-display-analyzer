import { useRef } from "react";
import { ArrowLeft, ArrowRight, Plus, Trash2, FileUp } from "lucide-react";
import { useRunStore } from "@/state/useRunStore";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

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
    goPrev,
    goNext,
  } = useRunStore();

  const fastaInput = useRef<HTMLInputElement>(null);

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

  const refValid = referenceSeq.length >= 30;
  const allRoundsValid = rounds.every(
    (r) => r.fwPrimer.length >= 10 && r.rvPrimer.length >= 10 && r.name.length > 0,
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
            onChange={(e) => setReferenceSeq(e.target.value)}
            placeholder="Paste sequence here (ACGTN only)…"
            className="font-mono text-xs min-h-[120px]"
            spellCheck={false}
          />
          <div className="flex items-center justify-between text-xs">
            <span className={refValid ? "text-muted-foreground" : "text-destructive"}>
              {referenceSeq.length} bp{refValid ? "" : " — need ≥30 bp"}
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
            <CardTitle>Rounds</CardTitle>
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
                  <Input
                    value={r.name}
                    onChange={(e) => updateRound(r.id, { name: e.target.value })}
                    className="h-8 w-44 font-mono text-xs"
                  />
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
                        fwPrimer: e.target.value.toUpperCase().replace(/[^ACGTN]/g, ""),
                      })
                    }
                    className="mt-1 font-mono text-xs"
                    placeholder="e.g. AAACTTTAAGAAGGAGATATACAT"
                  />
                </div>
                <div>
                  <Label className="text-xs">Reverse primer (5'→3', anti-sense)</Label>
                  <Input
                    value={r.rvPrimer}
                    onChange={(e) =>
                      updateRound(r.id, {
                        rvPrimer: e.target.value.toUpperCase().replace(/[^ACGTN]/g, ""),
                      })
                    }
                    className="mt-1 font-mono text-xs"
                    placeholder="e.g. TTTCCACGCCGCCCCCCGTCCT"
                  />
                </div>
              </div>
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
