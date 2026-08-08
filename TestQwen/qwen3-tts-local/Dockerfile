# Qwen3-TTS local (CPU Docker — Apple Silicon / Linux)

FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/data/hf \
    TRANSFORMERS_CACHE=/data/hf \
    HUGGINGFACE_HUB_CACHE=/data/hf \
    TORCH_HOME=/data/torch

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      ffmpeg \
      git \
      libsndfile1 \
      sox \
      libsox-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU PyTorch (works on linux/amd64 and linux/arm64 Docker Desktop)
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
 && pip install --no-cache-dir \
      torch \
      torchaudio \
      --index-url https://download.pytorch.org/whl/cpu

# Official Qwen3-TTS package (includes qwen-tts-demo Gradio UI)
RUN pip install --no-cache-dir \
      "qwen-tts==0.1.1" \
      fastapi \
      "uvicorn[standard]" \
      pydantic \
      python-multipart

COPY api_server.py entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

EXPOSE 8000 8080

VOLUME ["/data/hf", "/app/outputs"]

ENTRYPOINT ["/app/entrypoint.sh"]
