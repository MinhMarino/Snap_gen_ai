import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QwenDashScopeRegion } from '../../shared/types';
import { DEFAULT_QWEN_TTS_MODEL } from '../../shared/types';
import {
  buildQwenTtsInstructions,
  isQwenInstructFlashModel,
  resolveQwenLanguageType,
  resolveQwenTtsVoice,
} from '../../shared/voice';
import { concatAudioFiles, convertAudioToMp3 } from './ffmpeg';
import {
  buildContinuousNarrationText,
  type SceneNarrationInput,
  type TranscriptWord,
  transcribeWithWords,
} from './openai-audio';

const MAX_CHARS_PER_REQUEST = 550;

const ENDPOINTS: Record<QwenDashScopeRegion, string> = {
  singapore:
    'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  beijing: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
};

type DashScopeTtsResponse = {
  code?: string;
  message?: string;
  output?: {
    audio?: {
      url?: string;
      data?: string;
    };
  };
};

/** Chia text dài theo giới hạn ~600 ký tự của Qwen3-TTS-Flash HTTP. */
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

async function synthesizeOneChunk(options: {
  apiKey: string;
  text: string;
  voice: string;
  model: string;
  languageType: string;
  region: QwenDashScopeRegion;
  instructions?: string;
  outPath: string;
}): Promise<void> {
  const url = ENDPOINTS[options.region] || ENDPOINTS.singapore;
  const model = options.model || DEFAULT_QWEN_TTS_MODEL;
  const input: Record<string, unknown> = {
    text: options.text,
    voice: options.voice || 'Vincent',
    language_type: options.languageType || 'Auto',
  };
  if (options.instructions?.trim() && isQwenInstructFlashModel(model)) {
    input.instructions = options.instructions.trim();
    input.optimize_instructions = true;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });

  const contentType = res.headers.get('content-type') || '';
  let body: DashScopeTtsResponse;
  try {
    body = contentType.includes('application/json')
      ? ((await res.json()) as DashScopeTtsResponse)
      : { message: await res.text() };
  } catch {
    body = { message: '<unreadable body>' };
  }

  if (!res.ok) {
    throw new Error(
      `Qwen TTS failed: HTTP ${res.status} ${body.code || ''} ${body.message || JSON.stringify(body).slice(0, 300)}`.trim()
    );
  }

  const audioUrl = body.output?.audio?.url;
  const audioData = body.output?.audio?.data;
  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });

  if (audioData && audioData.trim()) {
    fs.writeFileSync(options.outPath, Buffer.from(audioData, 'base64'));
    return;
  }
  if (audioUrl) {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      throw new Error(`Qwen TTS: tải audio thất bại HTTP ${audioRes.status}`);
    }
    fs.writeFileSync(options.outPath, Buffer.from(await audioRes.arrayBuffer()));
    return;
  }

  throw new Error(`Qwen TTS: phản hồi không có audio (${JSON.stringify(body).slice(0, 300)})`);
}

export async function synthesizeWithQwen(options: {
  apiKey: string;
  text: string;
  voice: string;
  model: string;
  languageType?: string;
  region?: QwenDashScopeRegion;
  outDir: string;
  fileName?: string;
}): Promise<string> {
  const trimmed = options.text.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Qwen TTS: empty text');
  if (!options.apiKey?.trim()) throw new Error('Thiếu DashScope API key (Qwen TTS).');

  const region = options.region === 'beijing' ? 'beijing' : 'singapore';
  const languageType = options.languageType || 'Auto';
  const model = options.model || DEFAULT_QWEN_TTS_MODEL;
  const voice = resolveQwenTtsVoice(options.voice, languageType, model);
  const instructions = buildQwenTtsInstructions(voice, languageType);
  const workDir = path.join(options.outDir, `.qwen-tts-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const chunks = chunkTextForQwenTts(trimmed);
  const chunkPaths: string[] = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const wavPath = path.join(workDir, `chunk-${String(i).padStart(3, '0')}.wav`);
      await synthesizeOneChunk({
        apiKey: options.apiKey.trim(),
        text: chunks[i],
        voice,
        model,
        languageType,
        region,
        instructions,
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
  dashscopeApiKey: string;
  openaiApiKey?: string;
  scenes: SceneNarrationInput[];
  voice: string;
  model: string;
  languageType?: string;
  region?: QwenDashScopeRegion;
  language?: string;
  outDir: string;
  fileName?: string;
}): Promise<{ audioPath: string; srtPath: string; words: TranscriptWord[] }> {
  const text = buildContinuousNarrationText(options.scenes);
  if (!text) throw new Error('Kịch bản chưa có lời thoại để tạo voiceover.');

  const languageType = resolveQwenLanguageType(options.languageType, options.language);
  const audioPath = await synthesizeWithQwen({
    apiKey: options.dashscopeApiKey,
    text,
    voice: options.voice,
    model: options.model,
    languageType,
    region: options.region,
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

  // Không có OpenAI → timing theo tỉ lệ ký tự (computeSceneTimings fallback).
  const srtPath = path.join(options.outDir, 'subs.srt');
  if (!fs.existsSync(srtPath)) {
    fs.writeFileSync(srtPath, `1\n00:00:00,000 --> 00:00:02,000\n${text.slice(0, 80)}\n`, 'utf8');
  }
  return { audioPath, srtPath, words: [] };
}

export async function testQwenTts(options: {
  apiKey: string;
  region?: QwenDashScopeRegion;
  voice?: string;
  model?: string;
}): Promise<{ ok: boolean; message: string }> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, message: 'Chưa nhập DashScope API key.' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapgen-qwen-'));
  try {
    const out = await synthesizeWithQwen({
      apiKey,
      text: 'Hello from Qwen TTS.',
      voice: options.voice || 'Vincent',
      model: options.model || DEFAULT_QWEN_TTS_MODEL,
      languageType: 'English',
      region: options.region || 'singapore',
      outDir: tmpDir,
      fileName: 'test.mp3',
    });
    const size = fs.statSync(out).size;
    return {
      ok: true,
      message: `Qwen TTS OK (${options.region || 'singapore'}) — ${size} bytes.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Thử region còn lại nếu user để singapore mặc định.
    if (!options.region || options.region === 'singapore') {
      try {
        const out = await synthesizeWithQwen({
          apiKey,
          text: 'Hello from Qwen TTS.',
          voice: options.voice || 'Vincent',
          model: options.model || DEFAULT_QWEN_TTS_MODEL,
          languageType: 'English',
          region: 'beijing',
          outDir: tmpDir,
          fileName: 'test-bj.mp3',
        });
        const size = fs.statSync(out).size;
        return {
          ok: true,
          message: `Qwen TTS OK (beijing fallback) — ${size} bytes. Key có vẻ thuộc region Beijing; hãy dùng key Singapore.`,
        };
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        return { ok: false, message: `${msg} | beijing: ${msg2}` };
      }
    }
    return { ok: false, message: msg };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
