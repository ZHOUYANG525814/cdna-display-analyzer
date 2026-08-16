/* @ts-self-types="./cdna_core_wasm.d.ts" */
import * as wasm from "./cdna_core_wasm_bg.wasm";
import { __wbg_set_wasm } from "./cdna_core_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    TargetedAligner
} from "./cdna_core_wasm_bg.js";
