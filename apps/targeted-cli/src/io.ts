import { createReadStream } from "node:fs";

export async function* fileChunks(path: string): AsyncIterableIterator<Uint8Array> {
  for await (const chunk of createReadStream(path)) {
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
}

export function quantile(sorted: readonly number[], probability: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const a = sorted[lower]!;
  const b = sorted[Math.min(lower + 1, sorted.length - 1)]!;
  return a + ((b - a) * fraction);
}
