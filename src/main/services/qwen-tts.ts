import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_QWEN_TTS_MODEL, DEFAULT_RUNPOD_ENDPOINT_ID } from '../../shared/types';
import {
  buildQwenTtsInstructions,
  resolveQwenLanguageType,
  resolveQwenTtsVoice,
  toIrodoriSpeakerId,
} from '../../shared/voice';
import { concatAudioFiles, convertAudioToMp3 } from './ffmpeg';
import {
  buildContinuousNarrationText,
  type SceneNarrationInput,
  type TranscriptWord,
  transcribeWithWords,
} from './openai-audio';

/** Irodori: ưu tiên ít request — text dài 1 job thường ổn định hơn nhiều chunk + cold start. */
const MAX_CHARS_PER_REQUEST = 4000;
const POLL_INTERVAL_MS = 2000;
/** Cold start Qwen3 1.7B có thể >5 phút khi workersMin=0. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** Retry 1 lần nếu job kẹt IN_QUEUE quá lâu / timeout. */
const MAX_SUBMIT_ATTEMPTS = 2;
const STUCK_IN_QUEUE_MS = 240_000;

/**
 * Session TTS liên tiếp: giữ worker ấm 60–120s thay vì idle mặc định 5s.
 * Nhiều câu liên tiếp → 1 cold start thay vì N lần (thường rẻ hơn idle=5).
 */
const SESSION_IDLE_TIMEOUT_SEC = 90;
const SESSION_WINDOW_MS = SESSION_IDLE_TIMEOUT_SEC * 1000;
const JOB_POLICY = {
  executionTimeout: 900_000,
  ttl: 3_600_000,
} as const;

type RunPodStatus =
  | 'IN_QUEUE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | string;

type RunPodJobResponse = {
  id?: string;
  status?: RunPodStatus;
  delayTime?: number;
  executionTime?: number;
  output?: {
    mode?: string;
    language?: string;
    speaker?: string;
    sample_rate?: number;
    format?: string;
    audio_base64?: string;
    instruct?: string | null;
    error?: string;
    loaded_modes?: string[];
  };
  error?: string;
};

/** Chia text dài theo câu / khoảng trắng. */
export function chunkTextForQwenTts(text: string, maxChars = MAX_CHARS_PER_REQUEST): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const breakAt = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf(', '),
      window.lastIndexOf('、'),
      window.lastIndexOf(' ')
    );
    const cut = breakAt > maxChars * 0.4 ? breakAt + 1 : maxChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runpodBaseUrl(endpointId: string): string {
  const id = endpointId.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  return `https://api.runpod.ai/v2/${id}`;
}

/**
 * Hàng đợi session toàn cục: serialize mọi job Irodori.
 * Tránh 5 request song song → 5 cold start khi workersMin=0.
 */
class IrodoriSessionQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastActivityAt = 0;
  /** endpointId → thời điểm đã ensure idleTimeout (ms). */
  private idleEnsuredUntil = new Map<string, number>();

  get isWarmSession(): boolean {
    return Date.now() - this.lastActivityAt < SESSION_WINDOW_MS;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  /** Chạy tuần tự trong session — mọi TTS đi qua đây. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Khi session có ≥2 job (chunk dài / generate liên tiếp),
   * cố gắng đẩy idleTimeout endpoint lên ~90s (best-effort).
   */
  async prepareSession(options: {
    apiKey: string;
    endpointId: string;
    jobCount: number;
  }): Promise<void> {
    const { apiKey, endpointId, jobCount } = options;
    const multi = jobCount >= 2 || this.isWarmSession;
    if (!multi) return;

    const until = this.idleEnsuredUntil.get(endpointId) || 0;
    if (Date.now() < until) return;

    await ensureEndpointIdleTimeout(apiKey, endpointId, SESSION_IDLE_TIMEOUT_SEC);
    this.idleEnsuredUntil.set(endpointId, Date.now() + SESSION_WINDOW_MS);
  }
}

const irodoriSession = new IrodoriSessionQueue();

