import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_QWEN_TTS_MODEL, DEFAULT_RUNPOD_ENDPOINT_ID } from '../../shared/types';
import {
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

/**
 * Chunk vừa phải: text quá dài dễ làm worker treo IN_PROGRESS (OOM / hang inference).
 * Nhiều chunk ngắn + worker ấm thường ổn định hơn 1 job 6000 ký tự.
 */
const MAX_CHARS_PER_REQUEST = 1400;
/** Poll nhanh hơn khi job đang chạy. */
const POLL_QUEUE_MS = 1000;
const POLL_PROGRESS_MS = 500;
/** Timeout tổng mỗi job (queue + inference). */
const DEFAULT_TIMEOUT_MS = 360_000;
/** Retry nếu kẹt queue / treo progress / timeout. */
const MAX_SUBMIT_ATTEMPTS = 3;
const STUCK_IN_QUEUE_MS = 120_000;
/** Inference TTS bình thường không nên > ~2.5 phút khi đã IN_PROGRESS. */
const STUCK_IN_PROGRESS_MS = 150_000;
/** runsync chỉ khi có worker idle thật (không dùng "running" — có thể đang treo). */
const RUNSYNC_WARM_TIMEOUT_MS = 75_000;

/**
 * Session TTS liên tiếp: giữ worker ấm 60–120s thay vì idle mặc định 5s.
 */
const SESSION_IDLE_TIMEOUT_SEC = 120;
const SESSION_WINDOW_MS = SESSION_IDLE_TIMEOUT_SEC * 1000;
const JOB_POLICY = {
  executionTimeout: 300_000,
  ttl: 1_800_000,
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
   * Bump idleTimeout best-effort — không chặn TTS (fire-and-forget).
   */
  prepareSession(options: {
    apiKey: string;
    endpointId: string;
    jobCount: number;
  }): void {
    const { apiKey, endpointId, jobCount } = options;
    const multi = jobCount >= 1 || this.isWarmSession;
    if (!multi) return;

    const until = this.idleEnsuredUntil.get(endpointId) || 0;
    if (Date.now() < until) return;

    this.idleEnsuredUntil.set(endpointId, Date.now() + SESSION_WINDOW_MS);
    void ensureEndpointIdleTimeout(apiKey, endpointId, SESSION_IDLE_TIMEOUT_SEC);
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
  let progressSince = 0;
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

    if (status === 'IN_PROGRESS') {
      if (!progressSince) progressSince = Date.now();
      if (Date.now() - progressSince > STUCK_IN_PROGRESS_MS) {
        await cancelRunPodJob(options.baseUrl, options.apiKey, options.jobId);
        throw new Error(
          `Irodori TTS: job ${options.jobId} treo IN_PROGRESS >${Math.round(STUCK_IN_PROGRESS_MS / 1000)}s (worker nhận việc nhưng không trả audio). Thử lại với đoạn ngắn hơn.`
        );
      }
    } else {
      progressSince = 0;
    }

    // Kẹt IN_QUEUE quá lâu (worker không lên) → abort sớm để retry submit.
    if (status === 'IN_QUEUE' && Date.now() - startedAt > STUCK_IN_QUEUE_MS) {
      await cancelRunPodJob(options.baseUrl, options.apiKey, options.jobId);
      throw new Error(
        `Irodori TTS: job ${options.jobId} kẹt IN_QUEUE >${Math.round(STUCK_IN_QUEUE_MS / 1000)}s (worker chưa nhận). Thử submit lại.`
      );
    }

    await sleep(status === 'IN_PROGRESS' ? POLL_PROGRESS_MS : POLL_QUEUE_MS);
  }

  await cancelRunPodJob(options.baseUrl, options.apiKey, options.jobId);
  throw new Error(
    `Irodori TTS: timeout chờ job ${options.jobId} (>${Math.round(timeoutMs / 1000)}s, status cuối: ${lastStatus || 'unknown'}). Endpoint đang cold start / worker treo — Generate lại sau 30–60s.`
  );
}

async function getWorkerWarmth(
  baseUrl: string,
  apiKey: string
): Promise<{ warm: boolean; idle: number; running: number }> {
  try {
    const health = (await runpodFetchJson(`${baseUrl}/health`, apiKey)) as {
      workers?: { idle?: number; running?: number };
    };
    const idle = Number(health.workers?.idle ?? 0);
    const running = Number(health.workers?.running ?? 0);
    // Chỉ idle mới chắc worker sẵn sàng — "running" có thể là job đang treo.
    return { warm: idle > 0, idle, running };
  } catch {
    return { warm: false, idle: 0, running: 0 };
  }
}

async function submitAndWaitTts(options: {
  apiKey: string;
  baseUrl: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<RunPodJobResponse> {
  let lastError: Error | null = null;
  const payload = { input: options.input, policy: { ...JOB_POLICY } };

  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    try {
      const { warm } = await getWorkerWarmth(options.baseUrl, options.apiKey);

      // Worker idle thật → /runsync nhanh. Không dùng khi chỉ có "running".
      if (warm) {
        try {
          const syncRes = await runpodFetchJson(`${options.baseUrl}/runsync`, options.apiKey, {
            method: 'POST',
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(RUNSYNC_WARM_TIMEOUT_MS),
          });
          if (syncRes.status === 'COMPLETED' && syncRes.output?.audio_base64) {
            if (syncRes.output.error) throw new Error(`Irodori TTS: ${syncRes.output.error}`);
            return syncRes;
          }
          if (syncRes.id && (syncRes.status === 'IN_QUEUE' || syncRes.status === 'IN_PROGRESS')) {
            return await waitForRunPodJob({
              apiKey: options.apiKey,
              baseUrl: options.baseUrl,
              jobId: syncRes.id,
              timeoutMs: options.timeoutMs,
            });
          }
        } catch (syncErr) {
          const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
          if (!/abort|timeout|TimeoutError|treo IN_PROGRESS|kẹt IN_QUEUE/i.test(msg) && !/HTTP 5\d\d/.test(msg)) {
            if (/401|403|invalid|required/i.test(msg)) throw syncErr;
          }
        }
      }

      const submitted = await runpodFetchJson(`${options.baseUrl}/run`, options.apiKey, {
        method: 'POST',
        body: JSON.stringify(payload),
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

      return await waitForRunPodJob({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        jobId: submitted.id,
        timeoutMs: options.timeoutMs,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const retryable =
        /timeout|IN_QUEUE|kẹt IN_QUEUE|treo IN_PROGRESS|abort/i.test(lastError.message);
      if (!retryable || attempt >= MAX_SUBMIT_ATTEMPTS) break;
      await sleep(2500 * attempt);
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
  // Không gửi instruct mặc định — giảm tải / tránh hang trên worker yếu.
  const endpointId = options.endpointId?.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  const apiKey = options.apiKey.trim();
  const workDir = path.join(options.outDir, `.irodori-tts-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  let chunks = chunkTextForQwenTts(trimmed);
  const chunkPaths: string[] = [];

  irodoriSession.prepareSession({
    apiKey,
    endpointId,
    jobCount: Math.max(1, chunks.length),
  });

  try {
    for (let i = 0; i < chunks.length; i++) {
      const wavPath = path.join(workDir, `chunk-${String(i).padStart(3, '0')}.wav`);
      try {
        await synthesizeOneChunk({
          apiKey,
          endpointId,
          text: chunks[i],
          speaker: voice,
          language: languageType,
          outPath: wavPath,
        });
      } catch (chunkErr) {
        const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
        // Chunk vẫn dài và treo → tách nhỏ hơn rồi chạy tiếp.
        if (/treo IN_PROGRESS|timeout/i.test(msg) && chunks[i].length > 500) {
          const smaller = chunkTextForQwenTts(chunks[i], 700);
          if (smaller.length > 1) {
            const rest = chunks.slice(i + 1);
            chunks = [...chunks.slice(0, i), ...smaller, ...rest];
            i -= 1;
            continue;
          }
        }
        throw chunkErr;
      }
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
  /** Mặc định false — Whisper làm chậm nhiều; timing theo tỉ lệ ký tự đủ dùng. */
  useWhisper?: boolean;
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

  // Whisper sau TTS rất chậm — chỉ bật khi explicitly yêu cầu.
  if (options.useWhisper && options.openaiApiKey?.trim()) {
    const { srtPath, words } = await transcribeWithWords({
      apiKey: options.openaiApiKey.trim(),
      audioPath,
      language: options.language,
      outDir: options.outDir,
    });
    return { audioPath, srtPath, words };
  }

  // SRT đơn giản theo scene + tỉ lệ ký tự (computeSceneTimings fallback).
  const srtPath = path.join(options.outDir, 'subs.srt');
  const lines = options.scenes
    .map((scene, idx) => {
      const seg = String(scene.narration_segment || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!seg) return '';
      return `${idx + 1}\n00:00:00,000 --> 00:00:02,000\n${seg.slice(0, 120)}\n`;
    })
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(srtPath, lines || `1\n00:00:00,000 --> 00:00:02,000\n${text.slice(0, 80)}\n`, 'utf8');
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
