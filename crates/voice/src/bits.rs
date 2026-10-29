use crate::codec::CodecError;

pub struct BitWriter {
    buf: Vec<u8>,
    acc: u64,
    n: u32,
}

impl BitWriter {
    pub fn with_capacity(bytes: usize) -> Self {
        Self {
            buf: Vec::with_capacity(bytes),
            acc: 0,
            n: 0,
        }
    }

    pub fn write(&mut self, v: u64, bits: u32) {
        debug_assert!(bits <= 32);
        if bits == 0 {
            return;
        }
        let mask = (1u64 << bits) - 1;
        self.acc = (self.acc << bits) | (v & mask);
        self.n += bits;
        while self.n >= 8 {
            self.n -= 8;
            self.buf.push((self.acc >> self.n) as u8);
        }
        self.acc &= (1u64 << self.n) - 1;
    }

    pub fn write_signed(&mut self, v: i64, bits: u32) {
        self.write(v as u64, bits);
    }

    pub fn write_unary(&mut self, mut q: u64) {
        while q >= 31 {
            self.write(0, 31);
            q -= 31;
        }
        self.write(1, q as u32 + 1);
    }

    pub fn finish(mut self) -> Vec<u8> {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.buf.push((self.acc << pad) as u8);
        }
        self.buf
    }
}

pub struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len() * 8 - self.pos
    }

    pub fn read(&mut self, bits: u32) -> Result<u64, CodecError> {
        debug_assert!(bits <= 32);
        if bits as usize > self.remaining() {
            return Err(CodecError::Truncated);
        }
        let mut v = 0u64;
        let mut left = bits;
        while left > 0 {
            let byte = self.data[self.pos >> 3];
            let avail = 8 - (self.pos & 7) as u32;
            let take = avail.min(left);
            let chunk = (byte >> (avail - take)) & ((1u16 << take) - 1) as u8;
            v = (v << take) | chunk as u64;
            self.pos += take as usize;
            left -= take;
        }
        Ok(v)
    }

    pub fn read_signed(&mut self, bits: u32) -> Result<i64, CodecError> {
        if bits == 0 {
            return Ok(0);
        }
        let v = self.read(bits)?;
        let shift = 64 - bits;
        Ok(((v << shift) as i64) >> shift)
    }

    pub fn read_unary(&mut self) -> Result<u64, CodecError> {
        let mut q = 0u64;
        loop {
            if self.remaining() == 0 {
                return Err(CodecError::Truncated);
            }
            let byte = self.data[self.pos >> 3];
            let off = (self.pos & 7) as u32;
            let rest = (byte << off) as u8;
            if rest == 0 {
                let skipped = 8 - off;
                q += skipped as u64;
                self.pos += skipped as usize;
            } else {
                let z = rest.leading_zeros();
                q += z as u64;
                self.pos += z as usize + 1;
                return Ok(q);
            }
        }
    }
}
