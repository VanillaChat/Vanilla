//! VLL: Vanilla Lossless Low-latency codec.
//!
//! Every frame is self-contained (no state carried between frames), so a lost
//! packet never corrupts the next one. Structure follows FLAC (fixed/LPC
//! predictors + partitioned Rice residuals + inter-channel decorrelation) but
//! is tuned for 2.5-20 ms frames: tiny headers, no lookahead, no seek tables.
//!
//! Frame layout:
//!   byte 0   : version(4) | depth24(1) | chmode(3)
//!   bytes 1-2: samples per channel, u16 LE
//!   then     : one bit-packed subframe per channel

use crate::bits::{BitReader, BitWriter};
use std::fmt;

const VERSION: u8 = 1;
const MAX_FRAME_SAMPLES: usize = 16_384;
const MAX_FIXED_ORDER: usize = 4;
const MAX_LPC_ORDER: usize = 12;
const LPC_PRECISION: u32 = 12;
const MAX_RICE_K: u32 = 30;
const MAX_PARTITION_ORDER: u32 = 6;

const SUB_CONST: u64 = 0;
const SUB_VERBATIM: u64 = 1;
const SUB_FIXED: u64 = 2;
const SUB_LPC: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecError {
    Truncated,
    BadHeader,
    BadParams,
    FrameTooLarge,
    BadInput,
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            CodecError::Truncated => "truncated frame",
            CodecError::BadHeader => "bad frame header",
            CodecError::BadParams => "invalid subframe parameters",
            CodecError::FrameTooLarge => "frame too large",
            CodecError::BadInput => "invalid encoder input",
        };
        f.write_str(s)
    }
}

impl std::error::Error for CodecError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameInfo {
    pub channels: u8,
    pub bit_depth: u8,
    pub frames: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ChMode {
    Mono = 0,
    LeftRight = 1,
    LeftSide = 2,
    RightSide = 3,
    MidSide = 4,
}

impl ChMode {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Mono,
            1 => Self::LeftRight,
            2 => Self::LeftSide,
            3 => Self::RightSide,
            4 => Self::MidSide,
            _ => return None,
        })
    }
}

pub fn f32_to_pcm(input: &[f32], bit_depth: u8, out: &mut Vec<i32>) {
    let scale = (1i64 << (bit_depth - 1)) as f32;
    let max = (1i64 << (bit_depth - 1)) - 1;
    let min = -(1i64 << (bit_depth - 1));
    out.clear();
    out.extend(input.iter().map(|&x| {
        let x = if x.is_finite() { x } else { 0.0 };
        ((x * scale).round() as i64).clamp(min, max) as i32
    }));
}

pub fn pcm_to_f32(input: &[i32], bit_depth: u8, out: &mut Vec<f32>) {
    let scale = 1.0 / (1i64 << (bit_depth - 1)) as f32;
    out.clear();
    out.extend(input.iter().map(|&x| x as f32 * scale));
}

struct Plan {
    bits: u64,
    kind: PlanKind,
}

enum PlanKind {
    Constant(i64),
    Verbatim,
    Fixed {
        order: usize,
        residual: Vec<i64>,
    },
    Lpc {
        order: usize,
        shift: u32,
        coeffs: Vec<i64>,
        residual: Vec<i64>,
    },
}

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn unzigzag(u: u64) -> i64 {
    ((u >> 1) as i64) ^ -((u & 1) as i64)
}

fn partition_cost(res: &[i64]) -> (u32, u64) {
    if res.is_empty() {
        return (0, 5);
    }
    let sum: u64 = res.iter().map(|&r| zigzag(r)).sum();
    let mean = sum / res.len() as u64;
    let guess = if mean == 0 {
        0
    } else {
        63 - mean.leading_zeros()
    };
    let mut best = (0u32, u64::MAX);
    let lo = guess.saturating_sub(1);
    let hi = (guess + 1).min(MAX_RICE_K);
    for k in lo..=hi {
        let bits: u64 = res
            .iter()
            .map(|&r| (zigzag(r) >> k) + 1 + k as u64)
            .sum::<u64>()
            + 5;
        if bits < best.1 {
            best = (k, bits);
        }
    }
    best
}

