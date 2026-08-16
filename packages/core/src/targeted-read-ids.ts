/** Exact, memory-conscious read-ID set.
 *
 * Dorado's canonical lower-case UUIDs are stored losslessly as their complete
 * 128 bits in open-addressed typed arrays. Arbitrary identifiers retain exact
 * JavaScript string semantics in a fallback Set; no probabilistic filter or
 * truncated hash is used. */
export class TargetedReadIdSet {
  private high = new BigUint64Array(1024);
  private low = new BigUint64Array(1024);
  private occupied = new Uint8Array(1024);
  private uuidCount = 0;
  private readonly other = new Set<string>();

  /** Add an ID. Returns true when new, false when it was already present. */
  add(id: string): boolean {
    const uuid = parseLowerUuid(id);
    if (!uuid) {
      if (this.other.has(id)) return false;
      this.other.add(id);
      return true;
    }
    if ((this.uuidCount + 1) * 10 >= this.high.length * 7) this.grow();
    return this.insert(uuid[0], uuid[1]);
  }

  get size(): number { return this.uuidCount + this.other.size; }

  private insert(high: bigint, low: bigint): boolean {
    const mask = this.high.length - 1;
    let slot = uuidHash(high, low) & mask;
    while (this.occupied[slot] !== 0) {
      if (this.high[slot] === high && this.low[slot] === low) return false;
      slot = (slot + 1) & mask;
    }
    this.occupied[slot] = 1;
    this.high[slot] = high;
    this.low[slot] = low;
    this.uuidCount++;
    return true;
  }

  private grow(): void {
    const oldHigh = this.high;
    const oldLow = this.low;
    const oldOccupied = this.occupied;
    this.high = new BigUint64Array(oldHigh.length * 2);
    this.low = new BigUint64Array(oldLow.length * 2);
    this.occupied = new Uint8Array(oldOccupied.length * 2);
    this.uuidCount = 0;
    for (let index = 0; index < oldOccupied.length; index++) {
      if (oldOccupied[index] !== 0) this.insert(oldHigh[index]!, oldLow[index]!);
    }
  }
}

function parseLowerUuid(id: string): readonly [bigint, bigint] | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return null;
  }
  const hex = id.replaceAll("-", "");
  return [BigInt(`0x${hex.slice(0, 16)}`), BigInt(`0x${hex.slice(16)}`)];
}

function uuidHash(high: bigint, low: bigint): number {
  const mixed = high ^ (high >> 32n) ^ low ^ (low >> 32n);
  return Number(mixed & 0xffff_ffffn) >>> 0;
}
