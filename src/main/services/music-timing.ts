import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDurationSafe } from './ffmpeg';
import { transcribeWithWords, type TranscriptWord } from './openai-audio';
import { getProjectDir } from './projects';
import type { MusicTimingInfo, TimedLyricLine } from '../../shared/types';

/**
 * Căn hình theo lời hát.
 *
 * Trước đây `duration_hint` của scene MV do ChatGPT đoán từ số chữ lyric, rồi
 * `normalizeSceneDurations` scale tỉ lệ cho vừa độ dài bài — tức coi tốc độ HÁT
 * bằng tốc độ NÓI. Hát thì ngân dài, lặp điệp khúc, có nhạc dạo đầu và nhạc chen
 * giữa, nên hình luôn lệch, và lệch dồn về cuối.
 *
 * Module này lấy mốc thời gian THẬT của từng câu hát:
 *  - file .lrc / lyric có tag [mm:ss.xx] → dùng luôn, chính xác tuyệt đối, miễn phí;
 *  - còn lại → Whisper word-timestamps trên chính file nhạc.
 *
 * Kết quả cache xuống `music/timing.json` theo hash file audio nên đổi nhạc mới
 * gọi lại API; render lại hay Generate lại script đều không tính tiền thêm.
 */

const TIMING_FILE = path.join('music', 'timing.json');
const NARRATION_FILE = 'narration.mp3';

/** Khoảng lặng giữa 2 từ đủ lớn để coi là hết một câu hát. */
const LINE_GAP_SEC = 0.62;
/** Câu quá dài thì cắt — một dòng phụ đề 90 ký tự là đã khó đọc. */
const MAX_LINE_CHARS = 90;

type CachedTiming = MusicTimingInfo & { audioHash: string; words: TranscriptWord[] };

function audioHash(audioPath: string): string {
  const buf = fs.readFileSync(audioPath);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function timingPath(projectId: string): string {
  return path.join(getProjectDir(projectId), TIMING_FILE);
}

function readCache(projectId: string): CachedTiming | null {
  try {
    const raw = fs.readFileSync(timingPath(projectId), 'utf8');
    const parsed = JSON.parse(raw) as CachedTiming;
    return Array.isArray(parsed?.lines) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(projectId: string, value: CachedTiming): void {
  const file = timingPath(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// .lrc — lyric người dùng dán vào đã có sẵn mốc thời gian
// ---------------------------------------------------------------------------

const LRC_TAG_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Đọc lyric dạng `[00:12.50] Một con vịt…`.
 * Một dòng có thể mang nhiều tag (câu lặp lại ở nhiều thời điểm) — tách hết.
 */
export function parseLrc(lyricText: string): TimedLyricLine[] {
  const rows: Array<{ start: number; text: string }> = [];

  for (const rawLine of String(lyricText || '').split(/\r?\n/)) {
    const tags: number[] = [];
    LRC_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LRC_TAG_RE.exec(rawLine))) {
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const fracRaw = match[3] || '0';
      // [00:12.5] = 500ms, [00:12.50] = 500ms, [00:12.500] = 500ms.
      const frac = Number(fracRaw) / 10 ** fracRaw.length;
      tags.push(min * 60 + sec + frac);
    }
    if (!tags.length) continue;
    const text = rawLine.replace(LRC_TAG_RE, '').trim();
    if (!text) continue;
    for (const start of tags) rows.push({ start, text });
  }

  if (rows.length < 2) return [];

  rows.sort((a, b) => a.start - b.start);
  return rows.map((row, i) => ({
    index: i + 1,
    start: row.start,
    // .lrc không có mốc kết thúc — lấy mốc câu sau, câu cuối để pipeline nối tới hết bài.
    end: i + 1 < rows.length ? rows[i + 1].start : row.start + 4,
    text: row.text,
  }));
}

// ---------------------------------------------------------------------------
// Whisper → câu hát
// ---------------------------------------------------------------------------

/** Gom word-timestamps thành câu: cắt ở khoảng lặng, dấu câu, hoặc khi quá dài. */
export function groupWordsIntoLines(words: TranscriptWord[]): TimedLyricLine[] {
  const lines: TimedLyricLine[] = [];
  let buffer: TranscriptWord[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer
      .map((w) => w.word)
      .join(' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      lines.push({
        index: lines.length + 1,
        start: Math.max(0, buffer[0].start ?? 0),
        end: Math.max(buffer[buffer.length - 1].end ?? 0, buffer[0].start ?? 0),
        text,
      });
    }
    buffer = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!String(word.word || '').trim()) continue;
    buffer.push(word);

    const next = words[i + 1];
    const gap = next ? Math.max(0, (next.start ?? 0) - (word.end ?? 0)) : Infinity;
    const chars = buffer.reduce((sum, w) => sum + w.word.length + 1, 0);
    const endsSentence = /[.!?…。！？]$/.test(word.word.trim());

    if (gap >= LINE_GAP_SEC || chars >= MAX_LINE_CHARS || endsSentence) flush();
  }
  flush();

  return lines;
}

