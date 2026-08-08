#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p outputs

API="${API:-http://localhost:8080}"

echo "Health:"
curl -sS "$API/health" | python3 -m json.tool || true
echo

echo "Voices:"
curl -sS "$API/v1/voices" | python3 -m json.tool || true
echo

OUT="outputs/jp-ryan-local.wav"
echo "Synthesize → $OUT"
curl -sS -X POST "$API/tts" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "こんにちは。僕はケン、二十歳です。今日はいい天気ですね。よろしくね！",
    "speaker": "Ryan",
    "language": "Japanese",
    "instruct": "Young Japanese man, friendly, bright mid-range male voice, casual and warm"
  }' \
  --output "$OUT"

ls -la "$OUT"
file "$OUT"
echo "Done. open $OUT"
