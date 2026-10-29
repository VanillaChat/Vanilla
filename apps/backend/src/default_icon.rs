//! The picture a server without an icon gets, drawn the same way as the client's default
//! avatar: the Vanilla mark in a light tone on a deep colour picked from the id.
//!
//! Link crawlers only take raster images, so the share page cannot point at the client's SVG.

use tiny_skia::{Color, FillRule, Paint, Path, PathBuilder, Pixmap, Rect, Transform};

const PALETTE: [u32; 10] = [
    0xf7e26c, 0xa8c8ff, 0xffb3a8, 0xc4f0a8, 0xe8a8ff, 0xffd9a8, 0xa8e8e0, 0xd4b8ff, 0xffc4d4,
    0xb8d4a8,
];

const MARK_LEFT: &str = "M206.73 386.677C220.279 386.131 234.211 386.475 247.841 386.358C275.29 386.245 307.522 383.182 324.811 409.637C334.749 424.842 343.429 441.595 352.401 457.507L377.493 502.033C409.242 558.462 406.181 550.35 374.976 604.878C363.3 628.169 347.068 637.77 331.123 611.215C321.816 595.715 313.091 579.591 304.195 563.823L257.663 481.096C251.502 470.032 205.943 391.667 205.585 387.812L206.73 386.677Z";
const MARK_RIGHT: &str = "M424.339 386.608C432.776 385.969 446.405 386.298 455.124 386.311C468.311 386.33 484.632 385.632 497.423 387.646C494.63 395.619 482.246 416.206 477.527 424.53L436.636 497.032C432.816 504.085 429.828 509.582 424.521 515.657C418.552 508.887 390.363 458.963 386.149 449.35C384.197 444.969 382.863 440.339 382.185 435.591C380.647 424.704 383.598 413.659 390.359 404.99C398.939 393.817 410.643 388.492 424.339 386.608Z";

fn color_for_id(id: &str) -> [f32; 3] {
    let mut h: i32 = 0;
    for unit in id.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(i32::from(unit));
    }
    let rgb = PALETTE[h.unsigned_abs() as usize % PALETTE.len()];
    [
        ((rgb >> 16) & 0xff) as f32 / 255.0,
        ((rgb >> 8) & 0xff) as f32 / 255.0,
        (rgb & 0xff) as f32 / 255.0,
    ]
}

fn hsv([r, g, b]: [f32; 3], saturation: f32, value: f32) -> [f32; 3] {
    let max = r.max(g).max(b);
    let d = max - r.min(g).min(b);
    let mut h = if d == 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d) % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    if h < 0.0 {
        h += 6.0;
    }
    let h = h / 6.0;
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let p = value * (1.0 - saturation);
    let q = value * (1.0 - f * saturation);
    let t = value * (1.0 - (1.0 - f) * saturation);
    match i as i32 % 6 {
        0 => [value, t, p],
        1 => [q, value, p],
        2 => [p, value, t],
        3 => [p, q, value],
        4 => [t, p, value],
        _ => [value, p, q],
    }
}

fn lighten([r, g, b]: [f32; 3], amount: f32) -> [f32; 3] {
    [
        r + (1.0 - r) * amount,
        g + (1.0 - g) * amount,
        b + (1.0 - b) * amount,
    ]
}

fn paint([r, g, b]: [f32; 3]) -> Paint<'static> {
    let mut paint = Paint::default();
    paint.set_color(Color::from_rgba(r, g, b, 1.0).unwrap_or(Color::BLACK));
    paint.anti_alias = true;
    paint
}

/// Parses the absolute `M`, `L`, `C` and `Z` commands the mark is drawn with.
fn parse_path(d: &str) -> Option<Path> {
    let mut pb = PathBuilder::new();
    let mut tokens = d
        .split(|c: char| c == ' ' || c == ',')
        .flat_map(|chunk| {
            let mut out = Vec::new();
            let mut start = 0;
            for (i, c) in chunk.char_indices() {
                if c.is_ascii_alphabetic() {
                    if i > start {
                        out.push(&chunk[start..i]);
                    }
                    out.push(&chunk[i..=i]);
                    start = i + 1;
                }
            }
            if start < chunk.len() {
                out.push(&chunk[start..]);
            }
            out
        })
        .collect::<Vec<_>>()
        .into_iter();
    while let Some(cmd) = tokens.next() {
        let mut next = || tokens.next().and_then(|t| t.parse::<f32>().ok());
        match cmd {
            "M" => pb.move_to(next()?, next()?),
            "L" => pb.line_to(next()?, next()?),
            "C" => {
                let (x1, y1, x2, y2, x, y) = (next()?, next()?, next()?, next()?, next()?, next()?);
                pb.cubic_to(x1, y1, x2, y2, x, y);
            }
            "Z" => pb.close(),
            _ => return None,
        }
    }
    pb.finish()
}

/// A square PNG of the default picture for `id`.
pub fn png(id: &str, size: u32) -> Option<Vec<u8>> {
    let mut pixmap = Pixmap::new(size, size)?;
    let base = color_for_id(id);
    let k = size as f32 / 100.0;

    pixmap.fill_rect(
        Rect::from_xywh(0.0, 0.0, size as f32, size as f32)?,
        &paint(hsv(base, 0.55, 0.4)),
        Transform::identity(),
        None,
    );

    let scale = 58.0 / 162.0;
    let transform = Transform::from_scale(k, k)
        .pre_concat(Transform::from_translate(50.0, 52.0))
        .pre_concat(Transform::from_scale(scale, scale))
        .pre_concat(Transform::from_translate(-81.0, -67.5))
        .pre_concat(Transform::from_row(
            0.553097, 0.0, 0.0, 0.553279, -113.385, -213.012,
        ));
    let mark = paint(lighten(base, 0.35));
    for d in [MARK_LEFT, MARK_RIGHT] {
        pixmap.fill_path(&parse_path(d)?, &mark, FillRule::Winding, transform, None);
    }
    pixmap.encode_png().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_a_png_and_the_colour_follows_the_id() {
        let a = png("1564865665913848117", 128).expect("png");
        assert_eq!(&a[..4], b"\x89PNG");
        assert_ne!(a, png("1", 128).expect("png"));
    }

    #[test]
    fn id_hash_matches_the_client() {
        assert_eq!(color_for_id("abc"), color_for_id("abc"));
        let sample = color_for_id("1564865665913848117");
        assert!(sample.iter().all(|c| (0.0..=1.0).contains(c)));
    }
}
