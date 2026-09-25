#!/usr/bin/env bash
# Stage the on-device reranker (src/memory/local.rerank.ts, record 61) into <dir>: a 23 MB cross-encoder, its tokenizer
# and the onnxruntime-web WebAssembly that runs it. The model is fetched once at a pinned revision into a cache and
# checked against its SHA-256, so a build is repeatable and offline after the first. Called by prepare-engine.sh when
# BIMAX_LOCAL_RERANK=1; off by default because the loaded reranker costs ~240 MB.
# Usage: stage-local-rerank.sh <dir> <repo root>
set -euo pipefail
rerank_dir="$1"
repo="$2"
mkdir -p "$rerank_dir"
cache="${BIMAX_MODEL_CACHE:-$HOME/.cache/bimax/models}/ms-marco-MiniLM-L6-v2@233902d"
base="https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2/resolve/233902d25c440f23af6f7d6e94d2946bac0bee0a"
mkdir -p "$cache"
fetch() { # <remote path> <local name> <sha256>
  local file="$cache/$2"
  if [ ! -f "$file" ] || [ "$(shasum -a 256 "$file" | cut -d' ' -f1)" != "$3" ]; then
    curl -fsSL "$base/$1" -o "$file.part" || { echo "error: could not download $1 (unset BIMAX_LOCAL_RERANK to build without it)" >&2; exit 1; }
    mv "$file.part" "$file"
  fi
  [ "$(shasum -a 256 "$file" | cut -d' ' -f1)" = "$3" ] || { echo "error: $2 does not match its pinned SHA-256" >&2; exit 1; }
  cp "$file" "$rerank_dir/$2"
}
fetch onnx/model_qint8_arm64.onnx model_qint8_arm64.onnx 3573b6b9593cb2f75987a31815d409ca3dd8808629118fd20451bb1a5d90cec7
fetch tokenizer.json tokenizer.json d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66
ort="$repo/node_modules/onnxruntime-web/dist"
for f in ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.mjs; do
  [ -f "$ort/$f" ] || { echo "error: $ort/$f missing — run npm install at the repository root" >&2; exit 1; }
  cp "$ort/$f" "$rerank_dir/$f"
done
