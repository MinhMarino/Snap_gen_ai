"""
Minimal local TTS HTTP API for Qwen3-TTS CustomVoice / VoiceDesign / Base.

Endpoints:
  GET  /health
  GET  /v1/voices
  POST /v1/audio/speech   (OpenAI-ish)
  POST /tts               (simple JSON)

Env:
  MODEL_ID, DEVICE, DTYPE
"""

from __future__ import annotations

import io
import os
from functools import lru_cache
from typing import Any, Optional

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

MODEL_ID = os.getenv("MODEL_ID", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
DEVICE = os.getenv("DEVICE", "cpu")
DTYPE_STR = os.getenv("DTYPE", "float32").lower()

DTYPE_MAP = {
    "float32": torch.float32,
    "fp32": torch.float32,
    "float16": torch.float16,
    "fp16": torch.float16,
    "bfloat16": torch.bfloat16,
    "bf16": torch.bfloat16,
}

app = FastAPI(title="Qwen3-TTS Local", version="1.0.0")


def _dtype() -> torch.dtype:
    if DTYPE_STR not in DTYPE_MAP:
        raise RuntimeError(f"Unsupported DTYPE={DTYPE_STR}")
    return DTYPE_MAP[DTYPE_STR]


@lru_cache(maxsize=1)
def get_model():
    from qwen_tts import Qwen3TTSModel

    print(f"Loading model {MODEL_ID} on {DEVICE} ({DTYPE_STR})…")
    model = Qwen3TTSModel.from_pretrained(
        MODEL_ID,
        device_map=DEVICE,
        dtype=_dtype(),
        attn_implementation="sdpa",
    )
    print("Model ready.")
    return model


def _detect_kind(model) -> str:
    mid = MODEL_ID.lower()
    if "voicedesign" in mid or "voice-design" in mid:
        return "voicedesign"
    if "customvoice" in mid or "custom-voice" in mid:
        return "customvoice"
    if "base" in mid:
        return "base"
    # fallback by capabilities
    if hasattr(model, "generate_custom_voice"):
        return "customvoice"
    if hasattr(model, "generate_voice_design"):
        return "voicedesign"
    return "base"


class SpeechRequest(BaseModel):
    input: str = Field(..., description="Text to synthesize")
    voice: str = Field("Ryan", description="Speaker for CustomVoice, e.g. Ryan/Aiden/Vivian")
    model: Optional[str] = None
    language: str = Field("Auto", description="Chinese|English|Japanese|…|Auto")
    instruct: str = Field("", description="Style instruction (CustomVoice / VoiceDesign)")
    response_format: str = Field("wav", description="wav only for now")
    speed: float = 1.0


class SimpleTTSRequest(BaseModel):
    text: str
    speaker: str = "Ryan"
    language: str = "Japanese"
    instruct: str = ""


def _wav_bytes(audio: Any, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    return buf.getvalue()


def synthesize(text: str, speaker: str, language: str, instruct: str) -> tuple[bytes, int]:
    model = get_model()
    kind = _detect_kind(model)
    instruct = instruct or None

    try:
        if kind == "customvoice":
            wavs, sr = model.generate_custom_voice(
                text=text,
                language=language,
                speaker=speaker,
                instruct=instruct,
            )
        elif kind == "voicedesign":
            if not instruct:
                instruct = (
                    "A young Japanese man in his early 20s, clear mid-range male voice, "
                    "friendly and natural."
                )
            wavs, sr = model.generate_voice_design(
                text=text,
                language=language,
                instruct=instruct,
            )
        else:
            raise HTTPException(
                status_code=501,
                detail="Base (voice-clone) model needs reference audio. Use CustomVoice or VoiceDesign.",
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return _wav_bytes(wavs[0], sr), sr


@app.on_event("startup")
def _warmup():
    # Lazy by default; set WARMUP=1 to load at boot
    if os.getenv("WARMUP", "0") == "1":
        get_model()


@app.get("/health")
def health():
    loaded = get_model.cache_info().currsize > 0
    return {
        "ok": True,
        "model_id": MODEL_ID,
        "device": DEVICE,
        "dtype": DTYPE_STR,
        "loaded": loaded,
    }


@app.get("/v1/voices")
def voices():
    model = get_model()
    kind = _detect_kind(model)
    speakers = []
    languages = []
    try:
        speakers = list(model.get_supported_speakers() or [])
    except Exception:
        pass
    try:
        languages = list(model.get_supported_languages() or [])
    except Exception:
        pass
    return {"kind": kind, "speakers": speakers, "languages": languages}


@app.post("/v1/audio/speech")
def openai_speech(req: SpeechRequest):
    if req.response_format.lower() not in ("wav", "pcm"):
        raise HTTPException(400, "Only wav is supported in this local server")
    audio, _sr = synthesize(req.input, req.voice, req.language, req.instruct)
    return Response(content=audio, media_type="audio/wav")


@app.post("/tts")
def tts(req: SimpleTTSRequest):
    audio, _sr = synthesize(req.text, req.speaker, req.language, req.instruct)
    return Response(content=audio, media_type="audio/wav")
