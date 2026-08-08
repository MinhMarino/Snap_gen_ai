# Irodori TTS API — Hướng dẫn tích hợp

Tài liệu tích hợp **Qwen3-TTS 1.7B** (CustomVoice + VoiceDesign) qua **RunPod Serverless**.

- Auth: **API key Bearer** — **không cần OAuth**
- URL public sẵn — **không cần Railway / hosting gateway riêng**
- Output: WAV (`audio/wav`), sample rate thường **24000 Hz**

| | |
|---|---|
| Endpoint ID | `3gq6tivo3ms4ls` |
| Model | Qwen3-TTS-12Hz-1.7B CustomVoice + VoiceDesign |
| Repo | https://github.com/MinhMarino/Irodori-TTS |
| Console | https://console.runpod.io/serverless/user/endpoint/3gq6tivo3ms4ls |
| Tạo API key | https://console.runpod.io/user/settings?tab=api-keys |

---

## Mục lục

1. [Bắt đầu nhanh](#1-bắt-đầu-nhanh)
2. [URL & xác thực](#2-url--xác-thực)
3. [Hai chế độ TTS](#3-hai-chế-độ-tts)
4. [Ngôn ngữ hỗ trợ](#4-ngôn-ngữ-hỗ-trợ)
5. [Danh sách voice theo ngôn ngữ](#5-danh-sách-voice-theo-ngôn-ngữ)
6. [Request / Response chi tiết](#6-request--response-chi-tiết)
7. [Async vs Sync](#7-async-vs-sync)
8. [Ví dụ tích hợp](#8-ví dụ-tích-hợp)
9. [Lỗi thường gặp](#9-lỗi-thường-gặp)
10. [Latency & timeout](#10-latency--timeout)
11. [Bảo mật khi gắn vào web](#11-bảo-mật-khi-gắn-vào-web)
12. [Gateway local (tuỳ chọn)](#12-gateway-local-tuỳ-chọn)
13. [Checklist](#13-checklist)

---

## 1. Bắt đầu nhanh

### 1.1. Lấy RunPod API key

1. Mở https://console.runpod.io/user/settings?tab=api-keys
2. Create API Key → copy key (chỉ hiện một lần)
3. Export:

```bash
export RUNPOD_API_KEY='rp_xxxxxxxx'
export RUNPOD_ENDPOINT_ID='3gq6tivo3ms4ls'
```

### 1.2. Gọi thử (CustomVoice — tiếng Nhật)

```bash
curl -X POST "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/runsync" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "mode": "custom_voice",
      "text": "こんにちは！彩りTTSです。",
      "language": "Japanese",
      "speaker": "Ono_Anna"
    }
  }'
```

Response thành công có `status: "COMPLETED"` và `output.audio_base64` (WAV đã encode Base64).

Giải mã ra file:

```bash
# giả sử đã lưu response vào result.json
python3 - <<'PY'
import json, base64, pathlib
data = json.load(open("result.json"))
audio = data["output"]["audio_base64"]
pathlib.Path("ono-anna.wav").write_bytes(base64.b64decode(audio))
print("wrote ono-anna.wav", "sr=", data["output"].get("sample_rate"))
PY
```

---

## 2. URL & xác thực

### 2.1. Base URL

```
https://api.runpod.ai/v2/3gq6tivo3ms4ls
```

| Method | Path | Mô tả |
|---|---|---|
| `POST` | `/runsync` | Gửi job và **chờ kết quả** (khuyến nghị khi request ngắn) |
| `POST` | `/run` | Gửi job **async**, trả `id` ngay |
| `GET` | `/status/{job_id}` | Poll trạng thái / lấy output |
| `GET` | `/health` | Số job / worker |
| `POST` | `/cancel/{job_id}` | Huỷ job |

Full URL ví dụ:

- Sync: `https://api.runpod.ai/v2/3gq6tivo3ms4ls/runsync`
- Async: `https://api.runpod.ai/v2/3gq6tivo3ms4ls/run`
- Status: `https://api.runpod.ai/v2/3gq6tivo3ms4ls/status/{job_id}`
- Health: `https://api.runpod.ai/v2/3gq6tivo3ms4ls/health`

### 2.2. Auth — chỉ API key, không OAuth

```http
Authorization: Bearer <RUNPOD_API_KEY>
Content-Type: application/json
```

Không có redirect login, không refresh token, không scope OAuth. Key gắn vào mỗi request.

| Sai | Đúng |
|---|---|
| Gọi không header | `401` / unauthorized |
| Key trong query string | Không hỗ trợ — dùng header |
| Hardcode key trong frontend | Rủi ro lộ key — xem [§11](#11-bảo-mật-khi-gắn-vào-web) |

---

## 3. Hai chế độ TTS

Payload luôn bọc trong `input`:

```json
{
  "input": { ... }
}
```

### 3.1. `custom_voice` (mặc định)

Dùng **1 trong 9 speaker** có sẵn. Có thể thêm `instruct` để chỉnh cảm xúc / phong cách.

| Field | Bắt buộc | Mô tả |
|---|---|---|
| `text` | Có | Văn bản cần đọc |
| `mode` | Không | `"custom_voice"` |
| `language` | Không | Mặc định `"Auto"` — nên set rõ khi biết ngôn ngữ |
| `speaker` | Không | Mặc định `"Vivian"` — xem [§5](#5-danh-sách-voice-theo-ngôn-ngữ) |
| `instruct` | Không | VD: `"Speak cheerfully."` / `"用温柔的语气说"` |

```json
{
  "input": {
    "mode": "custom_voice",
    "text": "Hello from Irodori!",
    "language": "English",
    "speaker": "Ryan",
    "instruct": "Speak cheerfully and energetically."
  }
}
```

### 3.2. `voice_design`

**Không** dùng `speaker`. Mô tả giọng bằng `instruct` (bắt buộc).

| Field | Bắt buộc | Mô tả |
|---|---|---|
| `text` | Có | Văn bản cần đọc |
| `mode` | Có | `"voice_design"` |
| `language` | Không | Mặc định `"Auto"` |
| `instruct` | **Có** | Mô tả giọng bằng ngôn ngữ tự nhiên |

```json
{
  "input": {
    "mode": "voice_design",
    "text": "哥哥，你回来啦，人家等了你好久好久了！",
    "language": "Chinese",
    "instruct": "Cute playful young female voice, high pitch, affectionate tone."
  }
}
```

---

## 4. Ngôn ngữ hỗ trợ

Giá trị `language` (đúng chữ hoa đầu từ như bảng):

| Giá trị API | Ngôn ngữ |
|---|---|
| `Auto` | Tự nhận diện (dùng khi không chắc) |
| `Chinese` | Tiếng Trung (Phổ thông) |
| `English` | Tiếng Anh |
| `Japanese` | Tiếng Nhật |
| `Korean` | Tiếng Hàn |
| `German` | Tiếng Đức |
| `French` | Tiếng Pháp |
| `Russian` | Tiếng Nga |
| `Portuguese` | Tiếng Bồ Đào Nha |
| `Spanish` | Tiếng Tây Ban Nha |
| `Italian` | Tiếng Ý |

**Gợi ý:** khi đã biết ngôn ngữ, set tường minh (`Japanese`, `English`…) thay vì `Auto` để ổn định hơn.

**Phương ngữ Trung (qua speaker):**

- `Dylan` → giọng Bắc Kinh
- `Eric` → giọng Thành Đô / Tứ Xuyên

---

## 5. Danh sách voice theo ngôn ngữ

Áp dụng cho mode **`custom_voice`**.

Quy tắc:

- Mọi speaker **có thể** đọc bất kỳ ngôn ngữ nào trong bảng §4.
- Chất lượng **tốt nhất** khi dùng **ngôn ngữ bản địa** của speaker.
- Cột “Khuyến nghị thêm” lấy theo hướng dẫn Qwen3-TTS (cross-lingual vẫn ổn với một số cặp).

### 5.1. Theo ngôn ngữ bản địa (nhóm chính)

#### Chinese — 5 voices

| `speaker` | Giới tính | Mô tả (EN) | Mô tả ngắn (VI) | Khuyến nghị |
|---|---|---|---|---|
| `Vivian` | Nữ | Bright, slightly edgy young female | Nữ trẻ sáng, hơi sắc | `Chinese`, thêm `English` |
| `Serena` | Nữ | Warm, gentle young female | Nữ trẻ ấm, dịu | `Chinese`, thêm `English` |
| `Uncle_Fu` | Nam | Seasoned male, low mellow timbre | Nam trung niên trầm ấm | `Chinese` |
| `Dylan` | Nam | Youthful Beijing male, clear natural | Nam trẻ Bắc Kinh | `Chinese` (+ phương ngữ Bắc Kinh), thêm `English` |
| `Eric` | Nam | Lively Chengdu male, husky brightness | Nam Thành Đô hơi khàn sáng | `Chinese` (+ Tứ Xuyên) |

#### English — 2 voices

| `speaker` | Giới tính | Mô tả (EN) | Mô tả ngắn (VI) | Khuyến nghị |
|---|---|---|---|---|
| `Ryan` | Nam | Dynamic male, strong rhythmic drive | Nam năng động, nhịp mạnh | `English`, thêm `Chinese` |
| `Aiden` | Nam | Sunny American male, clear midrange | Nam Mỹ sunny, trung âm rõ | `English` |

#### Japanese — 1 voice

| `speaker` | Giới tính | Mô tả (EN) | Mô tả ngắn (VI) | Khuyến nghị |
|---|---|---|---|---|
| `Ono_Anna` | Nữ | Playful Japanese female, light nimble | Nữ Nhật vui, linh hoạt | `Japanese`, thêm `English` |

#### Korean — 1 voice

| `speaker` | Giới tính | Mô tả (EN) | Mô tả ngắn (VI) | Khuyến nghị |
|---|---|---|---|---|
| `Sohee` | Nữ | Warm Korean female, rich emotion | Nữ Hàn ấm, giàu cảm xúc | `Korean`, thêm `English` |

### 5.2. Bảng tra nhanh: ngôn ngữ → speaker nên dùng

| `language` | Speaker ưu tiên (native / gần native) | Ghi chú |
|---|---|---|
| `Chinese` | `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric` | `Dylan` / `Eric` mang màu phương ngữ |
| `English` | `Ryan`, `Aiden` | Accent nghiêng Mỹ/neutral |
| `Japanese` | `Ono_Anna` | Best quality cho JP |
| `Korean` | `Sohee` | Best quality cho KR |
| `German` | Không có native — chọn theo vibe (vd. `Ryan`, `Aiden`, `Vivian`) | Cross-lingual |
| `French` | Không có native — chọn theo vibe | Cross-lingual |
| `Russian` | Không có native — chọn theo vibe | Cross-lingual |
| `Portuguese` | Không có native — chọn theo vibe | Cross-lingual |
| `Spanish` | Không có native — chọn theo vibe | Cross-lingual |
| `Italian` | Không có native — chọn theo vibe | Cross-lingual |
| `Auto` | Chọn speaker khớp ngôn ngữ *nội dung* `text` | VD text JP → `Ono_Anna` |

### 5.3. Danh sách ID đầy đủ (copy vào code)

```text
Vivian
Serena
Uncle_Fu
Dylan
Eric
Ryan
Aiden
Ono_Anna
Sohee
```

> ID phải đúng chữ hoa / underscore: `Ono_Anna`, `Uncle_Fu` (không dùng `ono_anna` / `Uncle Fu` trong API Irodori/RunPod worker này).

### 5.4. Gợi ý cặp `speaker` + `language` hay dùng

| Use case | `speaker` | `language` | `text` mẫu |
|---|---|---|---|
| Anime / VTuber JP | `Ono_Anna` | `Japanese` | `こんにちは！よろしくお願いします。` |
| Podcast EN | `Ryan` | `English` | `Welcome to today's episode.` |
| Friendly US | `Aiden` | `English` | `Hey, thanks for stopping by.` |
| Narration CN ấm | `Serena` | `Chinese` | `今天我们来讲一个温暖的故事。` |
| Host CN năng động | `Vivian` | `Chinese` | `大家好，欢迎收听！` |
| Kể chuyện CN trầm | `Uncle_Fu` | `Chinese` | `很久很久以前……` |
| Bắc Kinh tự nhiên | `Dylan` | `Chinese` | `今儿天气真不错。` |
| Thành Đô sinh động | `Eric` | `Chinese` | `要不要一起喝盖碗茶？` |
| Ballad / narration KR | `Sohee` | `Korean` | `안녕하세요. 오늘 이야기 시작할게요.` |

### 5.5. VoiceDesign — không có list speaker cố định

Với `voice_design`, “voice” nằm trong `instruct`. Ví dụ:

| Mục tiêu | `instruct` gợi ý |
|---|---|
| Nữ trẻ dễ thương CN | `Cute playful young female voice, high pitch, affectionate tone.` |
| Nam trầm thuyết trình EN | `Deep confident male narrator, calm studio tone, slight British accent.` |
| Nữ soft ASMR | `Soft whispered young female voice, intimate and gentle.` |

---

## 6. Request / Response chi tiết

### 6.1. Request envelope

```http
POST /v2/3gq6tivo3ms4ls/runsync HTTP/1.1
Host: api.runpod.ai
Authorization: Bearer rp_xxx
Content-Type: application/json
```

```json
{
  "input": {
    "mode": "custom_voice",
    "text": "...",
    "language": "Japanese",
    "speaker": "Ono_Anna",
    "instruct": ""
  }
}
```

Tuỳ chọn thêm (RunPod policy — không bắt buộc):

```json
{
  "input": { "...": "..." },
  "policy": {
    "executionTimeout": 600000,
    "ttl": 3600000
  }
}
```

### 6.2. Response thành công (`runsync` / `status` khi COMPLETED)

```json
{
  "id": "5f55a5f3-19cf-43bb-8129-cf62949ba6aa-u1",
  "status": "COMPLETED",
  "delayTime": 1200,
  "executionTime": 8500,
  "output": {
    "mode": "custom_voice",
    "language": "Japanese",
    "speaker": "Ono_Anna",
    "sample_rate": 24000,
    "format": "wav",
    "audio_base64": "UklGRi....",
    "instruct": null,
    "loaded_modes": ["custom_voice"]
  }
}
```

| Field | Ý nghĩa |
|---|---|
| `status` | `IN_QUEUE` → `IN_PROGRESS` → `COMPLETED` / `FAILED` |
| `delayTime` | ms chờ worker (cold start làm tăng số này) |
| `executionTime` | ms chạy inference |
| `output.audio_base64` | WAV Base64 — decode ra bytes `.wav` |
| `output.sample_rate` | Thường `24000` |
| `output.error` | Có mặt khi handler lỗi (kèm `status` failed / output lỗi) |

### 6.3. Response lỗi từ handler

```json
{
  "id": "...",
  "status": "COMPLETED",
  "output": {
    "error": "instruct is required for voice_design mode"
  }
}
```

Hoặc `status: "FAILED"` với message từ platform. Client nên check cả `status` và `output.error`.

---

## 7. Async vs Sync

### 7.1. Sync — `POST .../runsync`

- Một request → chờ đến khi xong (hoặc hết wait phía RunPod).
- Đơn giản cho backend / script.
- Cold start dài: có thể nhận `IN_QUEUE` / `IN_PROGRESS` + `id` → cần poll `/status/{id}`.

### 7.2. Async — `POST .../run` + poll

```bash
# 1) Submit
curl -sS -X POST "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"input":{"mode":"custom_voice","text":"Hi","language":"English","speaker":"Ryan"}}'
# → {"id":"JOB_ID","status":"IN_QUEUE"}

# 2) Poll
curl -sS "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/JOB_ID" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}"
```

Trạng thái: `IN_QUEUE` | `IN_PROGRESS` | `COMPLETED` | `FAILED` | `CANCELLED` | `TIMED_OUT`.

Khuyến nghị poll mỗi **1–2 giây**, timeout client **≥ 300s** (endpoint đang scale-to-zero).

---

## 8. Ví dụ tích hợp

### 8.1. cURL — CustomVoice WAV (async + decode)

```bash
JOB=$(curl -sS -X POST "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "mode": "custom_voice",
      "text": "こんにちは！彩りTTSです。日本語の音声テストです。",
      "language": "Japanese",
      "speaker": "Ono_Anna"
    }
  }' | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo "job=$JOB"

while true; do
  RESP=$(curl -sS "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${JOB}" \
    -H "Authorization: Bearer ${RUNPOD_API_KEY}")
  STATUS=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))')
  echo "status=$STATUS"
  case "$STATUS" in
    COMPLETED|FAILED|CANCELLED|TIMED_OUT) break ;;
  esac
  sleep 2
done

printf '%s' "$RESP" > result.json
python3 - <<'PY'
import json, base64, pathlib
data = json.load(open("result.json"))
assert data.get("status") == "COMPLETED", data
out = data["output"]
assert "error" not in out, out
pathlib.Path("ono-anna.wav").write_bytes(base64.b64decode(out["audio_base64"]))
print("ok", out.get("sample_rate"))
PY
```

### 8.2. Python

```python
import base64
import os
import time
from pathlib import Path

import requests

API_KEY = os.environ["RUNPOD_API_KEY"]
ENDPOINT = os.environ.get("RUNPOD_ENDPOINT_ID", "3gq6tivo3ms4ls")
BASE = f"https://api.runpod.ai/v2/{ENDPOINT}"


def synthesize(
    text: str,
    *,
    mode: str = "custom_voice",
    language: str = "Auto",
    speaker: str = "Vivian",
    instruct: str = "",
    out_path: str = "out.wav",
    timeout_s: float = 300,
) -> Path:
    payload = {
        "input": {
            "mode": mode,
            "text": text,
            "language": language,
        }
    }
    if mode == "custom_voice":
        payload["input"]["speaker"] = speaker
        if instruct:
            payload["input"]["instruct"] = instruct
    else:
        payload["input"]["instruct"] = instruct

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }

    # Prefer async + poll (ổn định hơn khi cold start)
    r = requests.post(f"{BASE}/run", headers=headers, json=payload, timeout=60)
    r.raise_for_status()
    job_id = r.json()["id"]

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        s = requests.get(f"{BASE}/status/{job_id}", headers=headers, timeout=60)
        s.raise_for_status()
        data = s.json()
        status = data.get("status")
        if status == "COMPLETED":
            out = data.get("output") or {}
            if out.get("error"):
                raise RuntimeError(out["error"])
            path = Path(out_path)
            path.write_bytes(base64.b64decode(out["audio_base64"]))
            return path
        if status in {"FAILED", "CANCELLED", "TIMED_OUT"}:
            raise RuntimeError(f"job {status}: {data}")
        time.sleep(1.5)

    raise TimeoutError(f"job {job_id} not finished in {timeout_s}s")


if __name__ == "__main__":
    p = synthesize(
        "こんにちは！彩りTTSです。",
        language="Japanese",
        speaker="Ono_Anna",
        out_path="ono-anna.wav",
    )
    print("saved", p)
```

```bash
pip install requests
```

### 8.3. JavaScript / TypeScript (Node 18+)

```javascript
const API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT = process.env.RUNPOD_ENDPOINT_ID || "3gq6tivo3ms4ls";
const BASE = `https://api.runpod.ai/v2/${ENDPOINT}`;
const fs = require("fs");

async function synthesizeToFile(input, outPath, { timeoutMs = 300_000 } = {}) {
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  const submit = await fetch(`${BASE}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input }),
  });
  if (!submit.ok) throw new Error(`${submit.status} ${await submit.text()}`);
  const { id } = await submit.json();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await fetch(`${BASE}/status/${id}`, { headers });
    if (!st.ok) throw new Error(`${st.status} ${await st.text()}`);
    const data = await st.json();

    if (data.status === "COMPLETED") {
      if (data.output?.error) throw new Error(data.output.error);
      fs.writeFileSync(outPath, Buffer.from(data.output.audio_base64, "base64"));
      return { path: outPath, jobId: id, sampleRate: data.output.sample_rate };
    }
    if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(data.status)) {
      throw new Error(`job ${data.status}: ${JSON.stringify(data)}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for job ${id}`);
}

synthesizeToFile(
  {
    mode: "custom_voice",
    text: "Hello from Irodori!",
    language: "English",
    speaker: "Ryan",
  },
  "ryan.wav"
).then(console.log).catch(console.error);
```

### 8.4. VoiceDesign nhanh

```bash
curl -X POST "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/runsync" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "mode": "voice_design",
      "text": "Welcome aboard. Your journey begins now.",
      "language": "English",
      "instruct": "Deep confident male narrator, calm studio tone."
    }
  }'
```

---

## 9. Lỗi thường gặp

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `401` / unauthorized | Sai / thiếu `Authorization` | Kiểm tra `RUNPOD_API_KEY` |
| `output.error`: `text is required` | `text` rỗng | Gửi text hợp lệ |
| `instruct is required for voice_design` | Thiếu `instruct` | Bắt buộc với `voice_design` |
| `mode must be 'custom_voice' or 'voice_design'` | Sai `mode` | Chỉ 2 giá trị trên |
| Job lâu `IN_QUEUE` | `workersMin=0` + cold start / GPU throttled | Poll lâu hơn; xem `/health` |
| Worker unhealthy | Image pull / OOM / crash load model | Xem logs endpoint trên console |
| Audio decode fail | Lấy nhầm field | Dùng `output.audio_base64` |

Health nhanh:

```bash
curl -sS "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/health" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}"
```

---

## 10. Latency & timeout

Endpoint hiện cấu hình tiết kiệm: **`workersMin=0`** (scale-to-zero).

| Tình huống | Kỳ vọng |
|---|---|
| Worker ấm, model đã load | Vài giây |
| Cold start (scale từ 0) | Thường 10–60s+ |
| Lần đầu tải weights (chưa cache) | Có thể lâu hơn nữa |

Khuyến nghị client:

- Timeout **≥ 300 giây**
- Ưu tiên `/run` + poll thay vì dựa hoàn toàn vào một lần `/runsync` khi cold start
- UI: hiện trạng thái “đang xếp hàng / đang tạo giọng…”

---

## 11. Bảo mật khi gắn vào web

| Môi trường | Cách làm |
|---|---|
| Backend (Next.js API route, Nest, Laravel, Go…) | Gọi RunPod từ server với `RUNPOD_API_KEY` trong env — **khuyến nghị** |
| Frontend browser / mobile app | **Không** nhúng RunPod key vào bundle. Proxy qua backend của bạn |
| CI / script nội bộ | Env secret / vault |

Không cần OAuth. Chỉ cần giữ API key phía server.

---

## 12. Gateway local (tuỳ chọn)

Nếu muốn lớp API riêng (`IRODORI_API_KEY`, trả binary WAV trực tiếp, Swagger):

| | URL |
|---|---|
| Base | http://localhost:8080 |
| TTS | `POST http://localhost:8080/v1/tts` |
| Meta | `GET http://localhost:8080/v1/meta` |
| Health | `GET http://localhost:8080/health` |
| Swagger | http://localhost:8080/docs |

```bash
cp .env.example .env
# IRODORI_API_KEYS=...
# RUNPOD_API_KEY=...
docker compose up -d --build api
```

Auth gateway:

```http
Authorization: Bearer <IRODORI_API_KEY>
```

hoặc `X-API-Key: <IRODORI_API_KEY>`.

Body gateway (không bọc `input`):

```json
{
  "mode": "custom_voice",
  "text": "こんにちは",
  "language": "Japanese",
  "speaker": "Ono_Anna",
  "response_format": "wav"
}
```

`response_format`: `wav` (binary) | `json` (có `audio_base64`).

> Gateway **không** bắt buộc để tích hợp production nếu backend của bạn gọi thẳng RunPod.

Chi tiết source: [`api/main.py`](../api/main.py), quickstart [`api/README.md`](../api/README.md).

---

## 13. Checklist

1. [ ] Có `RUNPOD_API_KEY` từ console
2. [ ] Gọi `https://api.runpod.ai/v2/3gq6tivo3ms4ls/run` hoặc `/runsync`
3. [ ] Header `Authorization: Bearer ...` (không OAuth)
4. [ ] Payload bọc trong `{ "input": { ... } }`
5. [ ] `custom_voice`: chọn `speaker` đúng ID + `language` phù hợp ([§5](#5-danh-sách-voice-theo-ngôn-ngữ))
6. [ ] `voice_design`: luôn có `instruct`
7. [ ] Decode `output.audio_base64` → WAV
8. [ ] Timeout / poll ≥ 300s khi cold start
9. [ ] Không lộ key ra frontend

---

## Liên kết

| Tài nguyên | URL |
|---|---|
| GitHub repo | https://github.com/MinhMarino/Irodori-TTS |
| Docs này | https://github.com/MinhMarino/Irodori-TTS/blob/main/docs/API.md |
| Worker | [`worker/README.md`](../worker/README.md) |
| Image GHCR | https://ghcr.io/minhmarino/irodori-tts-worker:1.7b-dual |
| Model CustomVoice | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice |
| Model VoiceDesign | https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign |
| Qwen CustomVoice guide | https://qwenlm-qwen3-tts.mintlify.app/guides/custom-voice |
| RunPod endpoint | https://console.runpod.io/serverless/user/endpoint/3gq6tivo3ms4ls |
| RunPod API keys | https://console.runpod.io/user/settings?tab=api-keys |
