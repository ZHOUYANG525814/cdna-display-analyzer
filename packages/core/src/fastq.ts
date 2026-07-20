// FASTQ ingest. Streams Uint8Array chunks → FASTQ records, byte-for-byte
// compatible with the desktop Python pipeline's per-line reader in
// 01_scripts/core_engine.py: 4 lines per record (header / seq / + / qual),
// trailing CR stripped to match Python's str.rstrip behavior on FASTQ data.

const NEWLINE = 0x0a;
const CR = 0x0d;
const EMPTY = new Uint8Array(0);

export interface FastqRecord {
  // Raw bytes of each line, with trailing \n and \r stripped.
  // Views may share the parent chunk buffer; copy if retention is needed.
  header: Uint8Array;
  seq: Uint8Array;
  separator: Uint8Array;
  qual: Uint8Array;
}

/** Strict record-level validation shared by the NGS and targeted Nanopore
 * pipelines. The resilient reader handles framing recovery; this function
 * decides whether a framed/partial record is safe to analyze. */
export function isValidFastqRecord(record: FastqRecord): boolean {
  if (
    record.header.length < 2 ||
    record.header[0] !== 0x40 ||
    record.header[1] === 0x20 ||
    record.header[1] === 0x09 ||
    record.separator[0] !== 0x2b ||
    record.seq.length === 0 ||
    record.seq.length !== record.qual.length
  ) {
    return false;
  }
  for (let index = 1; index < record.header.length; index++) {
    const byte = record.header[index]!;
    if (byte !== 0x09 && (byte < 32 || byte > 126)) return false;
  }
  for (const byte of record.seq) {
    const upper = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
    if (
      upper !== 0x41 &&
      upper !== 0x43 &&
      upper !== 0x47 &&
      upper !== 0x54 &&
      upper !== 0x4e
    ) {
      return false;
    }
  }
  for (const byte of record.qual) {
    if (byte < 33 || byte > 126) return false;
  }
  return true;
}

// Byte-first line splitter. Maintains a carry buffer to stitch lines across
// arbitrary chunk boundaries (TCP framing breaks streams at any byte offset,
// not at \n). Emitted line views drop trailing CR + LF to match Python's
// .rstrip() on FASTQ data lines.
export class LineSplitter {
  private carry: Uint8Array = EMPTY;

  *consume(chunk: Uint8Array): IterableIterator<Uint8Array> {
    if (chunk.length === 0) return;

    let buf: Uint8Array;
    if (this.carry.length === 0) {
      buf = chunk;
    } else {
      buf = new Uint8Array(this.carry.length + chunk.length);
      buf.set(this.carry, 0);
      buf.set(chunk, this.carry.length);
      this.carry = EMPTY;
    }

    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === NEWLINE) {
        let end = i;
        if (end > start && buf[end - 1] === CR) end--;
        yield buf.subarray(start, end);
        start = i + 1;
      }
    }

    if (start < buf.length) {
      // Tail without trailing newline becomes carry. Copy with .slice() so
      // the upstream chunk buffer is free to be GC'd; subarray would pin it.
      this.carry = buf.slice(start);
    }
  }

  *flush(): IterableIterator<Uint8Array> {
    if (this.carry.length > 0) {
      let end = this.carry.length;
      if (end > 0 && this.carry[end - 1] === CR) end--;
      yield this.carry.subarray(0, end);
      this.carry = EMPTY;
    }
  }
}

// Bytes → FASTQ records. Trailing partial record at EOF is dropped (matches
// the Python reader, which exits its while-loop when readline returns "").
export async function* readFastqRecords(
  source: AsyncIterable<Uint8Array>,
): AsyncIterableIterator<FastqRecord> {
  const splitter = new LineSplitter();
  const lineBuf: Uint8Array[] = [];

  const drain = function* (): IterableIterator<FastqRecord> {
    while (lineBuf.length >= 4) {
      const header = lineBuf.shift()!;
      const seq = lineBuf.shift()!;
      const separator = lineBuf.shift()!;
      const qual = lineBuf.shift()!;
      yield { header, seq, separator, qual };
    }
  };

  for await (const chunk of source) {
    for (const line of splitter.consume(chunk)) {
      lineBuf.push(line);
    }
    for (const rec of drain()) yield rec;
  }

  for (const line of splitter.flush()) {
    lineBuf.push(line);
  }
  for (const rec of drain()) yield rec;
}

/** Resynchronizing FASTQ reader for untrusted Nanopore inputs. Malformed or
 * partial records are yielded for explicit QC, and a later @header restores
 * framing instead of corrupting every following record. */
export async function* readFastqRecordsResilient(
  source: AsyncIterable<Uint8Array>,
): AsyncIterableIterator<FastqRecord> {
  const splitter = new LineSplitter();
  let state: 0 | 1 | 2 | 3 | 4 = 0; // 4 = skip damaged fragment until next header
  let header: Uint8Array = EMPTY;
  let seq: Uint8Array = EMPTY;
  let separator: Uint8Array = EMPTY;
  const consumeLine = function* (line: Uint8Array): IterableIterator<FastqRecord> {
    if (state === 0) {
      if (line[0] === 0x40) { header = line; state = 1; }
      else { yield { header: line, seq: EMPTY, separator: EMPTY, qual: EMPTY }; state = 4; }
    } else if (state === 1) {
      if (line[0] === 0x40) {
        yield { header, seq: EMPTY, separator: EMPTY, qual: EMPTY };
        header = line;
      } else { seq = line; state = 2; }
    } else if (state === 2) {
      if (line[0] === 0x2b) { separator = line; state = 3; }
      else {
        yield { header, seq, separator: line, qual: EMPTY };
        if (line[0] === 0x40) { header = line; state = 1; }
        else state = 4;
      }
    } else if (state === 4) {
      if (line[0] === 0x40) { header = line; state = 1; }
    } else if (line[0] === 0x40 && (line.length !== seq.length || hasAsciiWhitespace(line))) {
      yield { header, seq, separator, qual: EMPTY };
      header = line; state = 1;
    } else {
      yield { header, seq, separator, qual: line };
      state = 0;
    }
  };
  for await (const chunk of source) for (const line of splitter.consume(chunk)) yield* consumeLine(line);
  for (const line of splitter.flush()) yield* consumeLine(line);
  if (state !== 0 && state !== 4) yield { header, seq: state >= 2 ? seq : EMPTY, separator: state >= 3 ? separator : EMPTY, qual: EMPTY };
}

function hasAsciiWhitespace(line: Uint8Array): boolean {
  for (const b of line) if (b === 0x20 || b === 0x09) return true;
  return false;
}

// Mean Phred+33 score over qual bytes. Empty qual returns 0 (treated as failing
// any positive threshold). Python's equivalent crashes with ZeroDivisionError
// on empty qual — the only way to hit that is a malformed FASTQ where Python
// would also abort the file, so the count divergence is bounded to the corruption.
export function meanPhred(qualBytes: Uint8Array): number {
  const n = qualBytes.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += qualBytes[i] - 33;
  return sum / n;
}

// Convenience: bytes → ASCII string. Use only when string semantics are
// required (preview, Map keys); the hot demultiplex path stays in bytes.
const LATIN1 = new TextDecoder("latin1");
export function bytesToAscii(bytes: Uint8Array): string {
  return LATIN1.decode(bytes);
}
