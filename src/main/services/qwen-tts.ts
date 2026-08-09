import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chunkNarrationText,
  planNarrationTtsChunks,
  type NarrationChunkPlan,
} from '../../shared/narration-chunks';
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
import { runPool } from './worker-pool';

/**
 * Chunk vừa phải: text quá dài dễ treo; quá ít chunk thì không lấp đủ 10 worker.
 * Adaptive re-chunk trong synthesizeWithQwen khi script dài.
 */
const MAX_CHARS_PER_REQUEST = 900;
const MIN_CHARS_PER_REQUEST = 420;
/** Poll nhanh hơn khi job đang chạy. */
const POLL_QUEUE_MS = 800;
const POLL_PROGRESS_MS = 400;
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
 * Song song tối đa 10 — khớp workersMax endpoint (mục tiêu ~1 phút / 10 phút audio).
 * Script ngắn (1 chunk) vẫn concurrency=1.
 */
const DEFAULT_TTS_CONCURRENCY = 10;
const MAX_TTS_CONCURRENCY = 10;

/** Worker phụ idle 90s rồi scale xuống — sau burst dài không giữ 10 GPU. */
const SESSION_IDLE_TIMEOUT_SEC = 90;
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

/** Chia text dài theo câu / scene (shared planner). */
export function chunkTextForQwenTts(text: string, maxChars = MAX_CHARS_PER_REQUEST): string[] {
  return chunkNarrationText(text, maxChars);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runpodBaseUrl(endpointId: string): string {
  const id = endpointId.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  return `https://api.runpod.ai/v2/${id}`;
}

/**
 * Gate toàn cục: tối đa N job Irodori cùng lúc (chia sẻ giữa mọi lần TTS).
 * N khớp workersMax — tránh queue dài / cold start thừa.
 */
class IrodoriSessionQueue {
  private active = 0;
  private limit = 1;
  private waiters: Array<() => void> = [];
  private lastActivityAt = 0;
  /** endpointId → thời điểm đã ensure idleTimeout (ms). */
  private idleEnsuredUntil = new Map<string, number>();
  /** endpointId → workersMax đã cache. */
  private workersMaxCache = new Map<string, { max: number; until: number }>();

  get isWarmSession(): boolean {
    return Date.now() - this.lastActivityAt < SESSION_WINDOW_MS;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  setConcurrency(n: number): void {
    this.limit = Math.max(1, Math.min(MAX_TTS_CONCURRENCY, Math.floor(n) || 1));
    this.drain();
  }

  get concurrency(): number {
    return this.limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.touch();
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }

  /** Bump idleTimeout best-effort — không chặn TTS. */
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

  async resolveConcurrency(options: {
    apiKey: string;
    endpointId: string;
    chunkCount: number;
  }): Promise<number> {
    const chunkCount = Math.max(1, options.chunkCount);
    if (chunkCount <= 1) {
      this.setConcurrency(1);
      return 1;
    }

    let workersMax = DEFAULT_TTS_CONCURRENCY;
    const cached = this.workersMaxCache.get(options.endpointId);
    if (cached && Date.now() < cached.until) {
      workersMax = cached.max;
    } else {
      const fetched = await fetchEndpointWorkersMax(options.apiKey, options.endpointId);
      if (fetched != null && fetched > 0) {
        workersMax = fetched;
        this.workersMaxCache.set(options.endpointId, {
          max: fetched,
          until: Date.now() + 5 * 60_000,
        });
      }
    }

    // Không cap bởi DEFAULT — DEFAULT chỉ là fallback khi chưa đọc được workersMax.
    const concurrency = Math.max(
      1,
      Math.min(MAX_TTS_CONCURRENCY, workersMax, chunkCount)
    );
    this.setConcurrency(concurrency);
    return concurrency;
  }

  /** workersMax đã biết (hoặc DEFAULT) — dùng để lên kế hoạch số chunk. */
  async peekWorkersMax(apiKey: string, endpointId: string): Promise<number> {
    const cached = this.workersMaxCache.get(endpointId);
    if (cached && Date.now() < cached.until) return cached.max;
    const fetched = await fetchEndpointWorkersMax(apiKey, endpointId);
    if (fetched != null && fetched > 0) {
      this.workersMaxCache.set(endpointId, { max: fetched, until: Date.now() + 5 * 60_000 });
      return fetched;
    }
    return DEFAULT_TTS_CONCURRENCY;
  }
}

/** Chia theo script + tận dụng song song khi script đủ dài. */
function planChunksForParallel(options: {
  text: string;
  scenes?: SceneNarrationInput[];
  targetParallel: number;
}): NarrationChunkPlan[] {
  const { text, scenes } = options;
  const parallel = Math.max(1, Math.min(MAX_TTS_CONCURRENCY, options.targetParallel));
  let plans = planNarrationTtsChunks({
    scenes,
    text,
    maxChars: MAX_CHARS_PER_REQUEST,
  });
  if (plans.length >= parallel || text.length < MIN_CHARS_PER_REQUEST * 2) {
    return plans;
  }
  // Ít chunk hơn worker → giảm maxChars để lấp pipeline (mục tiêu ~1 wave).
  const targetChars = Math.max(
    MIN_CHARS_PER_REQUEST,
    Math.min(MAX_CHARS_PER_REQUEST, Math.ceil(text.length / parallel))
  );
  return planNarrationTtsChunks({ scenes, text, maxChars: targetChars });
}

const irodoriSession = new IrodoriSessionQueue();

/** Đọc workersMax từ REST (owner key). Fail → dùng DEFAULT. */
async function fetchEndpointWorkersMax(
  apiKey: string,
  endpointId: string
): Promise<number | null> {
  const id = endpointId.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  try {
    const res = await fetch(`https://rest.runpod.io/v1/endpoints/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      workers?: { max?: number };
      workersMax?: number;
    };
    const max = Number(data.workers?.max ?? data.workersMax ?? 0);
    return Number.isFinite(max) && max > 0 ? max : null;
  } catch {
    return null;
  }
}

/**
 * PATCH idleTimeout qua RunPod REST (cần key sở hữu endpoint).
 * Endpoint shared / không đủ quyền → bỏ qua; client vẫn tự giới hạn concurrency.
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
  /** Song song: bỏ /runsync (cần idle) — chỉ /run + poll để scale đủ worker. */
  preferAsync?: boolean;
}): Promise<RunPodJobResponse> {
  let lastError: Error | null = null;
  const payload = { input: options.input, policy: { ...JOB_POLICY } };

  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
    try {
      // 1 job đơn + worker idle → /runsync nhanh hơn. Parallel thì luôn /run.
      if (!options.preferAsync) {
        const { warm } = await getWorkerWarmth(options.baseUrl, options.apiKey);
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
            if (
              !/abort|timeout|TimeoutError|treo IN_PROGRESS|kẹt IN_QUEUE/i.test(msg) &&
              !/HTTP 5\d\d/.test(msg)
            ) {
              if (/401|403|invalid|required/i.test(msg)) throw syncErr;
            }
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
  preferAsync?: boolean;
}): Promise<void> {
  await irodoriSession.run(async () => {
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
      preferAsync: options.preferAsync,
    });

    const audioB64 = completed.output?.audio_base64;
    if (!audioB64?.trim()) {
      throw new Error('Irodori TTS: thiếu audio_base64 trong output');
    }

    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, Buffer.from(audioB64, 'base64'));
  });
}

/** Synthesize 1 đoạn; treo/timeout + text dài → tách nhỏ rồi ghép path theo thứ tự. */
async function synthesizeChunkResilient(options: {
  apiKey: string;
  endpointId: string;
  text: string;
  speaker: string;
  language: string;
  instruct?: string;
  workDir: string;
  filePrefix: string;
  preferAsync?: boolean;
  maxChars?: number;
}): Promise<string[]> {
  const wavPath = path.join(options.workDir, `${options.filePrefix}.wav`);
  try {
    await synthesizeOneChunk({
      apiKey: options.apiKey,
      endpointId: options.endpointId,
      text: options.text,
      speaker: options.speaker,
      language: options.language,
      instruct: options.instruct,
      outPath: wavPath,
      preferAsync: options.preferAsync,
    });
    return [wavPath];
  } catch (chunkErr) {
    const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
    const maxChars = options.maxChars ?? MAX_CHARS_PER_REQUEST;
    if (/treo IN_PROGRESS|timeout/i.test(msg) && options.text.length > 500 && maxChars > 500) {
      const smaller = chunkTextForQwenTts(options.text, Math.max(500, Math.floor(maxChars / 2)));
      if (smaller.length > 1) {
        const paths: string[] = [];
        for (let s = 0; s < smaller.length; s++) {
          const partPaths = await synthesizeChunkResilient({
            ...options,
            text: smaller[s],
            filePrefix: `${options.filePrefix}-s${String(s).padStart(2, '0')}`,
            maxChars: Math.max(500, Math.floor(maxChars / 2)),
          });
          paths.push(...partPaths);
        }
        return paths;
      }
    }
    throw chunkErr;
  }
}

export type QwenTtsProgress = {
  phase: 'chunks' | 'concat';
  chunksDone: number;
  chunksTotal: number;
  concurrency: number;
};

export async function synthesizeWithQwen(options: {
  apiKey: string;
  text: string;
  /** Khi có scenes — cắt theo scene/câu rồi nối có pause ngắn. */
  scenes?: SceneNarrationInput[];
  voice: string;
  model?: string;
  languageType?: string;
  endpointId?: string;
  /** Instruct đã ghép (preset tốc độ + custom). Chỉ gửi khi có nội dung. */
  instruct?: string;
  outDir: string;
  fileName?: string;
  onProgress?: (info: QwenTtsProgress) => void;
}): Promise<string> {
  const trimmed = options.text.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Irodori TTS: empty text');
  if (!options.apiKey?.trim()) throw new Error('Thiếu RunPod API key (Irodori TTS).');

  const languageType = options.languageType || 'Auto';
  const voice = resolveQwenTtsVoice(options.voice, languageType, options.model);
  const instruct = options.instruct?.trim() || '';
  const endpointId = options.endpointId?.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
  const apiKey = options.apiKey.trim();
  const workDir = path.join(options.outDir, `.irodori-tts-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const workersMax = await irodoriSession.peekWorkersMax(apiKey, endpointId);
  const targetParallel = Math.min(MAX_TTS_CONCURRENCY, workersMax);
  const chunkPlans = planChunksForParallel({
    text: trimmed,
    scenes: options.scenes,
    targetParallel,
  });
  const chunks = chunkPlans.map((c) => c.text);
  if (!chunks.length) throw new Error('Irodori TTS: empty text');

  irodoriSession.prepareSession({
    apiKey,
    endpointId,
    jobCount: Math.max(1, chunks.length),
  });

  const concurrency = await irodoriSession.resolveConcurrency({
    apiKey,
    endpointId,
    chunkCount: chunks.length,
  });
  const preferAsync = concurrency > 1;
  const report = (info: QwenTtsProgress) => {
    try {
      options.onProgress?.(info);
    } catch {
      /* UI progress must not break TTS */
    }
  };

  try {
    report({
      phase: 'chunks',
      chunksDone: 0,
      chunksTotal: chunks.length,
      concurrency,
    });

    let chunksDone = 0;
    const settled = await runPool(
      chunks.map((text, i) => async () =>
        synthesizeChunkResilient({
          apiKey,
          endpointId,
          text,
          speaker: voice,
          language: languageType,
          instruct: instruct || undefined,
          workDir,
          filePrefix: `chunk-${String(i).padStart(3, '0')}`,
          preferAsync,
        })
      ),
      {
        concurrency,
        onSettled: () => {
          chunksDone += 1;
          report({
            phase: 'chunks',
            chunksDone,
            chunksTotal: chunks.length,
            concurrency,
          });
        },
      }
    );

    const chunkPaths: string[] = [];
    // resilient có thể tách 1 chunk thành nhiều file — giãn pause theo số file con.
    const pauseAfterMs: number[] = [];
    for (let i = 0; i < settled.length; i++) {
      const item = settled[i];
      if (item.status === 'rejected') {
        const reason = item.reason instanceof Error ? item.reason.message : String(item.reason);
        throw new Error(`Irodori TTS: chunk ${i + 1}/${chunks.length} lỗi — ${reason}`);
      }
      const parts = item.value;
      chunkPaths.push(...parts);
      const plannedPause = chunkPlans[i]?.pauseAfterMs || 0;
      for (let p = 0; p < parts.length; p++) {
        pauseAfterMs.push(p === parts.length - 1 ? plannedPause : 60);
      }
    }

    report({
      phase: 'concat',
      chunksDone: chunks.length,
      chunksTotal: chunks.length,
      concurrency,
    });

    const audioPath = path.join(options.outDir, options.fileName || 'narration.mp3');
    if (chunkPaths.length === 1) {
      await convertAudioToMp3(chunkPaths[0], audioPath);
    } else {
      await concatAudioFiles(chunkPaths, audioPath, workDir, { pauseAfterMs });
    }
    return audioPath;
  } finally {
    // Sau batch dài: hạ gate về 1 để job lẻ (test / script ngắn) dùng runsync.
    irodoriSession.setConcurrency(1);
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
  instruct?: string;
  language?: string;
  outDir: string;
  fileName?: string;
  /** Mặc định false — Whisper làm chậm nhiều; timing theo tỉ lệ ký tự đủ dùng. */
  useWhisper?: boolean;
  onProgress?: (info: QwenTtsProgress) => void;
}): Promise<{ audioPath: string; srtPath: string; words: TranscriptWord[] }> {
  const text = buildContinuousNarrationText(options.scenes);
  if (!text) throw new Error('Kịch bản chưa có lời thoại để tạo voiceover.');

  const languageType = resolveQwenLanguageType(options.languageType, options.language);
  const audioPath = await synthesizeWithQwen({
    apiKey: options.runpodApiKey,
    text,
    scenes: options.scenes,
    voice: options.voice,
    model: options.model || DEFAULT_QWEN_TTS_MODEL,
    languageType,
    endpointId: options.endpointId,
    instruct: options.instruct,
    outDir: options.outDir,
    fileName: options.fileName,
    onProgress: options.onProgress,
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
