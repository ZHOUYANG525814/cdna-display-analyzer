import type { FastqSourceDescriptor, IFastqSource } from "@cdna/types";

/** Streaming gzip adapter. DecompressionStream preserves backpressure, so a
 * multi-GB .fastq.gz is never inflated into memory as one buffer. */
export class AutoDecompressFastqSource implements IFastqSource {
  constructor(private readonly inner: IFastqSource) {}
  describe(): FastqSourceDescriptor {
    const d = this.inner.describe();
    return isGzip(d.name) ? { ...d, sizeBytes: null } : d;
  }
  async open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const stream = await this.inner.open(signal);
    if (!isGzip(this.inner.describe().name)) return stream;
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot stream gzip FASTQ files. Use current Chrome/Edge/Firefox or an uncompressed FASTQ.");
    // DOM types model DecompressionStream input as BufferSource although a
    // fetch/File byte stream yields Uint8Array. At runtime these are the same
    // accepted chunks; keep the cast at this browser boundary only.
    return stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }
}
function isGzip(name: string): boolean { return /\.(?:fastq|fq|fastqsanger)\.gz$/i.test(name); }
