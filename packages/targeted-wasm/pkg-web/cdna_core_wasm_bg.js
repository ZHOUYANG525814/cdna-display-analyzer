/**
 * Candidate full-amplicon aligner. The reference, unique-kmer index, DP rows,
 * packed traceback and CIGAR buffers all live for the complete run. JS reads
 * a fixed metadata view and packed CIGAR view after each call.
 */
export class TargetedAligner {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TargetedAlignerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_targetedaligner_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} read
     * @returns {boolean}
     */
    align(read) {
        const ptr0 = passArray8ToWasm0(read, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.targetedaligner_align(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} read
     * @param {number} offset
     * @param {number} hits
     * @returns {boolean}
     */
    alignWithEstimate(read, offset, hits) {
        const ptr0 = passArray8ToWasm0(read, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.targetedaligner_alignWithEstimate(this.__wbg_ptr, ptr0, len0, offset, hits);
        return ret !== 0;
    }
    /**
     * @returns {Uint32Array}
     */
    cigarView() {
        const ret = wasm.targetedaligner_cigarView(this.__wbg_ptr);
        return ret;
    }
    /**
     * Writes offset and hit count into result[9:11].
     * @param {Uint8Array} read
     */
    estimate(read) {
        const ptr0 = passArray8ToWasm0(read, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.targetedaligner_estimate(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {Uint8Array} reference
     */
    constructor(reference) {
        const ptr0 = passArray8ToWasm0(reference, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.targetedaligner_new(ptr0, len0);
        this.__wbg_ptr = ret;
        TargetedAlignerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {Float64Array}
     */
    resultView() {
        const ret = wasm.targetedaligner_resultView(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) TargetedAligner.prototype[Symbol.dispose] = TargetedAligner.prototype.free;
export function __wbg___wbindgen_throw_1506f2235d1bdba0(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(F64)) -> NamedExternref("Float64Array")`.
    const ret = getArrayF64FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_cast_0000000000000002(arg0, arg1) {
    // Cast intrinsic for `Ref(Slice(U32)) -> NamedExternref("Uint32Array")`.
    const ret = getArrayU32FromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
const TargetedAlignerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_targetedaligner_free(ptr, 1));

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
