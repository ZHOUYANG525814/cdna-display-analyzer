/* tslint:disable */
/* eslint-disable */

/**
 * Candidate full-amplicon aligner. The reference, unique-kmer index, DP rows,
 * packed traceback and CIGAR buffers all live for the complete run. JS reads
 * a fixed metadata view and packed CIGAR view after each call.
 */
export class TargetedAligner {
    free(): void;
    [Symbol.dispose](): void;
    align(read: Uint8Array): boolean;
    alignWithEstimate(read: Uint8Array, offset: number, hits: number): boolean;
    cigarView(): Uint32Array;
    /**
     * Writes offset and hit count into result[9:11].
     */
    estimate(read: Uint8Array): void;
    constructor(reference: Uint8Array);
    resultView(): Float64Array;
}
