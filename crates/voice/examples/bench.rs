use std::time::Instant;
use vanilla_voice::codec::{decode, encode};

fn main() {
    let mut seed = 0x9e3779b97f4a7c15u64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for &(n, depth, ch, noise) in &[
        (240usize, 16u8, 1u8, 6i64),
        (240, 16, 1, 30),
        (240, 24, 1, 200),
        (480, 16, 2, 30),
        (480, 24, 2, 200),
        (960, 16, 1, 30),
    ] {
        let frames = 2000;
        let mut total = 0usize;
        let mut enc_t = 0.0;
        let mut dec_t = 0.0;
        let mut out = Vec::new();
        for f in 0..frames {
            let amp = (1i64 << (depth - 1)) as f64 * 0.3;
            let mut s = Vec::with_capacity(n * ch as usize);
            for i in 0..n {
                let t = (f * n + i) as f64 / 48_000.0;
                let v = amp
                    * (0.6 * (2.0 * std::f64::consts::PI * 180.0 * t).sin()
                        + 0.3 * (2.0 * std::f64::consts::PI * 1200.0 * t).sin());
                for _ in 0..ch {
                    s.push(v as i32 + (rnd() % (2 * noise as u64 + 1)) as i32 - noise as i32);
                }
            }
            let t0 = Instant::now();
            let e = encode(&s, ch, depth).unwrap();
            enc_t += t0.elapsed().as_secs_f64();
            let t1 = Instant::now();
            decode(&e, &mut out).unwrap();
            dec_t += t1.elapsed().as_secs_f64();
            assert_eq!(out, s);
            total += e.len();
        }
        let raw = frames * n * ch as usize * (depth as usize / 8);
        let ms = n as f64 / 48.0;
        let kbps = total as f64 * 8.0 / (frames as f64 * ms / 1000.0) / 1000.0;
        println!(
            "{ms:>5.1} ms {depth}b {ch}ch noise±{noise:<4} ratio {:.2}  {kbps:>6.0} kbps  enc {:.1} µs  dec {:.1} µs",
            total as f64 / raw as f64,
            enc_t / frames as f64 * 1e6,
            dec_t / frames as f64 * 1e6
        );
    }
}