fn residual_cost(res: &[i64], n: usize, order: usize) -> (u32, u64) {
    let mut best = (0u32, u64::MAX);
    for p in 0..=MAX_PARTITION_ORDER {
        if n % (1usize << p) != 0 {
            break;
        }
        let part = n >> p;
        if part <= order {
            break;
        }
        let mut total = 4u64;
        let mut start = 0usize;
        for i in 0..(1usize << p) {
            let len = if i == 0 { part - order } else { part };
            total += partition_cost(&res[start..start + len]).1;
            start += len;
        }
        if total < best.1 {
            best = (p, total);
        }
    }
    best
}

fn write_residual(w: &mut BitWriter, res: &[i64], n: usize, order: usize) {
    let (p, _) = residual_cost(res, n, order);
    w.write(p as u64, 4);
    let part = n >> p;
    let mut start = 0usize;
    for i in 0..(1usize << p) {
        let len = if i == 0 { part - order } else { part };
        let slice = &res[start..start + len];
        let (k, _) = partition_cost(slice);
        w.write(k as u64, 5);
        for &r in slice {
            let u = zigzag(r);
            w.write_unary(u >> k);
            if k > 0 {
                w.write(u & ((1u64 << k) - 1), k);
            }
        }
        start += len;
    }
}

fn fixed_residual(s: &[i32], order: usize) -> Vec<i64> {
    let mut out = Vec::with_capacity(s.len() - order);
    for i in order..s.len() {
        let x = |d: usize| s[i - d] as i64;
        let pred = match order {
            0 => 0,
            1 => x(1),
            2 => 2 * x(1) - x(2),
            3 => 3 * x(1) - 3 * x(2) + x(3),
            _ => 4 * x(1) - 6 * x(2) + 4 * x(3) - x(4),
        };
        out.push(s[i] as i64 - pred);
    }
    out
}

fn lpc_predict(s: &[i32], i: usize, coeffs: &[i64], shift: u32) -> i64 {
    let mut acc = 0i64;
    for (j, &c) in coeffs.iter().enumerate() {
        acc = acc.wrapping_add(c.wrapping_mul(s[i - 1 - j] as i64));
    }
    acc >> shift
}

fn lpc_coefficients(s: &[i32], max_order: usize) -> Vec<Vec<f64>> {
    let n = s.len();
    let mut w = vec![0.0f64; n];
    let edge = (n as f64 * 0.25) as usize;
    for i in 0..n {
        let g = if edge == 0 {
            1.0
        } else if i < edge {
            0.5 - 0.5 * (std::f64::consts::PI * i as f64 / edge as f64).cos()
        } else if i >= n - edge {
            0.5 - 0.5 * (std::f64::consts::PI * (n - 1 - i) as f64 / edge as f64).cos()
        } else {
            1.0
        };
        w[i] = s[i] as f64 * g;
    }

    let mut r = vec![0.0f64; max_order + 1];
    for lag in 0..=max_order {
        let mut acc = 0.0;
        for i in lag..n {
            acc += w[i] * w[i - lag];
        }
        r[lag] = acc;
    }
    if r[0] <= 0.0 {
        return Vec::new();
    }
    r[0] *= 1.0 + 1e-9;

    let mut sets = Vec::with_capacity(max_order);
    let mut a = vec![0.0f64; max_order + 1];
    let mut err = r[0];
    for m in 1..=max_order {
        let mut acc = r[m];
        for j in 1..m {
            acc -= a[j] * r[m - j];
        }
        let k = acc / err;
        let prev = a.clone();
        a[m] = k;
        for j in 1..m {
            a[j] = prev[j] - k * prev[m - j];
        }
        err *= 1.0 - k * k;
        if err <= 0.0 {
            break;
        }
        sets.push(a[1..=m].to_vec());
    }
    sets
}

fn quantize_lpc(coeffs: &[f64]) -> Option<(Vec<i64>, u32)> {
    let cmax = coeffs.iter().fold(0.0f64, |m, c| m.max(c.abs()));
    if cmax <= 0.0 || !cmax.is_finite() {
        return None;
    }
    let log2 = cmax.log2().floor() as i32;
    let shift = (LPC_PRECISION as i32 - 2 - log2).clamp(0, 15) as u32;
    let lim = (1i64 << (LPC_PRECISION - 1)) - 1;
    let scale = (1u64 << shift) as f64;
    let mut err = 0.0;
    let mut out = Vec::with_capacity(coeffs.len());
    for &c in coeffs {
        let x = c * scale + err;
        let q = (x.round() as i64).clamp(-lim - 1, lim);
        err = x - q as f64;
        out.push(q);
    }
    Some((out, shift))
}

