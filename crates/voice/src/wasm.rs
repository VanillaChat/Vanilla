//! wasm-bindgen surface used by the web client's media worker.

use crate::codec::{self, f32_to_pcm, pcm_to_f32};
use wasm_bindgen::prelude::*;

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub struct LosslessEncoder {
    channels: u8,
    bit_depth: u8,
    pcm: Vec<i32>,
}

#[wasm_bindgen]
impl LosslessEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(channels: u8, bit_depth: u8) -> Result<LosslessEncoder, JsError> {
        if !(channels == 1 || channels == 2) || !(bit_depth == 16 || bit_depth == 24) {
            return Err(JsError::new("unsupported channel count or bit depth"));
        }
        Ok(Self {
            channels,
            bit_depth,
            pcm: Vec::new(),
        })
    }

    pub fn encode(&mut self, input: &[f32]) -> Result<Vec<u8>, JsError> {
        f32_to_pcm(input, self.bit_depth, &mut self.pcm);
        codec::encode(&self.pcm, self.channels, self.bit_depth).map_err(js_err)
    }
}

#[wasm_bindgen]
pub struct LosslessDecoder {
    pcm: Vec<i32>,
    out: Vec<f32>,
    channels: u8,
    bit_depth: u8,
}

#[wasm_bindgen]
impl LosslessDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> LosslessDecoder {
        Self {
            pcm: Vec::new(),
            out: Vec::new(),
            channels: 1,
            bit_depth: 16,
        }
    }

    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<f32>, JsError> {
        let info = codec::decode(data, &mut self.pcm).map_err(js_err)?;
        self.channels = info.channels;
        self.bit_depth = info.bit_depth;
        pcm_to_f32(&self.pcm, info.bit_depth, &mut self.out);
        Ok(self.out.clone())
    }

    pub fn channels(&self) -> u8 {
        self.channels
    }

    pub fn bit_depth(&self) -> u8 {
        self.bit_depth
    }
}

impl Default for LosslessDecoder {
    fn default() -> Self {
        Self::new()
    }
}
