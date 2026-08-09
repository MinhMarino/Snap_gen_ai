import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chunkNarrationText,
  planNarrationTtsChunks,
  type NarrationChunkPlan,
} from '../../shared/narration-chunks';
import { concatAudioFiles, convertAudioToMp3, getDurationSafe } from './ffmpeg';
import {
  buildContinuousNarrationText,
  computeSceneTimings,
  type SceneNarrationInput,
  type TranscriptWord,
} from './openai-audio';

export const GENMAX_API_BASE = 'https://api.genmax.io';
export type GenmaxBackend = 'elevenlabs' | 'minimax' | 'capcut';

export const DEFAULT_GENMAX_VOICE_ID = 'hpp4J3VqNfWAUOO0d1Us'; // Bella
export const DEFAULT_GENMAX_MODEL_ID = 'eleven_flash_v2_5';
export const DEFAULT_GENMAX_BACKEND: GenmaxBackend = 'elevenlabs';

/** GenMax/ElevenLabs cho tối đa ~10k ký tự / request — gửi lớn để ít round-trip. */
const MAX_CHARS_PER_REQUEST = 10_000;
const POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 600_000;

export type GenmaxVoice = {
  voiceId: string;
  name: string;
  previewUrl?: string;
  category?: string;
  gender?: string;
  age?: string;
  accent?: string;
  language?: string;
  description?: string;
  backend: GenmaxBackend;
  /** MiniMax uniq_id — có thể dùng làm voice_id thay thế. */
  uniqId?: string;
};

export type GenmaxModel = {
  modelId: string;
  name: string;
  description?: string;
  maxChars?: number;
};

export type GenmaxLanguage = { code: string; name: string };

