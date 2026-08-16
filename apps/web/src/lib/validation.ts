// Centralized validation for user-entered configuration and sequencing files.
// Sanitizers are idempotent; validators never mutate their input.

export const LIMITS = {
  PROJECT_NAME_MAX: 100,
  ROUND_NAME_MAX: 50,
  PRIMER_MIN: 10,
  PRIMER_MAX: 100,
  REFERENCE_MIN: 30,
  REFERENCE_MAX: 50_000,
  CDS_OFFSET_MIN: -200,
  CDS_OFFSET_MAX: 10_000,
  ROUND_COUNT_MAX: 100,
  FASTQ_FILES_MAX: 1_000,
  // FASTQs have no size cap: the pipelines stream them instead of buffering
  // the whole file. Memory pressure depends on library diversity, not bytes.
} as const;

// --- Project and round names ---------------------------------------------

export function sanitizeProjectName(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_.\- ]/g, "")
    .slice(0, LIMITS.PROJECT_NAME_MAX);
}

export function validateProjectName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Project name is required.";
  if (trimmed.length > LIMITS.PROJECT_NAME_MAX) {
    return `Max ${LIMITS.PROJECT_NAME_MAX} characters.`;
  }
  if (!/^[a-zA-Z0-9_.\- ]+$/.test(trimmed)) {
    return "Only letters, digits, dot, dash, underscore, and space allowed.";
  }
  return null;
}

export function sanitizeRoundName(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, LIMITS.ROUND_NAME_MAX);
}

export function validateRoundName(value: string): string | null {
  if (value.length === 0) return "Round name is required.";
  if (value.length > LIMITS.ROUND_NAME_MAX) {
    return `Max ${LIMITS.ROUND_NAME_MAX} characters.`;
  }
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    return "Letters, digits, and underscore only (no spaces).";
  }
  return null;
}

// --- DNA -----------------------------------------------------------------

export function sanitizeDna(input: string, maxLength: number): string {
  return input
    .toUpperCase()
    .replace(/[^ACGTN]/g, "")
    .slice(0, maxLength);
}

export function validatePrimer(
  primer: string,
  kind: "Forward" | "Reverse",
): string | null {
  if (primer.length === 0) return `${kind} primer is required.`;
  if (primer.length < LIMITS.PRIMER_MIN) {
    return `${kind} primer too short (need ≥ ${LIMITS.PRIMER_MIN} bp).`;
  }
  if (primer.length > LIMITS.PRIMER_MAX) {
    return `${kind} primer too long (max ${LIMITS.PRIMER_MAX} bp).`;
  }
  if (!/^[ACGTN]+$/.test(primer)) {
    return `${kind} primer contains non-ACGTN characters.`;
  }
  return null;
}

export function validateReference(sequence: string): string | null {
  if (sequence.length === 0) return "Reference sequence is required.";
  if (sequence.length < LIMITS.REFERENCE_MIN) {
    return `Reference too short (need ≥ ${LIMITS.REFERENCE_MIN} bp).`;
  }
  if (sequence.length > LIMITS.REFERENCE_MAX) {
    return `Reference too long (max ${LIMITS.REFERENCE_MAX} bp).`;
  }
  if (!/^[ACGTN]+$/.test(sequence)) {
    return "Reference contains non-ACGTN characters.";
  }
  return null;
}

// --- CDS offsets ----------------------------------------------------------

export function validateCdsOffset(
  value: number | null,
  which: "Start" | "End",
): string | null {
  if (value == null || Number.isNaN(value)) {
    return `CDS ${which} is required.`;
  }
  if (!Number.isInteger(value)) return `CDS ${which} must be an integer.`;
  if (value < LIMITS.CDS_OFFSET_MIN || value > LIMITS.CDS_OFFSET_MAX) {
    return `CDS ${which} out of range (${LIMITS.CDS_OFFSET_MIN} to ${LIMITS.CDS_OFFSET_MAX}).`;
  }
  return null;
}

export function validateCdsPair(
  start: number | null,
  end: number | null,
): string | null {
  const startError = validateCdsOffset(start, "Start");
  if (startError) return startError;
  const endError = validateCdsOffset(end, "End");
  if (endError) return endError;
  if (end! < start!) return "CDS End must be ≥ Start.";
  const length = end! - start! + 1;
  if (length % 3 !== 0) {
    return `CDS length (${length}) must be a multiple of 3.`;
  }
  return null;
}

