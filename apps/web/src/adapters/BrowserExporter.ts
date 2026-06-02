// Local-download artifacts for a finished pipeline run. Mirrors what the
// desktop GUI writes to ~/Documents/cDNA_Analyzer_Workspace/<PIN>/...:
//   - Master_Enrichment_Matrix.csv
//   - run_stats.json
//   - QC_Summary_Report.txt  (built here, see buildQcReport)
//
// All three are emitted as separate browser downloads triggered by user
// interaction; modern browsers will not let a single click produce multiple
// downloads unless they happen synchronously, so we kick all three off in
// the same task.

import type { PipelineOutcome } from "../worker/types";
import { CDNA_METHODS, formatMethodsAsText } from "@cdna/core";
import { useRunStore } from "../state/useRunStore";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click handler has had a chance to schedule the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ExportOptions {
  /** Used as the file-name prefix for all downloads (sanitized). */
  projectName: string;
}

export function exportOutcome(outcome: PipelineOutcome, opts: ExportOptions): void {
  const base = sanitizeFilename(opts.projectName || "cdna_run");

  if (outcome.csvBlob) {
    // Already a Blob coming back from the worker — download directly,
    // no re-clone.
    downloadBlob(outcome.csvBlob, `${base}_Master_Enrichment_Matrix.csv`);
  }
  downloadBlob(
    new Blob([outcome.runStatsJson], { type: "application/json" }),
    `${base}_run_stats.json`,
  );
  downloadBlob(
    new Blob([buildQcReport(outcome, opts.projectName)], { type: "text/plain;charset=utf-8" }),
    `${base}_QC_Summary_Report.txt`,
  );
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

// QC report layout follows 01_scripts/app.py:421-525 — section 1 (per-round
// demultiplex yield) and the global unassigned breakdown. Sections 2 (library
// diversity) and 3 (top-20 candidates) need the analyzer rows, which we don't
// transfer across the worker boundary yet; skipped here, fold in when the
// browser UI starts surfacing per-peptide views.
export function buildQcReport(outcome: PipelineOutcome, projectName: string): string {
  const lines: string[] = [];
  const sep = "=".repeat(85);
  lines.push(sep);
  lines.push("                cDNA-DISPLAY EXPERIMENT QC & SUMMARY REPORT");
  lines.push(sep);
  lines.push("");
  lines.push(`Project Name    : ${projectName || "(unnamed)"}`);
  lines.push(`Generation Time : ${new Date().toISOString().replace("T", " ").slice(0, 19)}`);
  lines.push("");

  lines.push("--- 1. DEMULTIPLEXING & SEQUENCE FILTERING TRACEABILITY ---");
  const u = outcome.unassignedBreakdown;
  lines.push(`[*] Global Unassigned (Orphan/Low Quality) Reads: ${outcome.globalUnassigned.toLocaleString()}`);
  lines.push(
    `    Breakdown — low_quality: ${u.low_quality.toLocaleString()}  ` +
      `no_anchor: ${u.no_anchor.toLocaleString()}  ` +
      `ambiguous: ${u.ambiguous.toLocaleString()}  ` +
      `barcode_mismatch: ${u.barcode_mismatch.toLocaleString()}`,
  );
  lines.push("");
  const header =
    `${"Round".padEnd(10)} | ${"Total Assigned".padEnd(15)} | ${"Truncated".padEnd(10)} | ` +
    `${"Indel/Shift".padEnd(12)} | ${"Stop Codon".padEnd(11)} | ${"Passed QC".padEnd(12)} | ` +
    `${"Yield (%)".padEnd(10)}`;
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const rnd of outcome.roundNames) {
    const s = outcome.statsByRound[rnd];
    if (!s) continue;
    const yieldPct = s.total_assigned > 0 ? (s.passed_qc / s.total_assigned) * 100 : 0;
    lines.push(
      `${rnd.padEnd(10)} | ${s.total_assigned.toLocaleString().padEnd(15)} | ` +
        `${s.discard_truncated.toLocaleString().padEnd(10)} | ` +
        `${s.discard_length_indel.toLocaleString().padEnd(12)} | ` +
        `${s.discard_stop_codon.toLocaleString().padEnd(11)} | ` +
        `${s.passed_qc.toLocaleString().padEnd(12)} | ` +
        `${yieldPct.toFixed(2).padStart(6)}%`,
    );
  }
  lines.push("");

  // --- Methods & column reference (Phase 6.14) ---------------------------
  // Append the static column documentation + the per-run parameters so the
  // QC_Summary_Report.txt artifact is self-contained: a user opening just
  // this file can understand every column in the CSV without other context.
  const s = useRunStore.getState();
  const settings: Array<{ label: string; value: string }> = [
    { label: "Pipeline mode", value: s.pipelineMode },
    { label: "WASM scoring", value: s.useWasm ? "on" : "off" },
    { label: "Min mean read Phred", value: `≥ ${s.minMeanPhred.toFixed(1)}` },
    { label: "Min mean CDS Phred", value: `≥ ${s.minMeanPhredCds.toFixed(1)}` },
    { label: "Discard premature stops", value: s.filterStop ? "yes" : "no" },
  ];
  const methodsText = formatMethodsAsText(CDNA_METHODS, {
    settings,
    libraryMedian: outcome.libraryMedianEnrich,
    hitCounts: outcome.hitCounts,
  });
  lines.push(methodsText);

  return lines.join("\n");
}
