#!/usr/bin/env bash
# Regenerates docs/openapi.json from the handler annotations.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo run -q -p vanilla-backend --manifest-path "$ROOT/Cargo.toml" -- --print-openapi > "$ROOT/docs/openapi.json"
echo "[openapi] wrote docs/openapi.json"
