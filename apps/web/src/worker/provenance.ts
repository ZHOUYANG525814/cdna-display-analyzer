import type { DriveFileRef } from "./types";

export interface InputSourceProvenance {
  order: number;
  round: string;
  fileName: string;
  sizeBytes: number | null;
  compressed: boolean;
  origin: "local" | "google-drive";
  firstRecordCheck: "passed-at-selection" | "validated-during-stream";
  descriptorFingerprintSha256: string;
  fingerprintMethod: "name-size-lastModified" | "drive-id-name-size";
}

export interface RunProvenance {
  configVersion: string;
  referenceSha256: string;
  inputs: InputSourceProvenance[];
  capabilities: {
    readableStream: boolean;
    decompressionStream: boolean;
    blobOutput: boolean;
  };
  benchmarkManifestRequirement: "full-file-sha256-generated-offline";
  runtime: Record<string, string | number | boolean>;
}

export async function buildRunProvenance(args: {
  localFiles: ReadonlyArray<File>;
  driveFiles: ReadonlyArray<DriveFileRef>;
  sourceRoundIndices?: ReadonlyArray<number>;
  roundNames: ReadonlyArray<string>;
  reference: string;
  configVersion: string;
  runtime: Record<string, string | number | boolean>;
}): Promise<RunProvenance> {
  const sources = [
    ...args.localFiles.map((file) => ({
      fileName: file.name,
      sizeBytes: file.size as number | null,
      origin: "local" as const,
      firstRecordCheck: "passed-at-selection" as const,
      fingerprintMethod: "name-size-lastModified" as const,
      descriptor: `${file.name}\0${file.size}\0${file.lastModified}`,
    })),
    ...args.driveFiles.map((file) => ({
      fileName: file.name,
      sizeBytes: file.sizeBytes,
      origin: "google-drive" as const,
      firstRecordCheck: "validated-during-stream" as const,
      fingerprintMethod: "drive-id-name-size" as const,
      descriptor: `${file.id}\0${file.name}\0${file.sizeBytes ?? "unknown"}`,
    })),
  ];
  const inputs = await Promise.all(sources.map(async (source, order) => ({
    order,
    round: args.sourceRoundIndices
      ? (args.roundNames[args.sourceRoundIndices[order]!] ?? "invalid-round")
      : "multiplexed",
    fileName: source.fileName,
    sizeBytes: source.sizeBytes,
    compressed: /\.(?:fastq|fq|fastqsanger)\.gz$/i.test(source.fileName),
    origin: source.origin,
    firstRecordCheck: source.firstRecordCheck,
    descriptorFingerprintSha256: await sha256(source.descriptor),
    fingerprintMethod: source.fingerprintMethod,
  })));
  return {
    configVersion: args.configVersion,
    referenceSha256: await sha256(args.reference),
    inputs,
    capabilities: {
      readableStream: typeof ReadableStream !== "undefined",
      decompressionStream: typeof DecompressionStream !== "undefined",
      blobOutput: typeof Blob !== "undefined",
    },
    benchmarkManifestRequirement: "full-file-sha256-generated-offline",
    runtime: args.runtime,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
