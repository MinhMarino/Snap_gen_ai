/**
 * Các file voiceover nằm trong thư mục dự án, và cách đọc/ghi chúng.
 *
 * Tách riêng vì hai bên cùng cần: `pipeline` ghi khi TTS xong, còn `scene-plan`
 * đọc lại ở bước phân cảnh để cắt lời theo ĐÚNG mốc thời gian của giọng đọc.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SceneTiming, TranscriptWord } from './openai-audio';

/** File TTS thô — chưa đệm im lặng, dùng để đo độ dài thật. */
export const RAW_NARRATION_FILE = 'narration-raw.mp3';
export const NARRATION_FILE = 'narration.mp3';
export const SUBTITLE_FILE = 'subs.srt';
export const TIMING_FILE = 'narration-timing.json';
/** Mốc từng từ do Whisper/ElevenLabs trả về — trục thời gian để chia cảnh. */
export const WORDS_FILE = 'narration-words.json';

export type NarrationCache = {
  hash: string;
  audioDuration: number;
  timings: SceneTiming[];
};

export function readNarrationCache(projectDir: string): NarrationCache | null {
  const p = path.join(projectDir, TIMING_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as NarrationCache;
    return raw?.timings?.length ? raw : null;
  } catch {
    return null;
  }
}

export function writeNarrationCache(projectDir: string, cache: NarrationCache): void {
  fs.writeFileSync(
    path.join(projectDir, TIMING_FILE),
    JSON.stringify(cache, null, 2),
    'utf8'
  );
}

/**
 * Giọng đọc của GenMax (và mọi đường bỏ Whisper) không có mốc từ — trả [] chứ
 * không phải lỗi. Bên chia cảnh tự lùi về chia theo tỉ lệ ký tự khi rỗng.
 */
export function readNarrationWords(projectDir: string): TranscriptWord[] {
  const p = path.join(projectDir, WORDS_FILE);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((w) => {
        const row = w as Partial<TranscriptWord>;
        const start = Number(row.start);
        const end = Number(row.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        return { word: String(row.word || ''), start, end } satisfies TranscriptWord;
      })
      .filter((w): w is TranscriptWord => w != null);
  } catch {
    return [];
  }
}

export function writeNarrationWords(projectDir: string, words: TranscriptWord[]): void {
  const p = path.join(projectDir, WORDS_FILE);
  if (!words.length) {
    // Lần TTS này không có mốc từ → xoá file cũ, đừng để bước phân cảnh căn lời
    // mới lên trục thời gian của bản đọc trước.
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  fs.writeFileSync(p, JSON.stringify(words), 'utf8');
}
