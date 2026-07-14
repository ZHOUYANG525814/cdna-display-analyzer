import type { DriveFileRef } from "@/worker/types";

export const NANOPORE_INPUT_LIMITS = Object.freeze({
  maxRounds: 16,
  maxFilesPerRound: 64,
  maxSites: 256,
  minReferenceBases: 30,
  maxReferenceBases: 50_000,
});

export const SUPPORTED_NANOPORE_FASTQ = /\.(?:fastq|fq|fastqsanger)(?:\.gz)?$/i;

export interface NanoporeFileCheck { ok: boolean; reason?: string; }

export function validateNanoporeFileName(name: string, sizeBytes: number | null): NanoporeFileCheck {
  if (!name || name.length > 255) return { ok: false, reason: "Filename must contain 1–255 characters." };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>:"/\\|?*]/.test(name)) return { ok: false, reason: "Filename contains unsafe characters." };
  if (!SUPPORTED_NANOPORE_FASTQ.test(name)) return { ok: false, reason: "Supported: .fastq, .fq, .fastqsanger, and their .gz forms." };
  if (sizeBytes === 0) return { ok: false, reason: "File is empty." };
  if (sizeBytes != null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) return { ok: false, reason: "File size metadata is invalid." };
  return { ok: true };
}

export function validateNanoporeLocalFile(file: File): NanoporeFileCheck {
  return validateNanoporeFileName(file.name, file.size);
}

export function validateNanoporeDriveFile(file: DriveFileRef): NanoporeFileCheck {
  if (!file.id || file.id.length > 256 || !/^[A-Za-z0-9_-]+$/.test(file.id)) return { ok: false, reason: "Drive file ID is invalid." };
  return validateNanoporeFileName(file.name, file.sizeBytes);
}

/** Validate the first decompressed FASTQ record without buffering the file. */
export async function peekNanoporeFastq(file: File): Promise<NanoporeFileCheck> {
  const basic = validateNanoporeLocalFile(file);
  if (!basic.ok) return basic;
  try {
    let stream: ReadableStream<Uint8Array> = file.stream();
    if (/\.gz$/i.test(file.name)) {
      if (typeof DecompressionStream === "undefined") return { ok: false, reason: "This browser cannot stream gzip files." };
      stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    try {
      while (text.length < 16_384) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) text += decoder.decode(value, { stream: true });
        if ((text.match(/\n/g)?.length ?? 0) >= 4) break;
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const lines = text.split(/\r?\n/);
    if (lines.length < 4) return { ok: false, reason: "No complete FASTQ record found in the stream prefix." };
    if (!lines[0]!.startsWith("@") || !lines[2]!.startsWith("+")) return { ok: false, reason: "FASTQ header/separator structure is invalid." };
    if (!/^[ACGTNacgtn]+$/.test(lines[1]!)) return { ok: false, reason: "First sequence contains bases outside A/C/G/T/N." };
    if (lines[1]!.length !== lines[3]!.length) return { ok: false, reason: "First sequence and quality lengths differ." };
    for (const ch of lines[3]!) {
      const code = ch.charCodeAt(0);
      if (code < 33 || code > 126) return { ok: false, reason: "First quality string is not valid Phred+33 text." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Cannot read FASTQ stream: ${error instanceof Error ? error.message : String(error)}` };
  }
}
