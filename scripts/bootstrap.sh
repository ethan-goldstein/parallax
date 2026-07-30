#!/usr/bin/env bash
# ── bootstrap.sh ────────────────────────────────────────────────────────────
# One-time toolchain setup. Read it before you run it.
#
# Installs: cmake, ninja (via Homebrew) and the Emscripten SDK (into ~/emsdk).
# Downloads roughly 1 GB and takes a few minutes on a cold cache.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Pinned, and pinned in exactly one other place: .github/workflows/deploy.yml.
# Drift between the two produces wasm that behaves differently locally and in
# production, which is a genuinely miserable class of bug to chase.
EMSDK_VERSION="6.0.5"
EMSDK_DIR="${EMSDK:-$HOME/emsdk}"

echo "==> cmake + ninja"
if ! command -v brew >/dev/null 2>&1; then
  echo "error: Homebrew not found — see https://brew.sh" >&2
  exit 1
fi
brew install cmake ninja

echo "==> emscripten $EMSDK_VERSION -> $EMSDK_DIR"
if [[ ! -d "$EMSDK_DIR" ]]; then
  git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
"$EMSDK_DIR/emsdk" install "$EMSDK_VERSION"
"$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION"

# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1

echo
echo "==> versions"
cmake --version | head -1
echo "ninja $(ninja --version)"
emcc --version | head -1

cat <<'EOF'

Done. The build scripts source emsdk themselves, so nothing needs to go in
your shell profile for `cmake --preset` or `scripts/build-wasm.sh` to work.

If you want emcc available in interactive shells as well:
  echo 'source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1' >> ~/.zprofile

Next:
  cmake --preset native-debug && cmake --build --preset native-debug
  ctest --preset native-debug
  ./scripts/build-wasm.sh
  npm --prefix web install && npm --prefix web run build
EOF
