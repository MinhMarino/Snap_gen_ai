#!/usr/bin/env bash
set -euo pipefail

MODE="${MODE:-demo}"                 # demo | api | both
MODEL_ID="${MODEL_ID:-Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice}"
DEVICE="${DEVICE:-cpu}"
DTYPE="${DTYPE:-float32}"            # CPU: float32 (safer). GPU: bfloat16/float16
HOST="${HOST:-0.0.0.0}"
DEMO_PORT="${DEMO_PORT:-8000}"
API_PORT="${API_PORT:-8080}"

mkdir -p /data/hf /app/outputs

echo "============================================"
echo " Qwen3-TTS local"
echo " MODEL_ID = ${MODEL_ID}"
echo " DEVICE   = ${DEVICE}"
echo " DTYPE    = ${DTYPE}"
echo " MODE     = ${MODE}"
echo "============================================"

start_demo() {
  echo "Starting Gradio demo on :${DEMO_PORT}"
  exec qwen-tts-demo "${MODEL_ID}" \
    --device "${DEVICE}" \
    --dtype "${DTYPE}" \
    --no-flash-attn \
    --ip "${HOST}" \
    --port "${DEMO_PORT}"
}

start_api() {
  echo "Starting FastAPI on :${API_PORT}"
  exec python -m uvicorn api_server:app \
    --host "${HOST}" \
    --port "${API_PORT}"
}

case "${MODE}" in
  demo)
    start_demo
    ;;
  api)
    start_api
    ;;
  both)
    echo "Starting API on :${API_PORT} (background) + Gradio on :${DEMO_PORT}"
    python -m uvicorn api_server:app --host "${HOST}" --port "${API_PORT}" &
    start_demo
    ;;
  *)
    echo "Unknown MODE=${MODE}. Use: demo | api | both"
    exit 1
    ;;
esac
