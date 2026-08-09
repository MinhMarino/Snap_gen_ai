import fs from 'node:fs';
import path from 'node:path';

interface WhisperSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
}

interface WhisperVerbose {
  text?: string;
  segments?: WhisperSegment[];
  words?: Array<{ word: string; start: number; end: number }>;
  error?: { message?: string };
}

function formatSrtTime(seconds: number): string {
  const msTotal = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(msTotal / 3_600_000);
  const m = Math.floor((msTotal % 3_600_000) / 60_000);
  const s = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function segmentsToSrt(segments: WhisperSegment[]): string {
  return segments
    .map((seg, idx) => {
      const text = (seg.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const start = Math.max(0, seg.start ?? 0);
      const end = Math.max(start + 0.4, seg.end ?? start + 1);
      return `${idx + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`;
    })
    .filter(Boolean)
    .join('\n');
}

function wordsToSrt(
  words: Array<{ word: string; start: number; end: number }>,
  maxChars = 42
): string {
  type Cue = { start: number; end: number; text: string };
  const cues: Cue[] = [];
  let buf = '';
  let cueStart = words[0]?.start ?? 0;
  let cueEnd = words[0]?.end ?? 0;

  const flush = () => {
    const text = buf.replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start: cueStart, end: cueEnd, text });
    buf = '';
  };

  for (const w of words) {
    if (!buf) cueStart = w.start;
    cueEnd = w.end;
    buf = buf ? `${buf} ${w.word}` : w.word;
    const trimmed = buf.trim();
    const last = w.word.trim().slice(-1);
    if (
      (['.', '!', '?', '。'].includes(last) && trimmed.length > 8) ||
      trimmed.length >= maxChars
    ) {
      flush();
    }
  }
  flush();
  return segmentsToSrt(cues);
}

