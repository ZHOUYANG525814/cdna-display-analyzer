// WASM hot-path for the demultiplex pipeline. Three exports:
//   - `Scorer`: holds per-round (fw_anchor, fw_barcode) pairs and produces a
//     ScoreResult for a given read in a single Rust call (one wasm boundary
//     crossing per read, not per round). This replaces the inner loop of
//     packages/core/src/demultiplex.ts::processRead.
//   - `reverse_complement`: bytes → bytes, used for the RC retry branch.
//   - `mean_phred`: pre-demultiplex quality filter.
//
// All three keep semantics byte-identical to the TS reference so the parity
// test stays green when the WASM-backed path is in use.

use wasm_bindgen::prelude::*;
use js_sys::Float64Array;

// Layout of the result buffer:
//   [0] best_score          (f64; +Inf when no anchor matched any round)
//   [1] runner_up_score     (f64; +Inf when only one round matched)
//   [2] best_round_idx      (f64; -1.0 sentinel when no anchor matched)
//   [3] fw_end_idx          (f64; -1.0 sentinel when no anchor matched)
//
// The buffer lives inside the Scorer struct. `resultView()` hands JS a
// Float64Array that aliases linear memory at this address — no copy on the
// way out. JS reads the four values directly after each `score()` call.
pub const RESULT_LEN: usize = 4;

struct RoundData {
    fw_anchor: Vec<u8>,
    fw_barcode: Vec<u8>,
}

#[wasm_bindgen]
pub struct Scorer {
    rounds: Vec<RoundData>,
    result: [f64; RESULT_LEN],
}

#[wasm_bindgen]
impl Scorer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { rounds: Vec::new(), result: [0.0; RESULT_LEN] }
    }

    /// Register one round. Call in the same order the TS side iterates rounds;
    /// that order is the stable-sort tiebreaker on equal scores.
    #[wasm_bindgen(js_name = addRound)]
    pub fn add_round(&mut self, fw_anchor: Vec<u8>, fw_barcode: Vec<u8>) {
        self.rounds.push(RoundData { fw_anchor, fw_barcode });
    }

    /// Returns a length-4 Float64Array view aliasing the Scorer's internal
    /// result buffer. JS calls this once after construction and re-reads
    /// elements after every `score()` call — no per-call allocation or copy.
    ///
    /// Safety: the view becomes detached if WASM linear memory grows. Since
    /// `score()` doesn't allocate on the steady state (no Vec creation, the
    /// read buffer is malloc/freed via wasm-bindgen's pool which doesn't
    /// grow once warm), the view stays valid. JS still checks and rebuilds
    /// the view if `byteLength === 0`.
    #[wasm_bindgen(js_name = resultView)]
    pub fn result_view(&self) -> Float64Array {
        unsafe { Float64Array::view(&self.result) }
    }

    /// Score one read against every round's (fw_anchor, fw_barcode). Mirrors
    /// the Python and TS scoring exactly:
    ///   - N in the read at a barcode position → +0.5 penalty
    ///   - non-matching base (and not N)        → +1.0 penalty
    ///   - missing barcode bases (read starts mid-barcode) → +1.0 per missing
    ///
    /// Ties go to the earliest-added round (stable, matching the TS path).
    /// Writes results into `self.result` (read via `result_view()` on JS).
    pub fn score(&mut self, seq: &[u8]) {
        let mut best_score = f64::INFINITY;
        let mut runner_up_score = f64::INFINITY;
        let mut best_round_idx: i32 = -1;
        let mut fw_end_idx: i32 = -1;

        for (idx, round) in self.rounds.iter().enumerate() {
            let anchor_pos = match find_subslice(seq, &round.fw_anchor) {
                Some(p) => p,
                None => continue,
            };

            let expected_bc = &round.fw_barcode;
            let expected_bc_len = expected_bc.len();
            let bc_start = if anchor_pos >= expected_bc_len {
                anchor_pos - expected_bc_len
            } else {
                0
            };
            let read_bc_len = anchor_pos - bc_start;
            let len_diff = expected_bc_len - read_bc_len;

            let mut score: f64 = len_diff as f64;
            let compare_start = len_diff; // skip the missing prefix of expected
            for j in 0..read_bc_len {
                let e = expected_bc[compare_start + j];
                let v = seq[bc_start + j];
                if v == b'N' {
                    score += 0.5;
                } else if v != e {
                    score += 1.0;
                }
            }

            // Stable top-2 tracking: a strictly-lower score promotes to best
            // and demotes the previous best to runner-up; an equal-to-best
            // score becomes runner-up (preserving first-added wins on ties).
            if score < best_score {
                runner_up_score = best_score;
                best_score = score;
                best_round_idx = idx as i32;
                fw_end_idx = (anchor_pos + round.fw_anchor.len()) as i32;
            } else if score < runner_up_score {
                runner_up_score = score;
            }
        }

        self.result[0] = best_score;
        self.result[1] = runner_up_score;
        self.result[2] = best_round_idx as f64;
        self.result[3] = fw_end_idx as f64;
    }
}

#[wasm_bindgen(js_name = reverseComplement)]
pub fn reverse_complement(input: &[u8]) -> Vec<u8> {
    let n = input.len();
    let mut out = vec![0u8; n];
    for i in 0..n {
        out[i] = match input[n - 1 - i] {
            b'A' => b'T',
            b'T' => b'A',
            b'C' => b'G',
            b'G' => b'C',
            b'N' => b'N',
            x => x, // pass through unknown bases (matches Python str.translate)
        };
    }
    out
}

#[wasm_bindgen(js_name = meanPhred)]
pub fn mean_phred(qual: &[u8]) -> f64 {
    if qual.is_empty() {
        return 0.0;
    }
    let mut sum: i64 = 0;
    for &b in qual {
        sum += (b as i64) - 33;
    }
    (sum as f64) / (qual.len() as f64)
}

// Naive multi-byte substring search. Anchors are ~10 bp, reads ~150 bp, so
// the naive O(n*m) cost is ~1500 byte ops per call — well under what a
// fancier algorithm (Boyer-Moore / two-way) would add in setup overhead.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    let n_len = needle.len();
    let h_len = haystack.len();
    if n_len == 0 {
        return Some(0);
    }
    if n_len > h_len {
        return None;
    }
    let last = h_len - n_len;
    let first = needle[0];
    'outer: for i in 0..=last {
        if haystack[i] != first {
            continue;
        }
        for j in 1..n_len {
            if haystack[i + j] != needle[j] {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}