fn plan_subframe(s: &[i32], bps: u32) -> Plan {
    let n = s.len();

    if s.iter().all(|&v| v == s[0]) {
        return Plan {
            bits: 3 + bps as u64,
            kind: PlanKind::Constant(s[0] as i64),
        };
    }

    let mut best = Plan {
        bits: 3 + n as u64 * bps as u64,
        kind: PlanKind::Verbatim,
    };

    for order in 0..=MAX_FIXED_ORDER.min(n.saturating_sub(1)) {
        let residual = fixed_residual(s, order);
        let (_, rbits) = residual_cost(&residual, n, order);
        if rbits == u64::MAX {
            continue;
        }
        let bits = 3 + 3 + order as u64 * bps as u64 + rbits;
        if bits < best.bits {
            best = Plan {
                bits,
                kind: PlanKind::Fixed { order, residual },
            };
        }
    }

    if n >= 48 {
        let max_order = MAX_LPC_ORDER.min(n / 4);
        let sets = lpc_coefficients(s, max_order);
        for &order in &[4usize, 8, 12] {
            if order > sets.len() {
                continue;
            }
            let Some((q, shift)) = quantize_lpc(&sets[order - 1]) else {
                continue;
            };
            let mut residual = Vec::with_capacity(n - order);
            for i in order..n {
                residual.push(s[i] as i64 - lpc_predict(s, i, &q, shift));
            }
            let (_, rbits) = residual_cost(&residual, n, order);
            if rbits == u64::MAX {
                continue;
            }
            let bits = 3
                + 4
                + 4
                + 4
                + order as u64 * LPC_PRECISION as u64
                + order as u64 * bps as u64
                + rbits;
            if bits < best.bits {
                best = Plan {
                    bits,
                    kind: PlanKind::Lpc {
                        order,
                        shift,
                        coeffs: q,
                        residual,
                    },
                };
            }
        }
    }

    best
}

fn write_subframe(w: &mut BitWriter, s: &[i32], bps: u32, plan: &Plan) {
    let n = s.len();
    match &plan.kind {
        PlanKind::Constant(v) => {
            w.write(SUB_CONST, 3);
            w.write_signed(*v, bps);
        }
        PlanKind::Verbatim => {
            w.write(SUB_VERBATIM, 3);
            for &v in s {
                w.write_signed(v as i64, bps);
            }
        }
        PlanKind::Fixed { order, residual } => {
            w.write(SUB_FIXED, 3);
            w.write(*order as u64, 3);
            for &v in &s[..*order] {
                w.write_signed(v as i64, bps);
            }
            write_residual(w, residual, n, *order);
        }
        PlanKind::Lpc {
            order,
            shift,
            coeffs,
            residual,
        } => {
            w.write(SUB_LPC, 3);
            w.write((*order - 1) as u64, 4);
            w.write((LPC_PRECISION - 1) as u64, 4);
            w.write(*shift as u64, 4);
            for &c in coeffs {
                w.write_signed(c, LPC_PRECISION);
            }
            for &v in &s[..*order] {
                w.write_signed(v as i64, bps);
            }
            write_residual(w, residual, n, *order);
        }
    }
}

