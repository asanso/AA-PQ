#!/usr/bin/env bash
# Rebuilds src/crypto/lean-sphincs.wasm from this crate and checks it against the committed binary.
#
#     lean-sphincs-wasm/build.sh            # build into a temporary directory and compare
#     lean-sphincs-wasm/build.sh --write    # replace the committed binary
#
# Paths are remapped so the binary holds no local directory names, which keeps it reproducible
# with the pinned toolchain (rust-toolchain.toml) and Cargo.lock.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
committed="$here/../src/crypto/lean-sphincs.wasm"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export CARGO_HOME="$work/cargo" CARGO_TARGET_DIR="$work/target"
export RUSTFLAGS="--remap-path-prefix=$CARGO_HOME=cargo --remap-path-prefix=$here=lean_sphincs_wasm"
(cd "$here" && cargo build --locked --release --target wasm32-unknown-unknown)
built="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/lean_sphincs_wasm.wasm"
if grep -qa -e "$HOME" -e "$work" "$built"; then echo "The binary holds a local path." >&2; exit 1; fi
if [ "${1:-}" = "--write" ]; then cp "$built" "$committed"; fi
shasum -a 256 "$built" "$committed"
cmp "$built" "$committed" && echo "lean-sphincs.wasm matches this source."
