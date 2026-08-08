#!/usr/bin/env bash
# Run Qwen3-TTS natively on Apple Silicon (MPS) — faster than Docker CPU.
set -euo pipefail
cd "$(dirname "$0")/.."

MODEL_ID="${MODEL_ID:-Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice}"
PORT="${PORT:-8000}"
VENV="${VENV:-.venv}"

if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  pip install -U pip
  pip install torch torchaudio
  pip install "qwen-tts==0.1.1"
else
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
fi

echo "Starting Gradio with MPS: $MODEL_ID"
exec qwen-tts-demo "$MODEL_ID" \
  --device mps \
  --dtype float16 \
  --no-flash-attn \
  --ip 127.0.0.1 \
  --port "$PORT"