pub fn encode(samples: &[i32], channels: u8, bit_depth: u8) -> Result<Vec<u8>, CodecError> {
    if !(channels == 1 || channels == 2) || !(bit_depth == 16 || bit_depth == 24) {
        return Err(CodecError::BadInput);
    }
    let ch = channels as usize;
    if samples.is_empty() || samples.len() % ch != 0 {
        return Err(CodecError::BadInput);
    }
    let n = samples.len() / ch;
    if n > MAX_FRAME_SAMPLES {
        return Err(CodecError::FrameTooLarge);
    }
    let bps = bit_depth as u32;
    let limit = 1i64 << (bit_depth - 1);
    if samples
        .iter()
        .any(|&v| (v as i64) < -limit || (v as i64) >= limit)
    {
        return Err(CodecError::BadInput);
    }

    let (mode, subs): (ChMode, Vec<(Vec<i32>, u32, Plan)>) = if ch == 1 {
        let plan = plan_subframe(samples, bps);
        (ChMode::Mono, vec![(samples.to_vec(), bps, plan)])
    } else {
        let l: Vec<i32> = samples.iter().step_by(2).copied().collect();
        let r: Vec<i32> = samples.iter().skip(1).step_by(2).copied().collect();
        let side: Vec<i32> = l.iter().zip(&r).map(|(&a, &b)| a - b).collect();
        let mid: Vec<i32> = l.iter().zip(&r).map(|(&a, &b)| (a + b) >> 1).collect();

        let pl = plan_subframe(&l, bps);
        let pr = plan_subframe(&r, bps);
        let ps = plan_subframe(&side, bps + 1);
        let pm = plan_subframe(&mid, bps);

        let options = [
            (ChMode::LeftRight, pl.bits + pr.bits),
            (ChMode::LeftSide, pl.bits + ps.bits),
            (ChMode::RightSide, ps.bits + pr.bits),
            (ChMode::MidSide, pm.bits + ps.bits),
        ];
        let mode = options.iter().min_by_key(|o| o.1).unwrap().0;
        let subs = match mode {
            ChMode::LeftRight => vec![(l, bps, pl), (r, bps, pr)],
            ChMode::LeftSide => vec![(l, bps, pl), (side, bps + 1, ps)],
            ChMode::RightSide => vec![(side, bps + 1, ps), (r, bps, pr)],
            ChMode::MidSide => vec![(mid, bps, pm), (side, bps + 1, ps)],
            ChMode::Mono => unreachable!(),
        };
        (mode, subs)
    };

    let mut w = BitWriter::with_capacity(n * ch * 2 + 8);
    w.write(
        ((VERSION << 4) | ((bit_depth == 24) as u8) << 3 | mode as u8) as u64,
        8,
    );
    w.write((n & 0xff) as u64, 8);
    w.write((n >> 8) as u64, 8);
    for (s, b, plan) in &subs {
        write_subframe(&mut w, s, *b, plan);
    }
    Ok(w.finish())
}

fn read_residual(
    r: &mut BitReader,
    out: &mut [i64],
    n: usize,
    order: usize,
) -> Result<(), CodecError> {
    let p = r.read(4)? as u32;
    if p > MAX_PARTITION_ORDER || n % (1usize << p) != 0 {
        return Err(CodecError::BadParams);
    }
    let part = n >> p;
    if part <= order {
        return Err(CodecError::BadParams);
    }
    let mut idx = order;
    for i in 0..(1usize << p) {
        let len = if i == 0 { part - order } else { part };
        let k = r.read(5)? as u32;
        if k > MAX_RICE_K {
            return Err(CodecError::BadParams);
        }
        for _ in 0..len {
            let q = r.read_unary()?;
            if q > (1u64 << 40) {
                return Err(CodecError::BadParams);
            }
            let low = if k > 0 { r.read(k)? } else { 0 };
            out[idx] = unzigzag((q << k) | low);
            idx += 1;
        }
    }
    Ok(())
}

fn read_subframe(r: &mut BitReader, out: &mut [i32], bps: u32) -> Result<(), CodecError> {
    let n = out.len();
    let kind = r.read(3)?;
    match kind {
        SUB_CONST => {
            let v = r.read_signed(bps)? as i32;
            out.fill(v);
        }
        SUB_VERBATIM => {
            for o in out.iter_mut() {
                *o = r.read_signed(bps)? as i32;
            }
        }
        SUB_FIXED => {
            let order = r.read(3)? as usize;
            if order > MAX_FIXED_ORDER || order >= n {
                return Err(CodecError::BadParams);
            }
            for o in out[..order].iter_mut() {
                *o = r.read_signed(bps)? as i32;
            }
            let mut res = vec![0i64; n];
            read_residual(r, &mut res, n, order)?;
            for i in order..n {
                let x = |d: usize| out[i - d] as i64;
                let pred = match order {
                    0 => 0,
                    1 => x(1),
                    2 => 2 * x(1) - x(2),
                    3 => 3 * x(1) - 3 * x(2) + x(3),
                    _ => 4 * x(1) - 6 * x(2) + 4 * x(3) - x(4),
                };
                out[i] = pred.wrapping_add(res[i]) as i32;
            }
        }
        SUB_LPC => {
            let order = r.read(4)? as usize + 1;
            let precision = r.read(4)? as u32 + 1;
            let shift = r.read(4)? as u32;
            if order > MAX_LPC_ORDER || order >= n {
                return Err(CodecError::BadParams);
            }
            let mut coeffs = Vec::with_capacity(order);
            for _ in 0..order {
                coeffs.push(r.read_signed(precision)?);
            }
            for o in out[..order].iter_mut() {
                *o = r.read_signed(bps)? as i32;
            }
            let mut res = vec![0i64; n];
            read_residual(r, &mut res, n, order)?;
            for i in order..n {
                let pred = lpc_predict(out, i, &coeffs, shift);
                out[i] = pred.wrapping_add(res[i]) as i32;
            }
        }
        _ => return Err(CodecError::BadParams),
    }
    Ok(())
}

