#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for dep in cargo bun ss; do
    command -v "$dep" >/dev/null || { echo "[dev] missing: $dep" >&2; exit 1; }
done

if [ ! -d "$ROOT/apps/frontend/node_modules" ]; then
    echo "[dev] installing frontend deps"
    (cd "$ROOT/apps/frontend" && bun install)
fi

echo "[dev] building voice codec (wasm)"
"$ROOT/crates/voice/build-wasm.sh"

# Wayland docks match windows to a .desktop entry by app_id (the binary name); without one the
# dev window has no icon. Idempotent, user-level.
if [[ " $* " == *" --desktop "* ]]; then
    entries="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$entries"
    cat >"$entries/vanilla-desktop.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Vanilla
Icon=$ROOT/apps/desktop/src-tauri/icons/128x128@2x.png
StartupWMClass=vanilla-desktop
NoDisplay=true
ENTRY
fi

cargo build -q --release -p vanilla-dev --manifest-path "$ROOT/Cargo.toml"
exec "$ROOT/target/release/vanilla-dev" "$ROOT" "$@"