// ---------------------------------------------------------------------------
// API chính
// ---------------------------------------------------------------------------

export function resolveMusicAudioFile(projectId: string): string | null {
  const file = path.join(getProjectDir(projectId), NARRATION_FILE);
  if (!fs.existsSync(file) || fs.statSync(file).size < 100) return null;
  return file;
}

/**
 * Mốc thời gian lời hát của project, ưu tiên cache.
 * Không bao giờ throw vì lỗi Whisper — trả về `source: 'none'` để pipeline
 * lùi về cách chia cũ thay vì làm hỏng cả lần render.
 */
export async function resolveMusicTiming(options: {
  projectId: string;
  apiKey?: string;
  lyricText?: string;
  language?: string;
  /** true → bỏ cache, nghe lại file nhạc. */
  force?: boolean;
}): Promise<MusicTimingInfo & { words: TranscriptWord[] }> {
  const audioPath = resolveMusicAudioFile(options.projectId);
  const empty: MusicTimingInfo & { words: TranscriptWord[] } = {
    source: 'none',
    audioDurationSec: 0,
    lines: [],
    firstVocalSec: 0,
    lastVocalSec: 0,
    words: [],
  };
  if (!audioPath) return empty;

  const audioDurationSec = await getDurationSafe(audioPath, 0);
  const hash = audioHash(audioPath);

  if (!options.force) {
    const cached = readCache(options.projectId);
    if (cached && cached.audioHash === hash && cached.lines.length) {
      return { ...cached, audioDurationSec: cached.audioDurationSec || audioDurationSec };
    }
  }

  // 1) Lyric đã có tag thời gian → không cần gọi API.
  const lrc = parseLrc(options.lyricText || '');
  if (lrc.length >= 2) {
    const result: CachedTiming = {
      audioHash: hash,
      source: 'lrc',
      audioDurationSec,
      lines: clampLinesToAudio(lrc, audioDurationSec),
      firstVocalSec: lrc[0].start,
      lastVocalSec: lrc[lrc.length - 1].end,
      words: [],
    };
    writeCache(options.projectId, result);
    return result;
  }

  // 2) Whisper nghe file nhạc.
  if (!options.apiKey) return { ...empty, audioDurationSec };
  try {
    const { words } = await transcribeWithWords({
      apiKey: options.apiKey,
      audioPath,
      language: options.language,
      outDir: path.join(getProjectDir(options.projectId), 'music'),
    });
    const lines = clampLinesToAudio(groupWordsIntoLines(words), audioDurationSec);
    if (!lines.length) return { ...empty, audioDurationSec };

    const result: CachedTiming = {
      audioHash: hash,
      source: 'whisper',
      audioDurationSec,
      lines,
      firstVocalSec: lines[0].start,
      lastVocalSec: lines[lines.length - 1].end,
      words,
    };
    writeCache(options.projectId, result);
    return result;
  } catch {
    // Nhạc phối dày, vocal nhỏ, hoặc mất mạng → lùi về cách cũ.
    return { ...empty, audioDurationSec };
  }
}

/** Mô tả trục thời gian cho prompt — xem `describeTimelineForPrompt` ở shared/music-align. */
function clampLinesToAudio(lines: TimedLyricLine[], audioDurationSec: number): TimedLyricLine[] {
  const limit = audioDurationSec > 0 ? audioDurationSec : Infinity;
  return lines
    .map((line, i) => ({
      index: i + 1,
      start: Math.max(0, Math.min(line.start, limit)),
      end: Math.max(Math.min(line.end, limit), Math.min(line.start, limit)),
      text: line.text,
    }))
    .filter((line) => line.text.trim().length > 0);
}