pub fn decode(data: &[u8], out: &mut Vec<i32>) -> Result<FrameInfo, CodecError> {
    if data.len() < 3 {
        return Err(CodecError::Truncated);
    }
    if data[0] >> 4 != VERSION {
        return Err(CodecError::BadHeader);
    }
    let bit_depth = if data[0] & 0x08 != 0 { 24u8 } else { 16u8 };
    let mode = ChMode::from_u8(data[0] & 0x07).ok_or(CodecError::BadHeader)?;
    let n = data[1] as usize | (data[2] as usize) << 8;
    if n == 0 {
        return Err(CodecError::BadHeader);
    }
    if n > MAX_FRAME_SAMPLES {
        return Err(CodecError::FrameTooLarge);
    }
    let bps = bit_depth as u32;
    let mut r = BitReader::new(&data[3..]);

    let channels;
    out.clear();
    if mode == ChMode::Mono {
        channels = 1u8;
        out.resize(n, 0);
        read_subframe(&mut r, out, bps)?;
    } else {
        channels = 2u8;
        let mut a = vec![0i32; n];
        let mut b = vec![0i32; n];
        match mode {
            ChMode::LeftRight => {
                read_subframe(&mut r, &mut a, bps)?;
                read_subframe(&mut r, &mut b, bps)?;
            }
            ChMode::LeftSide => {
                read_subframe(&mut r, &mut a, bps)?;
                read_subframe(&mut r, &mut b, bps + 1)?;
                for i in 0..n {
                    b[i] = a[i].wrapping_sub(b[i]);
                }
            }
            ChMode::RightSide => {
                read_subframe(&mut r, &mut a, bps + 1)?;
                read_subframe(&mut r, &mut b, bps)?;
                for i in 0..n {
                    a[i] = b[i].wrapping_add(a[i]);
                }
            }
            ChMode::MidSide => {
                read_subframe(&mut r, &mut a, bps)?;
                read_subframe(&mut r, &mut b, bps + 1)?;
                for i in 0..n {
                    let side = b[i];
                    let mid = (a[i].wrapping_shl(1)) | (side & 1);
                    a[i] = mid.wrapping_add(side) >> 1;
                    b[i] = mid.wrapping_sub(side) >> 1;
                }
            }
            ChMode::Mono => unreachable!(),
        }
        out.reserve(n * 2);
        for i in 0..n {
            out.push(a[i]);
            out.push(b[i]);
        }
    }

    // Corrupt streams can decode to out-of-range values; keep output sane.
    let limit = 1i32 << (bit_depth - 1);
    for v in out.iter_mut() {
        *v = (*v).clamp(-limit, limit - 1);
    }

    Ok(FrameInfo {
        channels,
        bit_depth,
        frames: n,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn range(&mut self, lo: i64, hi: i64) -> i64 {
            lo + (self.next() % (hi - lo + 1) as u64) as i64
        }
    }

    fn roundtrip(samples: &[i32], ch: u8, depth: u8) -> usize {
        let enc = encode(samples, ch, depth).expect("encode");
        let mut dec = Vec::new();
        let info = decode(&enc, &mut dec).expect("decode");
        assert_eq!(info.channels, ch);
        assert_eq!(info.bit_depth, depth);
        assert_eq!(info.frames, samples.len() / ch as usize);
        assert_eq!(dec, samples, "roundtrip mismatch");
        enc.len()
    }

    fn voice_like(rng: &mut Rng, n: usize, depth: u8, noise_bits: u32) -> Vec<i32> {
        let amp = (1i64 << (depth - 1)) as f64 * 0.3;
        let noise = 1i64 << noise_bits;
        (0..n)
            .map(|i| {
                let t = i as f64 / 48_000.0;
                let v = amp
                    * (0.6 * (2.0 * std::f64::consts::PI * 180.0 * t).sin()
                        + 0.3 * (2.0 * std::f64::consts::PI * 1_200.0 * t).sin()
                        + 0.1 * (2.0 * std::f64::consts::PI * 3_100.0 * t).sin());
                v as i32 + rng.range(-noise, noise) as i32
            })
            .collect()
    }

    #[test]
    fn mono_sizes_and_depths() {
        let mut rng = Rng(0x1234_5678_9abc_def1);
        for &n in &[1usize, 2, 5, 47, 48, 120, 240, 480, 960, 1000, 4096] {
            for &depth in &[16u8, 24] {
                let s = voice_like(&mut rng, n, depth, 6);
                roundtrip(&s, 1, depth);
            }
        }
    }

    #[test]
    fn stereo_modes_roundtrip() {
        let mut rng = Rng(42);
        for &n in &[1usize, 3, 240, 480, 960] {
            for &depth in &[16u8, 24] {
                let base = voice_like(&mut rng, n, depth, 5);
                let other = voice_like(&mut rng, n, depth, 5);
                let cases: Vec<Vec<i32>> = vec![
                    base.iter().flat_map(|&v| [v, v]).collect(),
                    base.iter().flat_map(|&v| [v, -v]).collect(),
                    base.iter()
                        .zip(&other)
                        .flat_map(|(&a, &b)| [a, b])
                        .collect(),
                    base.iter().flat_map(|&v| [v, v / 2]).collect(),
                ];
                for c in cases {
                    roundtrip(&c, 2, depth);
                }
            }
        }
    }

    #[test]
    fn extremes() {
        for &depth in &[16u8, 24] {
            let max = (1i32 << (depth - 1)) - 1;
            let min = -(1i32 << (depth - 1));
            let square: Vec<i32> = (0..240)
                .map(|i| if i % 2 == 0 { max } else { min })
                .collect();
            roundtrip(&square, 1, depth);
            let stereo: Vec<i32> = (0..480)
                .map(|i| if (i / 2) % 2 == 0 { max } else { min })
                .collect();
            roundtrip(&stereo, 2, depth);
            roundtrip(&vec![min; 240], 1, depth);
            roundtrip(&vec![0; 240], 1, depth);
            let mut rng = Rng(7);
            let noise: Vec<i32> = (0..240)
                .map(|_| rng.range(min as i64, max as i64) as i32)
                .collect();
            roundtrip(&noise, 1, depth);
            let noise2: Vec<i32> = (0..480)
                .map(|_| rng.range(min as i64, max as i64) as i32)
                .collect();
            roundtrip(&noise2, 2, depth);
        }
    }

    #[test]
    fn compresses_and_never_exceeds_raw_much() {
        let mut rng = Rng(99);
        let s = voice_like(&mut rng, 240, 16, 6);
        let size = roundtrip(&s, 1, 16);
        let raw = 240 * 2;
        assert!(
            size < raw * 3 / 4,
            "expected real compression, got {size}/{raw}"
        );

        let noise: Vec<i32> = (0..240).map(|_| rng.range(-32768, 32767) as i32).collect();
        let size = roundtrip(&noise, 1, 16);
        assert!(size <= raw + 8, "worst case must stay near raw, got {size}");

        let silence = vec![0i32; 240];
        assert!(roundtrip(&silence, 1, 16) <= 8);
    }

    #[test]
    fn malformed_input_never_panics() {
        let mut rng = Rng(0xdead_beef);
        let mut out = Vec::new();
        for len in 0..64 {
            for _ in 0..200 {
                let mut buf: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
                if !buf.is_empty() {
                    buf[0] = (VERSION << 4) | (buf[0] & 0x0f);
                }
                let _ = decode(&buf, &mut out);
            }
        }
        let s = voice_like(&mut rng, 240, 16, 6);
        let good = encode(&s, 1, 16).unwrap();
        for _ in 0..2000 {
            let mut bad = good.clone();
            let i = (rng.next() as usize) % bad.len();
            bad[i] ^= 1 << (rng.next() % 8);
            let _ = decode(&bad, &mut out);
            let cut = (rng.next() as usize) % bad.len();
            let _ = decode(&bad[..cut], &mut out);
        }
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(encode(&[], 1, 16), Err(CodecError::BadInput));
        assert_eq!(encode(&[0; 3], 2, 16), Err(CodecError::BadInput));
        assert_eq!(encode(&[0; 4], 3, 16), Err(CodecError::BadInput));
        assert_eq!(encode(&[0; 4], 1, 12), Err(CodecError::BadInput));
        assert_eq!(encode(&[40_000], 1, 16), Err(CodecError::BadInput));
    }

    #[test]
    fn float_conversion_is_exact_for_24_bit() {
        let mut ints = Vec::new();
        let floats: Vec<f32> = (-4..4).map(|i| i as f32 / 8.0).collect();
        f32_to_pcm(&floats, 24, &mut ints);
        let mut back = Vec::new();
        pcm_to_f32(&ints, 24, &mut back);
        assert_eq!(floats, back);
    }
}
