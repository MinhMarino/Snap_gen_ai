# Qwen3-TTS 1.7B local (Docker)

Chạy **Qwen3-TTS-12Hz-1.7B** local qua Docker: Gradio UI + FastAPI.

> Máy bạn là **Mac M2** → trong Docker chỉ có **CPU** (không CUDA/MPS). Nên cấp Docker Desktop **≥ 12GB RAM**.

## Quick start

```bash
cd qwen3-tts-local

# 1) Tăng RAM Docker Desktop nếu chưa (>= 12GB)
# 2) Build + chạy
docker compose up --build
```

Lần đầu sẽ tải model (~3–4GB) vào volume `hf-cache` — có thể mất vài phút.

| Service | URL |
|---------|-----|
| Gradio UI | http://localhost:8000 |
| FastAPI docs | http://localhost:8080/docs |
| Health | http://localhost:8080/health |

## Đổi model

Sửa `.env`:

```env
# 9 giọng sẵn + instruct (khuyến nghị)
MODEL_ID=Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice

# Thiết kế giọng bằng mô tả text (nam trẻ Nhật, v.v.)
# MODEL_ID=Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign

# Nhẹ hơn nếu bị OOM
# MODEL_ID=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
```

Rồi:

```bash
docker compose up -d --build
```

## Test API (giọng nam + tiếng Nhật)

```bash
./scripts/test-api.sh
# → outputs/jp-ryan-local.wav
```

Hoặc curl:

```bash
curl -X POST http://localhost:8080/tts \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "こんにちは。僕はケンです。よろしくね！",
    "speaker": "Ryan",
    "language": "Japanese",
    "instruct": "Young friendly male, casual tone"
  }' \
  --output outputs/test.wav
```

Speakers CustomVoice: `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric`, `Ryan`, `Aiden`, `Ono_Anna`, `Sohee`.

## Commands

```bash
docker compose logs -f          # xem log / download progress
docker compose down             # dừng
docker compose down -v          # dừng + xóa cache model
docker compose exec qwen3-tts python -c "import torch; print(torch.__version__)"
```

## MODE

| MODE | Cổng |
|------|------|
| `both` (default) | Gradio `:8000` + API `:8080` |
| `demo` | chỉ Gradio |
| `api` | chỉ FastAPI |

## Native Mac (MPS, nhanh hơn Docker)

Docker trên Mac không dùng GPU. Để chạy native với Apple Silicon:

```bash
./scripts/run-native-mac.sh
```

## Troubleshooting

| Lỗi | Cách xử lý |
|-----|------------|
| OOM / killed | Docker RAM ≥ 12GB, hoặc dùng `0.6B-CustomVoice` |
| Download chậm / timeout | Thêm `HF_TOKEN` trong `.env`, hoặc tải sẵn vào `./models` |
| Port đang dùng | Đổi `DEMO_PORT` / `API_PORT` trong `.env` |