export async function synthesizeWithOpenAI(options: {
  apiKey: string;
  text: string;
  voice: string;
  model: string;
  outDir: string;
  fileName?: string;
}): Promise<string> {
  const { apiKey, text, voice, model, outDir } = options;
  fs.mkdirSync(outDir, { recursive: true });

  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    throw new Error('OpenAI TTS: empty text');
  }

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: trimmed,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI TTS failed: HTTP ${res.status} ${errText.slice(0, 300)}`);
  }

  const audioPath = path.join(outDir, options.fileName || 'narration.mp3');
  fs.writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));
  return audioPath;
}

export type TranscriptWord = { word: string; start: number; end: number };

async function requestWhisper(options: {
  apiKey: string;
  audioPath: string;
  language?: string;
}): Promise<WhisperVerbose> {
  const buf = fs.readFileSync(options.audioPath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(buf)], { type: 'audio/mpeg' }),
    path.basename(options.audioPath)
  );
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  if (options.language) {
    const lang = options.language.toLowerCase();
    if (lang.includes('vi') || lang.includes('việt')) form.append('language', 'vi');
    else if (lang.includes('en') || lang.includes('english')) form.append('language', 'en');
  }

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form as unknown as BodyInit,
  });

  const data = (await res.json()) as WhisperVerbose;
  if (!res.ok) {
    throw new Error(
      `Whisper failed: HTTP ${res.status} ${data.error?.message || JSON.stringify(data).slice(0, 300)}`
    );
  }
  return data;
}

function writeSrtFrom(data: WhisperVerbose, outDir: string): string {
  let srt = '';
  if (data.segments?.length) srt = segmentsToSrt(data.segments);
  else if (data.words?.length) srt = wordsToSrt(data.words);
  else {
    const fallback = (data.text || '').trim() || 'Narration';
    srt = `1\n00:00:00,000 --> 00:00:10,000\n${fallback.slice(0, 120)}\n`;
  }

  const srtPath = path.join(outDir, 'subs.srt');
  fs.writeFileSync(srtPath, srt, 'utf8');
  return srtPath;
}

export async function transcribeWithWhisper(options: {
  apiKey: string;
  audioPath: string;
  language?: string;
  outDir: string;
}): Promise<string> {
  fs.mkdirSync(options.outDir, { recursive: true });
  const data = await requestWhisper(options);
  return writeSrtFrom(data, options.outDir);
}

export async function transcribeWithWords(options: {
  apiKey: string;
  audioPath: string;
  language?: string;
  outDir: string;
}): Promise<{ srtPath: string; words: TranscriptWord[] }> {
  fs.mkdirSync(options.outDir, { recursive: true });
  const data = await requestWhisper(options);
  const srtPath = writeSrtFrom(data, options.outDir);

  let words: TranscriptWord[] = data.words ?? [];
  if (!words.length && data.segments?.length) {
    // Fall back to segment-level timing when word granularity is unavailable.
    words = data.segments.map((seg) => ({
      word: seg.text || '',
      start: seg.start ?? 0,
      end: seg.end ?? seg.start ?? 0,
    }));
  }
  return { srtPath, words };
}

export async function synthesizeNarration(options: {
  apiKey: string;
  text: string;
  voice: string;
  ttsModel: string;
  language?: string;
  outDir: string;
}): Promise<{ audioPath: string; srtPath: string }> {
  const audioPath = await synthesizeWithOpenAI({
    apiKey: options.apiKey,
    text: options.text,
    voice: options.voice,
    model: options.ttsModel,
    outDir: options.outDir,
  });
  const srtPath = await transcribeWithWhisper({
    apiKey: options.apiKey,
    audioPath,
    language: options.language,
    outDir: options.outDir,
  });
  return { audioPath, srtPath };
}

export type SceneNarrationInput = {
  id: string;
  narration_segment: string;
  duration_hint: number;
};

export type SceneTiming = {
  sceneId: string;
  start: number;
  end: number;
  hasSpeech: boolean;
};

/** Nối lời thoại các scene thành một mạch đọc duy nhất cho TTS. */
export function buildContinuousNarrationText(scenes: SceneNarrationInput[]): string {
  const parts = scenes
    .map((scene) => (scene.narration_segment || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // Scene mới: nếu scene trước chưa có dấu kết thúc, thêm "." để TTS nghỉ nhịp tự nhiên.
  return parts.reduce((acc, part) => {
    if (!acc) return part;
    if (/[.!?…。！？]$/.test(acc)) return `${acc} ${part}`;
    return `${acc}. ${part}`;
  }, '');
}

function normalizeForAlign(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Chia trục thời gian của bản đọc liền mạch thành từng scene.
 * Dùng word timestamps của Whisper; nếu thiếu thì chia theo tỉ lệ ký tự.
 */
export function computeSceneTimings(options: {
  scenes: SceneNarrationInput[];
  words: TranscriptWord[];
  audioDuration: number;
}): SceneTiming[] {
  const { scenes, words, audioDuration } = options;
  const texts = scenes.map((scene) => normalizeForAlign(scene.narration_segment || ''));
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);

  // Trục ký tự -> thời gian, dựng từ các từ Whisper nhận được.
  const charTimes: number[] = [];
  for (const w of words) {
    const chars = normalizeForAlign(w.word);
    if (!chars.length) continue;
    const start = Math.max(0, w.start ?? 0);
    const end = Math.max(start, w.end ?? start);
    for (let i = 0; i < chars.length; i++) {
      charTimes.push(start + ((i + 1) / chars.length) * (end - start));
    }
  }

  const timeAtRatio = (ratio: number): number => {
    const clamped = Math.min(1, Math.max(0, ratio));
    if (!charTimes.length) return clamped * audioDuration;
    const index = Math.min(charTimes.length - 1, Math.round(clamped * charTimes.length) - 1);
    return index < 0 ? 0 : charTimes[index];
  };

  const timings: SceneTiming[] = [];
  let consumed = 0;
  let previousEnd = 0;

  for (let i = 0; i < scenes.length; i++) {
    const chars = texts[i].length;
    const hasSpeech = chars > 0;
    consumed += chars;

    const isLast = i === scenes.length - 1;
    let end = isLast || totalChars === 0 ? audioDuration : timeAtRatio(consumed / totalChars);
    if (end < previousEnd) end = previousEnd;
    if (isLast) end = Math.max(end, audioDuration);

    timings.push({ sceneId: scenes[i].id, start: previousEnd, end, hasSpeech });
    previousEnd = end;
  }

  return timings;
}

/** Một lần TTS cho toàn bộ kịch bản + Whisper để biết mỗi scene chiếm đoạn nào. */
export async function synthesizeContinuousNarration(options: {
  apiKey: string;
  scenes: SceneNarrationInput[];
  voice: string;
  ttsModel: string;
  language?: string;
  outDir: string;
  fileName?: string;
}): Promise<{ audioPath: string; srtPath: string; words: TranscriptWord[] }> {
  const text = buildContinuousNarrationText(options.scenes);
  if (!text) throw new Error('Kịch bản chưa có lời thoại để tạo voiceover.');

  const audioPath = await synthesizeWithOpenAI({
    apiKey: options.apiKey,
    text,
    voice: options.voice,
    model: options.ttsModel,
    outDir: options.outDir,
    fileName: options.fileName,
  });
  const { srtPath, words } = await transcribeWithWords({
    apiKey: options.apiKey,
    audioPath,
    language: options.language,
    outDir: options.outDir,
  });

  return { audioPath, srtPath, words };
}
