// WASM hot-path. Two pipelines share this crate:
//
// cDNA-DISPLAY (Phase 1–2):
//   - `Scorer`: per-round (fw_anchor, fw_barcode) scoring for the cDNA tool.
//   - `reverse_complement`, `mean_phred`: shared helpers.
//
// Nanopore SSM (Phase 6.2b):
//   - `DualAnchorScorer`: per-site (fw_anchor, rv_anchor) banded-tolerant
//     extraction. Locates the inter-anchor ROI in a Nanopore read with
//     up to `max_subs + max_indels` edits per anchor.
//   - `bandedAlign` (free function, exported for tests + the TS engine's
//     direct-call path when WASM is enabled).
//
// All semantics mirror the TS reference (packages/core/src/) so parity tests
// stay byte-identical regardless of which path runs.

use js_sys::Float64Array;
#[cfg(feature = "targeted")]
use js_sys::Uint32Array;
#[cfg(feature = "targeted")]
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

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

#[cfg(feature = "cdna")]
struct RoundData {
    fw_anchor: Vec<u8>,
    fw_barcode: Vec<u8>,
}

#[cfg(feature = "cdna")]
#[wasm_bindgen]
pub struct Scorer {
    rounds: Vec<RoundData>,
    result: [f64; RESULT_LEN],
}

