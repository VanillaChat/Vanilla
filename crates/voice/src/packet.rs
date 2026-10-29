//! Media packet format shared by backend relay and web client.
//!
//! All integers are little-endian. 16-byte header:
//!   0      version(4) | kind(4)       (kind: 0 audio, 1 video)
//!   1      codec                      (see [`Codec`])
//!   2      flags                      (see `FLAG_*`)
//!   3      tag                        (see [`Tag`]; which stream of the sender)
//!   4..8   ssrc                       (assigned by the server on join)
//!   8..12  seq                        (per ssrc+tag, wrapping)
//!   12..16 timestamp                  (48 kHz sample clock for audio, 90 kHz for video)
//!
//! If `FLAG_REDUNDANT` is set the payload starts with
//!   u16 red_len, u16 red_ts_delta, red bytes
//! holding the previous frame (seq - 1, timestamp - red_ts_delta) so a single
//! lost packet is repaired without any added latency. The rest is the primary
//! payload.

pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 16;

pub const KIND_AUDIO: u8 = 0;
pub const KIND_VIDEO: u8 = 1;

pub const FLAG_REDUNDANT: u8 = 1 << 0;
pub const FLAG_KEYFRAME: u8 = 1 << 1;
pub const FLAG_END_OF_FRAME: u8 = 1 << 2;
pub const FLAG_FRAME_START: u8 = 1 << 5;

/// Bits 3-4 of `flags` carry the quality layer of a stream.
///
/// Audio: layer 0 is the best stream (lossless when enabled), layer 1 is an
/// Opus copy that the server hands to receivers on a slow link.
/// Video: layer 0 is full resolution, higher layers are smaller simulcast
/// encodes. Every layer has its own `seq` counter.
pub const LAYER_SHIFT: u8 = 3;
pub const LAYER_MASK: u8 = 0b11 << LAYER_SHIFT;

