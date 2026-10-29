#!/usr/bin/env bash
# Builds the codec crate to WASM and generates the JS glue the web client imports.
# Needs: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli
# (the CLI version must match the wasm-bindgen version in the workspace Cargo.lock).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for dep in cargo wasm-bindgen; do
    command -v "$dep" >/dev/null || { echo "[voice] missing: $dep" >&2; exit 1; }
done

cargo build -q --profile wasm -p vanilla-voice --features wasm --target wasm32-unknown-unknown \
    --manifest-path "$ROOT/Cargo.toml"
wasm-bindgen --target web --out-dir "$ROOT/apps/frontend/src/voice/wasm" \
    "$ROOT/target/wasm32-unknown-unknown/wasm/vanilla_voice.wasm"
