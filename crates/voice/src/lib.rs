//! Shared voice/media primitives for Vanilla: lossless codec and packet format.

mod bits;
pub mod codec;
pub mod packet;

#[cfg(feature = "wasm")]
mod wasm;
