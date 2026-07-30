#!/usr/bin/env bash
# ── build-wasm.sh ───────────────────────────────────────────────────────────
# Builds the WebAssembly target into web/public/wasm/.
#
# This script sources emsdk itself rather than assuming your shell already has
# it. That is deliberate: emsdk_env.sh mutates PATH in the current shell only,
# so a build that depends on you having sourced it works on your machine and
# fails in CI, in a cron job, and for anyone who clones the repo. Sourcing here
# makes the build reproducible from a bare terminal.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET="${1:-wasm-release}"

# CI installs emscripten via the setup-emsdk action, which puts emcc on PATH
# and sets EMSDK already; only source the local SDK when it is absent.
if ! command -v emcc >/dev/null 2>&1; then
  EMSDK_DIR="${EMSDK:-$HOME/emsdk}"
  if [[ ! -f "$EMSDK_DIR/emsdk_env.sh" ]]; then
    echo "error: emscripten not found on PATH and no SDK at $EMSDK_DIR" >&2
    echo "       run scripts/bootstrap.sh first" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
fi

echo "==> emcc $(emcc --version | head -1 | sed 's/.*) //')"
echo "==> preset: $PRESET"

cmake --preset "$PRESET"
cmake --build --preset "$PRESET"

echo "==> artifacts:"
ls -lh "$ROOT/web/public/wasm/"