// --- FASTQ files ----------------------------------------------------------

export interface FileCheck {
  ok: boolean;
  /** A warning permits selection; an error rejects it. */
  level?: "error" | "warning";
  reason?: string;
}

export function validateFastqFileName(
  name: string,
  sizeBytes: number | null,
): FileCheck {
  if (!name || name.length > 255) {
    return {
      ok: false,
      level: "error",
      reason: "Filename must contain 1–255 characters.",
    };
  }
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 32 || '<>:"/\\|?*'.includes(char)) {
      return {
        ok: false,
        level: "error",
        reason: "Filename contains illegal characters.",
      };
    }
  }
  if (!/\.(fastq|fq)(?:\.gz)?$/i.test(name)) {
    return {
      ok: false,
      level: "error",
      reason: "Filename must end in .fastq, .fq, .fastq.gz, or .fq.gz.",
    };
  }
  if (/\.gz$/i.test(name) && typeof DecompressionStream === "undefined") {
    return {
      ok: false,
      level: "error",
      reason: "This browser cannot stream gzip FASTQ files; use an uncompressed file or a current browser.",
    };
  }
  if (sizeBytes === 0) {
    return { ok: false, level: "error", reason: "File is empty." };
  }
  if (
    sizeBytes != null &&
    (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  ) {
    return {
      ok: false,
      level: "error",
      reason: "File size metadata is invalid.",
    };
  }
  return { ok: true };
}

export function validateDriveFastqRef(file: {
  id: string;
  name: string;
  sizeBytes: number | null;
}): FileCheck {
  if (
    !file.id ||
    file.id.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(file.id)
  ) {
    return { ok: false, level: "error", reason: "Drive file ID is invalid." };
  }
  return validateFastqFileName(file.name, file.sizeBytes);
}

export function validateFastqFileSync(file: File): FileCheck {
  return validateFastqFileName(file.name, file.size);
}

/** Validate the first complete record without buffering the full FASTQ. */
export async function peekFastq(file: File): Promise<FileCheck> {
  try {
    let stream: ReadableStream<Uint8Array> = file.stream();
    if (/\.gz$/i.test(file.name)) {
      if (typeof DecompressionStream === "undefined") {
        return { ok: false, level: "error", reason: "This browser cannot stream gzip files." };
      }
      stream = stream.pipeThrough(
        new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      );
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let head = "";
    try {
      while (head.length < 256 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) head += decoder.decode(value, { stream: true });
        if ((head.match(/\n/g)?.length ?? 0) >= 4) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const lines = head.split(/\r?\n/);
    if (lines.length < 4) {
      return {
        ok: false,
        level: "error",
        reason: "No complete FASTQ record found in the stream prefix.",
      };
    }
    if (
      !lines[0]!.startsWith("@") ||
      lines[0]!.length < 2 ||
      /^[ \t]/.test(lines[0]!.slice(1))
    ) {
      return {
        ok: false,
        level: "error",
        reason: "First FASTQ header is invalid.",
      };
    }
    if (!lines[2]!.startsWith("+")) {
      return {
        ok: false,
        level: "error",
        reason: "Third line doesn't start with '+' — does not look like FASTQ.",
      };
    }
    if (!/^[ACGTNacgtn]+$/.test(lines[1]!)) {
      return {
        ok: false,
        level: "error",
        reason: "First sequence contains bases outside A/C/G/T/N.",
      };
    }
    if (lines[1]!.length !== lines[3]!.length) {
      return {
        ok: false,
        level: "error",
        reason: `Sequence (${lines[1]!.length} bp) and quality (${lines[3]!.length} chars) length mismatch in first record.`,
      };
    }
    for (const char of lines[3]!) {
      const code = char.charCodeAt(0);
      if (code < 33 || code > 126) {
        return {
          ok: false,
          level: "error",
          reason: "First quality string is not valid Phred+33 text.",
        };
      }
    }
    for (const char of lines[0]!.slice(1)) {
      const code = char.charCodeAt(0);
      if (code < 32 || code > 126) {
        return {
          ok: true,
          level: "warning",
          reason: "First-record header has unusual characters; proceeding anyway.",
        };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      level: "error",
      reason: `Could not read file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