pub const fn layer_flags(layer: u8) -> u8 {
    (layer & 0b11) << LAYER_SHIFT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Codec {
    Lossless = 0,
    Opus = 1,
    Vp8 = 2,
    H264 = 3,
    Av1 = 4,
    Vp9 = 5,
}

impl Codec {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Lossless,
            1 => Self::Opus,
            2 => Self::Vp8,
            3 => Self::H264,
            4 => Self::Av1,
            5 => Self::Vp9,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Tag {
    Mic = 0,
    ScreenAudio = 1,
    ScreenVideo = 2,
    Camera = 3,
}

impl Tag {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Mic,
            1 => Self::ScreenAudio,
            2 => Self::ScreenVideo,
            3 => Self::Camera,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub kind: u8,
    pub codec: Codec,
    pub flags: u8,
    pub tag: Tag,
    pub ssrc: u32,
    pub seq: u32,
    pub timestamp: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketError {
    TooShort,
    BadVersion,
    BadCodec,
    BadTag,
    BadRedundancy,
}

impl Header {
    pub fn layer(&self) -> u8 {
        (self.flags & LAYER_MASK) >> LAYER_SHIFT
    }

    pub fn write(&self, out: &mut Vec<u8>) {
        out.push((VERSION << 4) | (self.kind & 0x0f));
        out.push(self.codec as u8);
        out.push(self.flags);
        out.push(self.tag as u8);
        out.extend_from_slice(&self.ssrc.to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&self.timestamp.to_le_bytes());
    }

    pub fn parse(data: &[u8]) -> Result<Self, PacketError> {
        if data.len() < HEADER_LEN {
            return Err(PacketError::TooShort);
        }
        if data[0] >> 4 != VERSION {
            return Err(PacketError::BadVersion);
        }
        Ok(Self {
            kind: data[0] & 0x0f,
            codec: Codec::from_u8(data[1]).ok_or(PacketError::BadCodec)?,
            flags: data[2],
            tag: Tag::from_u8(data[3]).ok_or(PacketError::BadTag)?,
            ssrc: u32::from_le_bytes(data[4..8].try_into().unwrap()),
            seq: u32::from_le_bytes(data[8..12].try_into().unwrap()),
            timestamp: u32::from_le_bytes(data[12..16].try_into().unwrap()),
        })
    }
}

pub fn peek_ssrc(data: &[u8]) -> Option<u32> {
    if data.len() < HEADER_LEN || data[0] >> 4 != VERSION {
        return None;
    }
    Some(u32::from_le_bytes(data[4..8].try_into().unwrap()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Redundant<'a> {
    pub ts_delta: u16,
    pub payload: &'a [u8],
}

pub fn split_body<'a>(
    header: &Header,
    body: &'a [u8],
) -> Result<(Option<Redundant<'a>>, &'a [u8]), PacketError> {
    if header.flags & FLAG_REDUNDANT == 0 {
        return Ok((None, body));
    }
    if body.len() < 4 {
        return Err(PacketError::BadRedundancy);
    }
    let len = u16::from_le_bytes([body[0], body[1]]) as usize;
    let ts_delta = u16::from_le_bytes([body[2], body[3]]);
    let rest = &body[4..];
    if len > rest.len() {
        return Err(PacketError::BadRedundancy);
    }
    Ok((
        Some(Redundant {
            ts_delta,
            payload: &rest[..len],
        }),
        &rest[len..],
    ))
}

pub fn build_audio_packet(
    header: &Header,
    redundant: Option<(u16, &[u8])>,
    payload: &[u8],
) -> Vec<u8> {
    let mut h = *header;
    if redundant.is_some() {
        h.flags |= FLAG_REDUNDANT;
    }
    let mut out =
        Vec::with_capacity(HEADER_LEN + payload.len() + 4 + redundant.map_or(0, |r| r.1.len()));
    h.write(&mut out);
    if let Some((delta, red)) = redundant {
        out.extend_from_slice(&(red.len() as u16).to_le_bytes());
        out.extend_from_slice(&delta.to_le_bytes());
        out.extend_from_slice(red);
    }
    out.extend_from_slice(payload);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> Header {
        Header {
            kind: KIND_AUDIO,
            codec: Codec::Lossless,
            flags: 0,
            tag: Tag::Mic,
            ssrc: 0xdead_beef,
            seq: 7,
            timestamp: 1_680,
        }
    }

    #[test]
    fn header_roundtrip() {
        let mut buf = Vec::new();
        header().write(&mut buf);
        assert_eq!(buf.len(), HEADER_LEN);
        assert_eq!(Header::parse(&buf), Ok(header()));
        assert_eq!(peek_ssrc(&buf), Some(0xdead_beef));
    }

    /// Mirrored byte-for-byte in the TypeScript tests; keep in sync.
    #[test]
    fn known_vector() {
        let mut buf = Vec::new();
        header().write(&mut buf);
        assert_eq!(
            buf,
            [
                0x10, 0, 0, 0, 0xef, 0xbe, 0xad, 0xde, 7, 0, 0, 0, 0x90, 0x06, 0, 0
            ]
        );
    }

    #[test]
    fn layer_lives_in_flag_bits_3_and_4() {
        let mut h = header();
        h.flags = FLAG_KEYFRAME | layer_flags(2) | FLAG_FRAME_START;
        let mut buf = Vec::new();
        h.write(&mut buf);
        let parsed = Header::parse(&buf).unwrap();
        assert_eq!(parsed.layer(), 2);
        assert!(parsed.flags & FLAG_KEYFRAME != 0);
        assert!(parsed.flags & FLAG_FRAME_START != 0);
        assert_eq!(layer_flags(7), layer_flags(3), "layer is masked to 2 bits");
    }

    #[test]
    fn redundancy_roundtrip() {
        let pkt = build_audio_packet(&header(), Some((240, b"prev")), b"current");
        let h = Header::parse(&pkt).unwrap();
        assert!(h.flags & FLAG_REDUNDANT != 0);
        let (red, primary) = split_body(&h, &pkt[HEADER_LEN..]).unwrap();
        let red = red.unwrap();
        assert_eq!(red.payload, b"prev");
        assert_eq!(red.ts_delta, 240);
        assert_eq!(primary, b"current");

        let pkt = build_audio_packet(&header(), None, b"only");
        let h = Header::parse(&pkt).unwrap();
        let (red, primary) = split_body(&h, &pkt[HEADER_LEN..]).unwrap();
        assert!(red.is_none());
        assert_eq!(primary, b"only");
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(Header::parse(&[0; 4]), Err(PacketError::TooShort));
        let mut buf = Vec::new();
        header().write(&mut buf);
        buf[0] = 0x20;
        assert_eq!(Header::parse(&buf), Err(PacketError::BadVersion));
        buf[0] = 0x10;
        buf[1] = 99;
        assert_eq!(Header::parse(&buf), Err(PacketError::BadCodec));
        buf[1] = 0;
        buf[3] = 99;
        assert_eq!(Header::parse(&buf), Err(PacketError::BadTag));

        let mut h = header();
        h.flags = FLAG_REDUNDANT;
        assert_eq!(split_body(&h, &[1, 0]), Err(PacketError::BadRedundancy));
        assert_eq!(
            split_body(&h, &[9, 0, 0, 0, 1]),
            Err(PacketError::BadRedundancy)
        );
    }
}