#[cfg(feature = "cdna")]
#[wasm_bindgen]
impl Scorer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            rounds: Vec::new(),
            result: [0.0; RESULT_LEN],
        }
    }

    /// Register one round. Call in the same order the TS side iterates rounds;
    /// that order is the stable-sort tiebreaker on equal scores.
    #[wasm_bindgen(js_name = addRound)]
    pub fn add_round(&mut self, fw_anchor: Vec<u8>, fw_barcode: Vec<u8>) {
        self.rounds.push(RoundData {
            fw_anchor,
            fw_barcode,
        });
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

#[cfg(feature = "cdna")]
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

#[cfg(feature = "cdna")]
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

// --- Targeted Nanopore: run-scoped full-reference aligner ----------------

#[cfg(feature = "targeted")]
const TARGET_RESULT_LEN: usize = 13;
#[cfg(feature = "targeted")]
const TARGET_NEG: i32 = -0x3fff_ffff;
#[cfg(feature = "targeted")]
const TARGET_TRACE_NONE: u8 = 255;
#[cfg(feature = "targeted")]
const TARGET_M: usize = 0;
#[cfg(feature = "targeted")]
const TARGET_I: usize = 1;
#[cfg(feature = "targeted")]
const TARGET_D: usize = 2;

/// Candidate full-amplicon aligner. The reference, unique-kmer index, DP rows,
/// packed traceback and CIGAR buffers all live for the complete run. JS reads
/// a fixed metadata view and packed CIGAR view after each call.
#[cfg(feature = "targeted")]
#[wasm_bindgen]
pub struct TargetedAligner {
    reference: Vec<u8>,
    seed_k: usize,
    unique_kmers: HashMap<u32, i32>,
    offsets: Vec<i32>,
    prev_m: Vec<i32>,
    prev_i: Vec<i32>,
    prev_d: Vec<i32>,
    curr_m: Vec<i32>,
    curr_i: Vec<i32>,
    curr_d: Vec<i32>,
    trace: Vec<u8>,
    reversed: Vec<u8>,
    cigar: Vec<u32>,
    result: [f64; TARGET_RESULT_LEN],
}

#[cfg(feature = "targeted")]
#[wasm_bindgen]
impl TargetedAligner {
    #[wasm_bindgen(constructor)]
    pub fn new(reference: Vec<u8>) -> Self {
        let seed_k = 11usize;
        let mut counts: HashMap<u32, i32> = HashMap::new();
        if reference.len() >= seed_k {
            for pos in 0..=(reference.len() - seed_k) {
                if let Some(key) = encode_target_kmer(&reference, pos, seed_k) {
                    counts
                        .entry(key)
                        .and_modify(|value| *value = -1)
                        .or_insert(pos as i32);
                }
            }
        }
        Self {
            reference,
            seed_k,
            unique_kmers: counts,
            offsets: Vec::new(),
            prev_m: Vec::new(),
            prev_i: Vec::new(),
            prev_d: Vec::new(),
            curr_m: Vec::new(),
            curr_i: Vec::new(),
            curr_d: Vec::new(),
            trace: Vec::new(),
            reversed: Vec::new(),
            cigar: Vec::new(),
            result: [0.0; TARGET_RESULT_LEN],
        }
    }

    #[wasm_bindgen(js_name = resultView)]
    pub fn result_view(&self) -> Float64Array {
        unsafe { Float64Array::view(&self.result) }
    }

    #[wasm_bindgen(js_name = cigarView)]
    pub fn cigar_view(&self) -> Uint32Array {
        unsafe { Uint32Array::view(&self.cigar) }
    }

    /// Writes offset and hit count into result[9:11].
    pub fn estimate(&mut self, read: &[u8]) {
        let (offset, hits) = self.estimate_inner(read);
        self.result[9] = offset as f64;
        self.result[10] = hits as f64;
    }

    #[wasm_bindgen(js_name = alignWithEstimate)]
    pub fn align_with_estimate(&mut self, read: &[u8], offset: i32, hits: u32) -> bool {
        let mut band = 24usize;
        loop {
            if self.align_at_band(read, offset, hits, band) {
                let touched = self.result[12] == 1.0;
                let coverage = self.result[8];
                if (!touched && coverage >= 0.98) || band >= 192 {
                    return true;
                }
            } else if band >= 192 {
                return false;
            }
            if band >= 192 {
                return true;
            }
            band = (band * 2).min(192);
        }
    }

    pub fn align(&mut self, read: &[u8]) -> bool {
        let (offset, hits) = self.estimate_inner(read);
        self.align_with_estimate(read, offset, hits)
    }
}

#[cfg(feature = "targeted")]
impl TargetedAligner {
    fn estimate_inner(&mut self, read: &[u8]) -> (i32, u32) {
        self.offsets.clear();
        if read.len() >= self.seed_k && self.reference.len() >= self.seed_k {
            for pos in 0..=(read.len() - self.seed_k) {
                if let Some(key) = encode_target_kmer(read, pos, self.seed_k) {
                    if let Some(&ref_pos) = self.unique_kmers.get(&key) {
                        if ref_pos >= 0 {
                            self.offsets.push(pos as i32 - ref_pos);
                        }
                    }
                }
            }
        }
        if self.offsets.is_empty() {
            return (
                ((read.len() as i32 - self.reference.len() as i32) / 2).max(0),
                0,
            );
        }
        self.offsets.sort_unstable();
        (
            self.offsets[self.offsets.len() / 2],
            self.offsets.len() as u32,
        )
    }

    fn ensure_rows(&mut self, width: usize) {
        self.prev_m.resize(width, TARGET_NEG);
        self.prev_i.resize(width, TARGET_NEG);
        self.prev_d.resize(width, TARGET_NEG);
        self.curr_m.resize(width, TARGET_NEG);
        self.curr_i.resize(width, TARGET_NEG);
        self.curr_d.resize(width, TARGET_NEG);
    }

    fn align_at_band(&mut self, read: &[u8], offset: i32, hits: u32, band: usize) -> bool {
        let m = self.reference.len();
        if m == 0 || read.is_empty() {
            return false;
        }
        let window_start = (offset - band as i32).max(0) as usize;
        let window_end = read
            .len()
            .min((offset + m as i32 + band as i32).max(0) as usize);
        if window_end <= window_start {
            return false;
        }
        let window = &read[window_start..window_end];
        let n = window.len();
        let local_offset = offset - window_start as i32;
        let width = n + 1;
        self.ensure_rows(width);
        self.prev_m.fill(TARGET_NEG);
        self.prev_i.fill(TARGET_NEG);
        self.prev_d.fill(TARGET_NEG);
        let row0_bound = local_offset + band as i32;
        if row0_bound >= 0 {
            let row0_max = n.min(row0_bound as usize);
            for j in 0..=row0_max {
                self.prev_m[j] = 0;
            }
        }

        let trace_width = 2 * band + 1;
        self.trace
            .resize((m + 1) * trace_width * 3, TARGET_TRACE_NONE);
        self.trace.fill(TARGET_TRACE_NONE);
        for i in 1..=m {
            self.curr_m.fill(TARGET_NEG);
            self.curr_i.fill(TARGET_NEG);
            self.curr_d.fill(TARGET_NEG);
            let center = i as i32 + local_offset;
            let j_min_i32 = (center - band as i32).max(0);
            let j_max_i32 = (n as i32).min(center + band as i32);
            if j_max_i32 < j_min_i32 {
                std::mem::swap(&mut self.prev_m, &mut self.curr_m);
                std::mem::swap(&mut self.prev_i, &mut self.curr_i);
                std::mem::swap(&mut self.prev_d, &mut self.curr_d);
                continue;
            }
            let j_min = j_min_i32 as usize;
            let j_max = j_max_i32 as usize;
            let trace_row = i * trace_width * 3;
            for j in j_min..=j_max {
                if j > 0 {
                    let mut diag = self.prev_m[j - 1];
                    let mut diag_state = TARGET_M;
                    if self.prev_i[j - 1] > diag {
                        diag = self.prev_i[j - 1];
                        diag_state = TARGET_I;
                    }
                    if self.prev_d[j - 1] > diag {
                        diag = self.prev_d[j - 1];
                        diag_state = TARGET_D;
                    }
                    if diag > TARGET_NEG / 2 {
                        self.curr_m[j] = diag
                            + if self.reference[i - 1] == window[j - 1] {
                                2
                            } else {
                                -3
                            };
                        self.trace[trace_row + (j - j_min) * 3 + TARGET_M] = diag_state as u8;
                    }
                    let mut ins = self.curr_m[j - 1] - 5;
                    let mut ins_state = TARGET_M;
                    let extend = self.curr_i[j - 1] - 1;
                    if extend > ins {
                        ins = extend;
                        ins_state = TARGET_I;
                    }
                    let switch = self.curr_d[j - 1] - 5;
                    if switch > ins {
                        ins = switch;
                        ins_state = TARGET_D;
                    }
                    if ins > TARGET_NEG / 2 {
                        self.curr_i[j] = ins;
                        self.trace[trace_row + (j - j_min) * 3 + TARGET_I] = ins_state as u8;
                    }
                }
                let mut del = self.prev_m[j] - 5;
                let mut del_state = TARGET_M;
                let switch = self.prev_i[j] - 5;
                if switch > del {
                    del = switch;
                    del_state = TARGET_I;
                }
                let extend = self.prev_d[j] - 1;
                if extend > del {
                    del = extend;
                    del_state = TARGET_D;
                }
                if del > TARGET_NEG / 2 {
                    self.curr_d[j] = del;
                    self.trace[trace_row + (j - j_min) * 3 + TARGET_D] = del_state as u8;
                }
            }
            std::mem::swap(&mut self.prev_m, &mut self.curr_m);
            std::mem::swap(&mut self.prev_i, &mut self.curr_i);
            std::mem::swap(&mut self.prev_d, &mut self.curr_d);
        }

        let end_center = m as i32 + local_offset;
        let end_min_i32 = (end_center - band as i32).max(0);
        let end_max_i32 = (n as i32).min(end_center + band as i32);
        if end_max_i32 < end_min_i32 {
            return false;
        }
        let end_min = end_min_i32 as usize;
        let end_max = end_max_i32 as usize;
        let mut end_j: i32 = -1;
        let mut end_state = TARGET_M;
        let mut best = TARGET_NEG;
        for j in end_min..=end_max {
            let mut score = self.prev_m[j];
            let mut state = TARGET_M;
            if self.prev_i[j] > score {
                score = self.prev_i[j];
                state = TARGET_I;
            }
            if self.prev_d[j] > score {
                score = self.prev_d[j];
                state = TARGET_D;
            }
            if score > best {
                best = score;
                end_j = j as i32;
                end_state = state;
            }
        }
        if end_j < 0 || best <= TARGET_NEG / 2 {
            return false;
        }

        self.reversed.clear();
        let mut i = m;
        let mut j = end_j as usize;
        let mut state = end_state;
        let mut touched = false;
        while i > 0 {
            if (((j as i32 - i as i32) - local_offset).abs() as usize) >= band.saturating_sub(1) {
                touched = true;
            }
            let row_min = ((i as i32 + local_offset) - band as i32).max(0) as usize;
            if j < row_min || j - row_min >= trace_width {
                return false;
            }
            let previous = self.trace[(i * trace_width + (j - row_min)) * 3 + state];
            if previous == TARGET_TRACE_NONE {
                return false;
            }
            if state == TARGET_M {
                if j == 0 {
                    return false;
                }
                self.reversed
                    .push(if self.reference[i - 1] == window[j - 1] {
                        0
                    } else {
                        1
                    });
                i -= 1;
                j -= 1;
            } else if state == TARGET_I {
                if j == 0 {
                    return false;
                }
                self.reversed.push(2);
                j -= 1;
            } else {
                self.reversed.push(3);
                i -= 1;
            }
            state = previous as usize;
        }
        let read_start = window_start + j;
        let read_end = window_start + end_j as usize;
        self.cigar.clear();
        let mut matches = 0usize;
        let mut mismatches = 0usize;
        let mut inserted = 0usize;
        let mut deleted = 0usize;
        let mut last_code = 255u8;
        let mut length = 0u32;
        for &code in self.reversed.iter().rev() {
            if code == last_code {
                length += 1;
            } else {
                if length > 0 {
                    self.cigar.push((length << 2) | last_code as u32);
                }
                last_code = code;
                length = 1;
            }
            match code {
                0 => matches += 1,
                1 => mismatches += 1,
                2 => inserted += 1,
                _ => deleted += 1,
            }
        }
        if length > 0 {
            self.cigar.push((length << 2) | last_code as u32);
        }
        let compared = matches + mismatches + inserted + deleted;
        self.result = [
            best as f64,
            read_start as f64,
            read_end as f64,
            matches as f64,
            mismatches as f64,
            inserted as f64,
            deleted as f64,
            if compared > 0 {
                matches as f64 / compared as f64
            } else {
                0.0
            },
            (matches + mismatches) as f64 / m as f64,
            offset as f64,
            hits as f64,
            band as f64,
            if touched { 1.0 } else { 0.0 },
        ];
        true
    }
}

#[cfg(feature = "targeted")]
fn encode_target_kmer(seq: &[u8], start: usize, k: usize) -> Option<u32> {
    let mut value = 0u32;
    for i in 0..k {
        let code = match seq[start + i] {
            b'A' | b'a' => 0,
            b'C' | b'c' => 1,
            b'G' | b'g' => 2,
            b'T' | b't' => 3,
            _ => return None,
        };
        value = (value << 2) | code;
    }
    Some(value)
}

// --- Nanopore SSM: banded approximate matcher + DualAnchorScorer ---------
//
// `banded_align` mirrors banded-align.ts. Used twice per site per read to
// locate the upstream + downstream anchors with Nanopore-class error tolerance.

/// One hit result. None when no alignment within tolerance was found.
#[cfg(feature = "cdna")]
#[derive(Clone, Copy)]
struct MatchResult {
    start: usize,
    end: usize,
    score: u32,
}

/// Banded approximate string match. Mirrors TS `bandedAlign` semantics:
///   - tolerance = max_subs + max_indels (combined edit budget)
///   - alignment-length band: window in [m - max_indels, m + max_indels]
///   - returns lowest-score hit; tie-break: earlier start wins, then shorter length
#[cfg(feature = "cdna")]
fn banded_align(
    haystack: &[u8],
    needle: &[u8],
    max_subs: usize,
    max_indels: usize,
) -> Option<MatchResult> {
    let tolerance = max_subs + max_indels;
    let m = needle.len();
    if m == 0 || haystack.is_empty() {
        return None;
    }
    let min_len = if m > max_indels { m - max_indels } else { 1 };
    let min_len = min_len.max(1);
    let max_len = m + max_indels;
    let h_len = haystack.len();
    if h_len < min_len {
        return None;
    }

    let mut best: Option<MatchResult> = None;
    let max_start = h_len - min_len;
    for start in 0..=max_start {
        let mut len = min_len;
        while len <= max_len {
            let end = start + len;
            if end > h_len {
                break;
            }
            if let Some(dist) = limited_edit_distance(needle, &haystack[start..end], tolerance) {
                let is_better = match &best {
                    None => true,
                    Some(b) => {
                        dist < b.score
                            || (dist == b.score
                                && (start < b.start
                                    || (start == b.start && len < (b.end - b.start))))
                    }
                };
                if is_better {
                    best = Some(MatchResult {
                        start,
                        end,
                        score: dist,
                    });
                    if dist == 0 {
                        return best;
                    }
                }
            }
            len += 1;
        }
    }
    best
}

/// Wagner-Fischer edit distance with row rolling + early termination when the
/// row minimum exceeds `limit`. Returns None if exceeded.
#[cfg(feature = "cdna")]
fn limited_edit_distance(needle: &[u8], hay: &[u8], limit: usize) -> Option<u32> {
    let n = needle.len();
    let m = hay.len();
    if n.abs_diff(m) > limit {
        return None;
    }
    let limit32 = limit as u32;

    let mut prev: Vec<u32> = (0..=m as u32).collect();
    let mut curr: Vec<u32> = vec![0u32; m + 1];

    for i in 1..=n {
        curr[0] = i as u32;
        let mut row_min = curr[0];
        let ni = needle[i - 1];
        for j in 1..=m {
            let cost = if ni == hay[j - 1] { 0 } else { 1 };
            let diag = prev[j - 1].saturating_add(cost);
            let up = prev[j].saturating_add(1);
            let left = curr[j - 1].saturating_add(1);
            let v = diag.min(up).min(left);
            curr[j] = v;
            if v < row_min {
                row_min = v;
            }
        }
        if row_min > limit32 {
            return None;
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    let final_dist = prev[m];
    if final_dist <= limit32 {
        Some(final_dist)
    } else {
        None
    }
}

/// Exported flat-API wrapper for the TS test suite to verify Rust↔TS parity.
/// Returns a 4-element Float64Array: [found ? 1 : 0, start, end, score].
/// found==0 sets start/end/score to -1.
#[cfg(feature = "cdna")]
#[wasm_bindgen(js_name = bandedAlign)]
pub fn banded_align_wasm(
    haystack: &[u8],
    needle: &[u8],
    max_subs: usize,
    max_indels: usize,
) -> Vec<f64> {
    match banded_align(haystack, needle, max_subs, max_indels) {
        Some(m) => vec![1.0, m.start as f64, m.end as f64, m.score as f64],
        None => vec![0.0, -1.0, -1.0, -1.0],
    }
}

#[cfg(feature = "cdna")]
struct SiteData {
    fw_anchor: Vec<u8>,
    rv_anchor: Vec<u8>,
}

/// Per-site dual-anchor scorer. Each call to `score(seq)` writes 5 fields
/// per configured site into the internal result buffer:
///
///   [base + 0] = found ? 1 : 0   (both anchors located)
///   [base + 1] = fw_start        (-1 if not found)
///   [base + 2] = fw_end
///   [base + 3] = rv_start
///   [base + 4] = rv_end
///
/// where `base = 5 * site_index`. The downstream anchor is searched only
/// from `fw_end` onward, so it is guaranteed to sit after the upstream anchor.
#[cfg(feature = "cdna")]
#[wasm_bindgen]
pub struct DualAnchorScorer {
    sites: Vec<SiteData>,
    max_subs: usize,
    max_indels: usize,
    result: Vec<f64>,
}

#[cfg(feature = "cdna")]
#[wasm_bindgen]
impl DualAnchorScorer {
    #[wasm_bindgen(constructor)]
    pub fn new(max_subs: usize, max_indels: usize) -> Self {
        Self {
            sites: Vec::new(),
            max_subs,
            max_indels,
            result: Vec::new(),
        }
    }

    /// Register one site. Order matters — site index is the row index in the
    /// per-call result buffer. Returns the new site index.
    #[wasm_bindgen(js_name = addSite)]
    pub fn add_site(&mut self, fw_anchor: Vec<u8>, rv_anchor: Vec<u8>) -> usize {
        let idx = self.sites.len();
        self.sites.push(SiteData {
            fw_anchor,
            rv_anchor,
        });
        for _ in 0..5 {
            self.result.push(0.0);
        }
        idx
    }

    /// Returns a Float64Array view onto the internal result buffer. Length is
    /// `5 * site_count`. See struct doc for layout.
    #[wasm_bindgen(js_name = resultView)]
    pub fn result_view(&self) -> Float64Array {
        unsafe { Float64Array::view(&self.result) }
    }

    /// Score one read against every configured site. Writes results in-place
    /// into the buffer aliased by `resultView()`.
    pub fn score(&mut self, seq: &[u8]) {
        for (i, site) in self.sites.iter().enumerate() {
            let base = 5 * i;
            let fw = banded_align(seq, &site.fw_anchor, self.max_subs, self.max_indels);
            let pair = if let Some(fwm) = fw {
                if fwm.end >= seq.len() {
                    None
                } else {
                    let tail = &seq[fwm.end..];
                    banded_align(tail, &site.rv_anchor, self.max_subs, self.max_indels).map(|rvm| {
                        (
                            fwm,
                            MatchResult {
                                start: rvm.start + fwm.end,
                                end: rvm.end + fwm.end,
                                score: rvm.score,
                            },
                        )
                    })
                }
            } else {
                None
            };

            match pair {
                Some((fwm, rvm)) => {
                    self.result[base] = 1.0;
                    self.result[base + 1] = fwm.start as f64;
                    self.result[base + 2] = fwm.end as f64;
                    self.result[base + 3] = rvm.start as f64;
                    self.result[base + 4] = rvm.end as f64;
                }
                None => {
                    self.result[base] = 0.0;
                    self.result[base + 1] = -1.0;
                    self.result[base + 2] = -1.0;
                    self.result[base + 3] = -1.0;
                    self.result[base + 4] = -1.0;
                }
            }
        }
    }
}

// --- cDNA-DISPLAY: existing substring search (unchanged) -----------------

// Naive multi-byte substring search. Anchors are ~10 bp, reads ~150 bp, so
// the naive O(n*m) cost is ~1500 byte ops per call — well under what a
// fancier algorithm (Boyer-Moore / two-way) would add in setup overhead.
#[cfg(feature = "cdna")]
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