/**
 * PATCH idleTimeout qua RunPod REST (cần key sở hữu endpoint).
 * Endpoint shared / không đủ quyền → bỏ qua, vẫn serialize client-side.
 */
async function ensureEndpointIdleTimeout(
  apiKey: string,
  endpointId: string,
  idleTimeoutSec: number
): Promise<boolean> {
  const id = endpointId.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  try {
    const res = await fetch(`https://rest.runpod.io/v1/endpoints/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ idleTimeout: idleTimeoutSec }),
    });
    if (res.ok) return true;
    // 401/403/404: không phải owner / endpoint public — bình thường.
    return false;
  } catch {
    return false;
  }
}

async function runpodFetchJson(
  url: string,
  apiKey: string,
  init?: RequestInit
): Promise<RunPodJobResponse> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: RunPodJobResponse = {};
  try {
    body = text ? (JSON.parse(text) as RunPodJobResponse) : {};
  } catch {
    body = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        'Irodori TTS: RunPod từ chối API key (401). Cần RUNPOD_API_KEY từ https://console.runpod.io/user/settings?tab=api-keys (thường bắt đầu bằng rp_…). Key IRODORI_API_KEYS chỉ dùng cho gateway local, không gọi được api.runpod.ai.'
      );
    }
    throw new Error(
      `Irodori TTS failed: HTTP ${res.status} ${body.error || body.output?.error || text.slice(0, 300)}`.trim()
    );
  }
  return body;
}

async function cancelRunPodJob(
  baseUrl: string,
  apiKey: string,
  jobId: string
): Promise<void> {
  try {
    await fetch(`${baseUrl}/cancel/${jobId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  } catch {
    /* ignore */
  }
}

async function waitForRunPodJob(options: {
  apiKey: string;
  baseUrl: string;
  jobId: string;
  timeoutMs?: number;
}): Promise<RunPodJobResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastStatus = '';

  while (Date.now() < deadline) {
    const data = await runpodFetchJson(
      `${options.baseUrl}/status/${options.jobId}`,
      options.apiKey
    );
    const status = data.status || '';
    lastStatus = status;

    if (status === 'COMPLETED') {
      if (data.output?.error) {
        throw new Error(`Irodori TTS: ${data.output.error}`);
      }
      if (!data.output?.audio_base64?.trim()) {
        throw new Error(
          `Irodori TTS: phản hồi COMPLETED nhưng thiếu audio_base64 (${JSON.stringify(data).slice(0, 300)})`
        );
      }
      return data;
    }
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
      throw new Error(
        `Irodori TTS job ${status}: ${data.error || data.output?.error || JSON.stringify(data).slice(0, 300)}`
      );
    }

    // Kẹt IN_QUEUE quá lâu (worker không lên) → abort sớm để retry submit.
    if (status === 'IN_QUEUE' && Date.now() - startedAt > STUCK_IN_QUEUE_MS) {
      await cancelRunPodJob(options.baseUrl, options.apiKey, options.jobId);
      throw new Error(
        `Irodori TTS: job ${options.jobId} kẹt IN_QUEUE >${Math.round(STUCK_IN_QUEUE_MS / 1000)}s (worker chưa nhận). Thử submit lại.`
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  await cancelRunPodJob(options.baseUrl, options.apiKey, options.jobId);
  throw new Error(
    `Irodori TTS: timeout chờ job ${options.jobId} (>${Math.round(timeoutMs / 1000)}s, status cuối: ${lastStatus || 'unknown'}). Endpoint đang cold start / hết worker — Generate lại sau 30–60s.`
  );
}

async function submitAndWaitTts(options: {
  apiKey: string;
  baseUrl: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<RunPodJobResponse> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    try {
      const submitted = await runpodFetchJson(`${options.baseUrl}/run`, options.apiKey, {
        method: 'POST',
        body: JSON.stringify({ input: options.input, policy: { ...JOB_POLICY } }),
      });

      if (submitted.status === 'COMPLETED' && submitted.output?.audio_base64) {
        if (submitted.output.error) throw new Error(`Irodori TTS: ${submitted.output.error}`);
        return submitted;
      }
      if (!submitted.id) {
        throw new Error(
          `Irodori TTS: không nhận được job id (${JSON.stringify(submitted).slice(0, 300)})`
        );
      }

      // Lần đầu cold: cho full timeout; lần retry cũng full (worker có thể đã warm hơn).
      return await waitForRunPodJob({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        jobId: submitted.id,
        timeoutMs: options.timeoutMs,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const retryable = /timeout|IN_QUEUE|kẹt IN_QUEUE/i.test(lastError.message);
      if (!retryable || attempt >= MAX_SUBMIT_ATTEMPTS) break;
      await sleep(3000 * attempt);
    }
  }

  throw lastError || new Error('Irodori TTS: thất bại không rõ nguyên nhân');
}

async function synthesizeOneChunk(options: {
  apiKey: string;
  endpointId: string;
  text: string;
  speaker: string;
  language: string;
  instruct?: string;
  outPath: string;
  timeoutMs?: number;
}): Promise<void> {
  await irodoriSession.enqueue(async () => {
    const baseUrl = runpodBaseUrl(options.endpointId);
    const input: Record<string, unknown> = {
      mode: 'custom_voice',
      text: options.text,
      language: options.language || 'Auto',
      speaker: toIrodoriSpeakerId(options.speaker),
    };
    if (options.instruct?.trim()) {
      input.instruct = options.instruct.trim();
    }

    const completed = await submitAndWaitTts({
      apiKey: options.apiKey,
      baseUrl,
      input,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const audioB64 = completed.output?.audio_base64;
    if (!audioB64?.trim()) {
      throw new Error('Irodori TTS: thiếu audio_base64 trong output');
    }

    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, Buffer.from(audioB64, 'base64'));
    irodoriSession.touch();
  });
}

export async function synthesizeWithQwen(options: {
  apiKey: string;
  text: string;
  voice: string;
  model?: string;
  languageType?: string;
  endpointId?: string;
  outDir: string;
  fileName?: string;
}): Promise<string> {
  const trimmed = options.text.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Irodori TTS: empty text');
  if (!options.apiKey?.trim()) throw new Error('Thiếu RunPod API key (Irodori TTS).');

  const languageType = options.languageType || 'Auto';
  const voice = resolveQwenTtsVoice(options.voice, languageType, options.model);
  const instructions = buildQwenTtsInstructions(voice, languageType);
  const endpointId = options.endpointId?.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  const apiKey = options.apiKey.trim();
  const workDir = path.join(options.outDir, `.irodori-tts-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const chunks = chunkTextForQwenTts(trimmed);
  const chunkPaths: string[] = [];

  // Luôn thử bump idle khi bắt đầu TTS (kể cả 1 chunk) — giảm cold start lần sau.
  await irodoriSession.prepareSession({
    apiKey,
    endpointId,
    jobCount: Math.max(2, chunks.length),
  });

  try {
    for (let i = 0; i < chunks.length; i++) {
      const wavPath = path.join(workDir, `chunk-${String(i).padStart(3, '0')}.wav`);
      await synthesizeOneChunk({
        apiKey,
        endpointId,
        text: chunks[i],
        speaker: voice,
        language: languageType,
        instruct: instructions,
        outPath: wavPath,
      });
      chunkPaths.push(wavPath);
    }

    const audioPath = path.join(options.outDir, options.fileName || 'narration.mp3');
    if (chunkPaths.length === 1) {
      await convertAudioToMp3(chunkPaths[0], audioPath);
    } else {
      await concatAudioFiles(chunkPaths, audioPath, workDir);
    }
    return audioPath;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function synthesizeContinuousNarrationWithQwen(options: {
  runpodApiKey: string;
  openaiApiKey?: string;
  scenes: SceneNarrationInput[];
  voice: string;
  model?: string;
  languageType?: string;
  endpointId?: string;
  language?: string;
  outDir: string;
  fileName?: string;
}): Promise<{ audioPath: string; srtPath: string; words: TranscriptWord[] }> {
  const text = buildContinuousNarrationText(options.scenes);
  if (!text) throw new Error('Kịch bản chưa có lời thoại để tạo voiceover.');

  const languageType = resolveQwenLanguageType(options.languageType, options.language);
  const audioPath = await synthesizeWithQwen({
    apiKey: options.runpodApiKey,
    text,
    voice: options.voice,
    model: options.model || DEFAULT_QWEN_TTS_MODEL,
    languageType,
    endpointId: options.endpointId,
    outDir: options.outDir,
    fileName: options.fileName,
  });

  if (options.openaiApiKey?.trim()) {
    const { srtPath, words } = await transcribeWithWords({
      apiKey: options.openaiApiKey.trim(),
      audioPath,
      language: options.language,
      outDir: options.outDir,
    });
    return { audioPath, srtPath, words };
  }

  const srtPath = path.join(options.outDir, 'subs.srt');
  if (!fs.existsSync(srtPath)) {
    fs.writeFileSync(srtPath, `1\n00:00:00,000 --> 00:00:02,000\n${text.slice(0, 80)}\n`, 'utf8');
  }
  return { audioPath, srtPath, words: [] };
}

export async function testQwenTts(options: {
  apiKey: string;
  endpointId?: string;
  voice?: string;
  languageType?: string;
}): Promise<{ ok: boolean; message: string }> {
  let apiKey = options.apiKey?.trim() || '';
  // User đôi khi dán kèm "Bearer " hoặc khoảng trắng/newline.
  apiKey = apiKey.replace(/^bearer\s+/i, '').trim();
  if (!apiKey) {
    return { ok: false, message: 'Chưa nhập RunPod API key.' };
  }
  if (/^sk-/i.test(apiKey) || apiKey.length < 20) {
    return {
      ok: false,
      message:
        'Key có vẻ không phải RunPod API key. Vào https://console.runpod.io/user/settings?tab=api-keys tạo key (thường bắt đầu bằng rp_…).',
    };
  }

  const endpointId = options.endpointId?.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  const baseUrl = runpodBaseUrl(endpointId);
  const speaker = toIrodoriSpeakerId(options.voice || 'Ryan');
  const language = options.languageType || 'English';

  try {
    const health = await runpodFetchJson(`${baseUrl}/health`, apiKey);
    const workers = (health as { workers?: { idle?: number; running?: number } }).workers;
    const healthHint =
      workers != null
        ? `workers idle=${workers.idle ?? '?'} running=${workers.running ?? '?'}`
        : `health ok`;

    // Kiểm tra inference thật — ghi WAV, không cần FFmpeg (tránh fail test vì ffmpeg).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapgen-irodori-'));
    const wavPath = path.join(tmpDir, 'test.wav');
    try {
      await synthesizeOneChunk({
        apiKey,
        endpointId,
        text: 'Hi.',
        speaker,
        language,
        outPath: wavPath,
        timeoutMs: 420_000,
      });
      const size = fs.statSync(wavPath).size;
      if (size < 100) {
        return { ok: false, message: `Irodori trả file quá nhỏ (${size} bytes).` };
      }
      return {
        ok: true,
        message: `Irodori TTS OK — endpoint ${endpointId}, speaker ${speaker}, WAV ${size} bytes. (${healthHint})`,
      };
    } catch (synthErr) {
      const synthMsg = synthErr instanceof Error ? synthErr.message : String(synthErr);
      // Key hợp lệ (health OK) nhưng worker cold / timeout — vẫn coi là kết nối được.
      if (/timeout|IN_QUEUE|cold/i.test(synthMsg)) {
        return {
          ok: true,
          message: `RunPod key hợp lệ (${healthHint}). TTS chưa xong kịp (cold start) — thử lại sau 30–60s khi worker ấm. Chi tiết: ${synthMsg}`,
        };
      }
      return {
        ok: false,
        message: `Key/health OK nhưng TTS lỗi: ${synthMsg}`,
      };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg };
  }
}