export type GenmaxTtsProgress = {
  phase: 'submit' | 'poll' | 'download' | 'concat';
  chunksDone: number;
  chunksTotal: number;
  message?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isGenmaxBackend(value: unknown): value is GenmaxBackend {
  return value === 'elevenlabs' || value === 'minimax' || value === 'capcut';
}

export function resolveGenmaxBackend(value?: string | null): GenmaxBackend {
  return isGenmaxBackend(value) ? value : DEFAULT_GENMAX_BACKEND;
}

/** Map ngôn ngữ dự án → language_code GenMax theo backend. */
export function resolveGenmaxLanguageCode(
  backend: GenmaxBackend,
  projectLanguage?: string | null
): string {
  const lang = String(projectLanguage || '').toLowerCase();
  if (backend === 'minimax') {
    if (!lang) return 'English';
    if (/việt|vietnam|\bvi\b/.test(lang)) return 'Vietnamese';
    if (/中|chinese|mandarin|\bzh\b/.test(lang)) return 'Chinese (Mandarin)';
    if (/japan|日本語|\bja\b|nhật/.test(lang)) return 'Japanese';
    if (/korea|한국어|\bko\b|hàn/.test(lang)) return 'Korean';
    if (/french|pháp|\bfr\b/.test(lang)) return 'French';
    if (/german|đức|\bde\b/.test(lang)) return 'German';
    if (/spanish|tây ban|\bes\b/.test(lang)) return 'Spanish';
    if (/portug|\bpt\b/.test(lang)) return 'Portuguese';
    if (/english|anh|\ben\b/.test(lang)) return 'English';
    return 'English';
  }
  // ElevenLabs / CapCut — ISO
  if (!lang) return 'en';
  if (/việt|vietnam|\bvi\b/.test(lang)) return 'vi';
  if (/中|chinese|mandarin|\bzh\b/.test(lang)) return 'zh';
  if (/japan|日本語|\bja\b|nhật/.test(lang)) return 'ja';
  if (/korea|한국어|\bko\b|hàn/.test(lang)) return 'ko';
  if (/french|pháp|\bfr\b/.test(lang)) return 'fr';
  if (/german|đức|\bde\b/.test(lang)) return 'de';
  if (/spanish|tây ban|\bes\b/.test(lang)) return 'es';
  if (/portug|\bpt\b/.test(lang)) return 'pt';
  if (/thai|\bth\b|thái/.test(lang)) return 'th';
  if (/indonesia|\bid\b/.test(lang)) return 'id';
  return 'en';
}

export function chunkTextForGenmax(text: string, maxChars = MAX_CHARS_PER_REQUEST): string[] {
  return chunkNarrationText(text, maxChars);
}

async function genmaxFetchJson<T = unknown>(
  apiKey: string,
  pathOrUrl: string,
  init?: RequestInit
): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GENMAX_API_BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'xi-api-key': apiKey.trim(),
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    const errObj = body as { error?: string; message?: string; detail?: string };
    const msg = errObj.error || errObj.message || errObj.detail || text.slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GenMax: API key bị từ chối (${res.status}). Kiểm tra lại key sk_…`);
    }
    throw new Error(`GenMax HTTP ${res.status}: ${msg}`.trim());
  }
  return body as T;
}

export async function testGenmaxApiKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  const key = apiKey?.trim() || '';
  if (!key) return { ok: false, message: 'Chưa nhập GenMax API key.' };
  if (!/^sk_/i.test(key) || key.length < 20) {
    return { ok: false, message: 'Key GenMax thường bắt đầu bằng sk_…' };
  }
  try {
    const voices = await listGenmaxVoices({
      apiKey: key,
      backend: 'elevenlabs',
      pageSize: 3,
    });
    return {
      ok: true,
      message: `GenMax OK — đọc được ${voices.length} giọng mặc định (ElevenLabs via GenMax).`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function listGenmaxLanguages(
  apiKey: string,
  backend: GenmaxBackend = 'elevenlabs'
): Promise<GenmaxLanguage[]> {
  const provider = backend === 'minimax' ? 'minimax' : undefined;
  const q = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const data = await genmaxFetchJson<GenmaxLanguage[] | { languages?: GenmaxLanguage[] }>(
    apiKey,
    `/v1/languages${q}`
  );
  if (Array.isArray(data)) return data;
  return data.languages || [];
}

export async function listGenmaxModels(
  apiKey: string,
  backend: GenmaxBackend = 'elevenlabs'
): Promise<GenmaxModel[]> {
  if (backend === 'capcut') {
    return [{ modelId: 'capcut', name: 'CapCut', description: 'CapCut system TTS' }];
  }
  const provider = backend === 'minimax' ? 'minimax' : undefined;
  const q = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const data = await genmaxFetchJson<
    Array<{
      model_id?: string;
      name?: string;
      description?: string;
      max_chars?: number;
      maximum_text_length_per_request?: number;
    }>
  >(apiKey, `/v1/models${q}`);
  const list = Array.isArray(data) ? data : [];
  return list
    .filter((m) => m.model_id)
    .map((m) => ({
      modelId: String(m.model_id),
      name: m.name || String(m.model_id),
      description: m.description,
      maxChars: m.max_chars || m.maximum_text_length_per_request,
    }));
}

function mapElVoice(
  v: Record<string, unknown>,
  backend: GenmaxBackend
): GenmaxVoice | null {
  const voiceId = String(v.voice_id || v.uniq_id || '').trim();
  const name = String(v.name || v.voice_name || voiceId).trim();
  if (!voiceId || !name) return null;
  return {
    voiceId,
    name,
    previewUrl: String(v.preview_url || v.sample_audio || v.sample_audio_url || '') || undefined,
    category: String(v.category || backend),
    gender: String(v.gender || ''),
    age: String(v.age || ''),
    accent: String(v.accent || ''),
    language: String(v.language || ''),
    description: String(v.description || ''),
    backend,
    uniqId: v.uniq_id ? String(v.uniq_id) : undefined,
  };
}

export async function listGenmaxVoices(options: {
  apiKey: string;
  backend?: GenmaxBackend;
  search?: string;
  page?: number;
  pageSize?: number;
  language?: string;
  gender?: string;
}): Promise<GenmaxVoice[]> {
  const apiKey = options.apiKey.trim();
  const backend = resolveGenmaxBackend(options.backend);
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 40));
  const page = Math.max(backend === 'elevenlabs' ? 0 : 1, options.page ?? (backend === 'elevenlabs' ? 0 : 1));
  const params = new URLSearchParams();
  params.set('page_size', String(pageSize));
  if (options.search?.trim()) params.set('search', options.search.trim());

  if (backend === 'elevenlabs') {
    // Default premade + một trang shared trending.
    const def = await genmaxFetchJson<{ voices?: Record<string, unknown>[] }>(
      apiKey,
      `/v1/default-voices?${params.toString()}`
    );
    const sharedParams = new URLSearchParams(params);
    sharedParams.set('sort', 'trending');
    sharedParams.set('page', String(page));
    if (options.language?.trim()) sharedParams.set('required_languages', options.language.trim());
    if (options.gender?.trim()) sharedParams.set('gender', options.gender.trim());
    let shared: { voices?: Record<string, unknown>[] } = { voices: [] };
    try {
      shared = await genmaxFetchJson(apiKey, `/v1/shared-voices?${sharedParams.toString()}`);
    } catch {
      /* shared optional */
    }
    const mapped = [...(def.voices || []), ...(shared.voices || [])]
      .map((v) => mapElVoice(v, 'elevenlabs'))
      .filter((v): v is GenmaxVoice => Boolean(v));
    const seen = new Set<string>();
    return mapped.filter((v) => {
      if (seen.has(v.voiceId)) return false;
      seen.add(v.voiceId);
      return true;
    });
  }

  if (backend === 'minimax') {
    params.set('page', String(Math.max(1, page || 1)));
    if (options.language?.trim()) params.set('language', options.language.trim());
    if (options.gender?.trim()) params.set('gender', options.gender.trim());
    const data = await genmaxFetchJson<{ voice_list?: Record<string, unknown>[] }>(
      apiKey,
      `/v1/minimax/system-voices?${params.toString()}`
    );
    return (data.voice_list || [])
      .map((v) => mapElVoice(v, 'minimax'))
      .filter((v): v is GenmaxVoice => Boolean(v));
  }

  // CapCut
  params.set('page', String(Math.max(1, page || 1)));
  if (options.language?.trim()) params.set('language', options.language.trim());
  if (options.gender?.trim()) params.set('gender', options.gender.trim());
  const data = await genmaxFetchJson<{
    voice_list?: Record<string, unknown>[];
    voices?: Record<string, unknown>[];
  }>(apiKey, `/v1/capcut/system-voices?${params.toString()}`);
  const list = data.voice_list || data.voices || [];
  return list.map((v) => mapElVoice(v, 'capcut')).filter((v): v is GenmaxVoice => Boolean(v));
}

async function waitForGenmaxTask(options: {
  apiKey: string;
  taskId: string;
  timeoutMs?: number;
  onPoll?: (status: string, progress: number) => void;
}): Promise<{ audioUrl: string; srtUrl?: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const detail = await genmaxFetchJson<{
      status?: string;
      progress?: number;
      error?: string | null;
      detail_error?: string | null;
      result?: { audio_url?: string; srt_url?: string } | null;
    }>(options.apiKey, `/v1/history/${encodeURIComponent(options.taskId)}`);
    const status = detail.status || '';
    options.onPoll?.(status, Number(detail.progress || 0));
    if (status === 'completed') {
      const audioUrl = detail.result?.audio_url?.trim();
      if (!audioUrl) throw new Error('GenMax: task completed nhưng thiếu audio_url');
      return { audioUrl, srtUrl: detail.result?.srt_url?.trim() || undefined };
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(
        `GenMax TTS ${status}: ${detail.error || detail.detail_error || 'không rõ lỗi'}`
      );
    }
    await sleep(POLL_MS);
  }
  throw new Error(`GenMax TTS: timeout chờ task ${options.taskId}`);
}

async function downloadToFile(url: string, outPath: string, apiKey?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (apiKey && url.includes('api.genmax.io')) {
    headers['xi-api-key'] = apiKey;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GenMax: tải audio thất bại HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('GenMax: file audio quá nhỏ');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
}

async function synthesizeOneChunk(options: {
  apiKey: string;
  voiceId: string;
  text: string;
  backend: GenmaxBackend;
  modelId: string;
  languageCode: string;
  outPath: string;
  exportTranscript?: boolean;
  onProgress?: (status: string, progress: number) => void;
}): Promise<{ srtPath?: string }> {
  const body: Record<string, unknown> = {
    text: options.text,
    provider: options.backend,
    language_code: options.languageCode,
    export_transcript: Boolean(options.exportTranscript),
  };
  if (options.backend === 'capcut') {
    body.model_id = 'capcut';
    body.voice_settings = { speed: 1.0, pitch: 0 };
  } else if (options.backend === 'minimax') {
    body.model_id = options.modelId || 'speech-2.8-turbo';
    body.voice_settings = { speed: 1.0, pitch: 0, vol: 1.0 };
  } else {
    body.model_id = options.modelId || DEFAULT_GENMAX_MODEL_ID;
    body.voice_settings = {
      stability: 0.5,
      similarity_boost: 0.75,
      speed: 1.0,
    };
  }

  const submitted = await genmaxFetchJson<{ id?: string; status?: string; error?: string }>(
    options.apiKey,
    `/v1/text-to-speech/${encodeURIComponent(options.voiceId)}`,
    { method: 'POST', body: JSON.stringify(body) }
  );
  if (!submitted.id) {
    throw new Error(`GenMax: không nhận task id (${JSON.stringify(submitted).slice(0, 200)})`);
  }

  const { audioUrl, srtUrl } = await waitForGenmaxTask({
    apiKey: options.apiKey,
    taskId: submitted.id,
    onPoll: options.onProgress,
  });

  const ext = audioUrl.includes('.wav') ? '.wav' : '.mp3';
  const rawPath = options.outPath.endsWith('.mp3')
    ? options.outPath.replace(/\.mp3$/i, ext)
    : `${options.outPath}${ext}`;
  await downloadToFile(audioUrl, rawPath, options.apiKey);

  if (rawPath !== options.outPath) {
    if (ext === '.mp3') {
      fs.copyFileSync(rawPath, options.outPath);
    } else {
      await convertAudioToMp3(rawPath, options.outPath);
    }
  }

  let srtPath: string | undefined;
  if (srtUrl) {
    srtPath = options.outPath.replace(/\.mp3$/i, '.srt');
    await downloadToFile(srtUrl, srtPath, options.apiKey);
  }
  return { srtPath };
}

export async function synthesizeWithGenmax(options: {
  apiKey: string;
  text: string;
  /** Khi có scenes — cắt theo scene/câu rồi nối có pause ngắn. */
  scenes?: SceneNarrationInput[];
  voiceId: string;
  backend?: GenmaxBackend;
  modelId?: string;
  language?: string;
  outDir: string;
  fileName?: string;
  exportTranscript?: boolean;
  onProgress?: (info: GenmaxTtsProgress) => void;
}): Promise<{ audioPath: string; srtPath: string; words: TranscriptWord[] }> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('Thiếu GenMax API key.');
  const trimmed = options.text.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('GenMax TTS: empty text');

  const backend = resolveGenmaxBackend(options.backend);
  const voiceId = options.voiceId.trim() || DEFAULT_GENMAX_VOICE_ID;
  const modelId =
    options.modelId?.trim() ||
    (backend === 'minimax'
      ? 'speech-2.8-turbo'
      : backend === 'capcut'
        ? 'capcut'
        : DEFAULT_GENMAX_MODEL_ID);
  const languageCode = resolveGenmaxLanguageCode(backend, options.language);
  const chunkPlans: NarrationChunkPlan[] = planNarrationTtsChunks({
    scenes: options.scenes,
    text: trimmed,
    maxChars: MAX_CHARS_PER_REQUEST,
  });
  const chunks = chunkPlans.map((c) => c.text);
  if (!chunks.length) throw new Error('GenMax TTS: empty text');
  const workDir = path.join(options.outDir, `.genmax-tts-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const report = (info: GenmaxTtsProgress) => {
    try {
      options.onProgress?.(info);
    } catch {
      /* ignore */
    }
  };

  try {
    const chunkPaths: string[] = [];
    let lastSrt: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      report({
        phase: 'submit',
        chunksDone: i,
        chunksTotal: chunks.length,
        message: `GenMax TTS đoạn ${i + 1}/${chunks.length}…`,
      });
      const partPath = path.join(workDir, `chunk-${String(i).padStart(3, '0')}.mp3`);
      const { srtPath } = await synthesizeOneChunk({
        apiKey,
        voiceId,
        text: chunks[i],
        backend,
        modelId,
        languageCode,
        outPath: partPath,
        exportTranscript: Boolean(options.exportTranscript) && chunks.length === 1,
        onProgress: (status, progress) => {
          report({
            phase: 'poll',
            chunksDone: i,
            chunksTotal: chunks.length,
            message: `GenMax ${status}${progress ? ` ${progress}%` : ''} · đoạn ${i + 1}/${chunks.length}`,
          });
        },
      });
      if (srtPath) lastSrt = srtPath;
      chunkPaths.push(partPath);
      report({
        phase: 'download',
        chunksDone: i + 1,
        chunksTotal: chunks.length,
        message: `Đã xong đoạn ${i + 1}/${chunks.length}`,
      });
    }

    const audioPath = path.join(options.outDir, options.fileName || 'narration.mp3');
    if (chunkPaths.length === 1) {
      fs.copyFileSync(chunkPaths[0], audioPath);
    } else {
      report({
        phase: 'concat',
        chunksDone: chunks.length,
        chunksTotal: chunks.length,
        message: `Ghép ${chunks.length} đoạn GenMax (theo script)…`,
      });
      await concatAudioFiles(chunkPaths, audioPath, workDir, {
        pauseAfterMs: chunkPlans.map((c) => c.pauseAfterMs),
      });
    }

    const srtPath = path.join(options.outDir, 'subs.srt');
    if (lastSrt && fs.existsSync(lastSrt) && chunks.length === 1) {
      fs.copyFileSync(lastSrt, srtPath);
    } else if (!fs.existsSync(srtPath)) {
      fs.writeFileSync(
        srtPath,
        `1\n00:00:00,000 --> 00:00:02,000\n${trimmed.slice(0, 80)}\n`,
        'utf8'
      );
    }

    return { audioPath, srtPath, words: [] };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function synthesizeContinuousNarrationWithGenmax(options: {
  apiKey: string;
  scenes: SceneNarrationInput[];
  voiceId: string;
  backend?: GenmaxBackend;
  modelId?: string;
  language?: string;
  outDir: string;
  fileName?: string;
  onProgress?: (info: GenmaxTtsProgress) => void;
}): Promise<{
  audioPath: string;
  srtPath: string;
  words: TranscriptWord[];
  timings: ReturnType<typeof computeSceneTimings>;
  rawAudioDuration: number;
}> {
  const text = buildContinuousNarrationText(options.scenes);
  if (!text) throw new Error('Kịch bản chưa có lời thoại để tạo voiceover.');

  const synthesized = await synthesizeWithGenmax({
    apiKey: options.apiKey,
    text,
    scenes: options.scenes,
    voiceId: options.voiceId,
    backend: options.backend,
    modelId: options.modelId,
    language: options.language,
    outDir: options.outDir,
    fileName: options.fileName,
    onProgress: options.onProgress,
  });

  const rawAudioDuration = await getDurationSafe(synthesized.audioPath, 0);
  const timings = computeSceneTimings({
    scenes: options.scenes,
    words: synthesized.words,
    audioDuration: rawAudioDuration,
  });
  return {
    audioPath: synthesized.audioPath,
    srtPath: synthesized.srtPath,
    words: synthesized.words,
    timings,
    rawAudioDuration,
  };
}

export async function previewGenmaxVoice(options: {
  apiKey: string;
  voiceId: string;
  backend?: GenmaxBackend;
  modelId?: string;
  language?: string;
}): Promise<{ dataUrl: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapgen-genmax-'));
  try {
    const { audioPath } = await synthesizeWithGenmax({
      apiKey: options.apiKey,
      text: 'Hello. This is a GenMax voice preview.',
      voiceId: options.voiceId,
      backend: options.backend,
      modelId: options.modelId,
      language: options.language || 'en',
      outDir: tmpDir,
      fileName: 'preview.mp3',
    });
    const buf = fs.readFileSync(audioPath);
    return { dataUrl: `data:audio/mpeg;base64,${buf.toString('base64')}` };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
