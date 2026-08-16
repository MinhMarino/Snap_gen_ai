/**
 * Nhịp đọc THẬT của giọng đang dùng — đo từ audio, không đoán.
 *
 * Ngân sách lời đọc ở bước 1 tính bằng «thời lượng × nhịp đọc». Trước đây nhịp đọc
 * là hằng số (2.5 từ/s, 5 ký tự/s CJK) nên với giọng đọc nhanh, lời viết ra bị
 * thiếu và video cuối ngắn hơn thời lượng đặt — vì mọi thứ phía sau (phân cảnh,
 * số ảnh, độ dài video) đều bám theo độ dài audio thật.
 *
 * Ở đây: mỗi lần TTS xong, lấy `narration-raw.mp3` (chưa đệm im lặng) so với chính
 * đoạn text vừa đọc → ra số ký tự|từ mỗi giây thật. Con số đó được làm mượt (EMA)
 * và lưu theo ngôn ngữ, lần viết lời sau dùng luôn.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  DEFAULT_CJK_CHARS_PER_SECOND,
  DEFAULT_WORDS_PER_SECOND,
  MAX_CJK_CHARS_PER_SECOND,
  MAX_WORDS_PER_SECOND,
  clampCjkCharsPerSec,
  clampWordsPerSec,
  countCjkChars,
  isCjkLanguage,
  setSpeechRateProfile,
  type SpeechRateInfo,
} from '../../shared/models';
import { getSettings } from '../store';
import { resolveElevenLabsLanguageCode } from './elevenlabs-tts';

export type SpeechRateUnitKind = 'cjk' | 'latin';

export interface SpeechRateEntry {
  /** Ký tự/giây (CJK) hoặc từ/giây (Latin). */
  unitsPerSec: number;
  samples: number;
  updatedAt: string;
  /** Lần đo gần nhất — hiển thị trong Settings để đối chiếu. */
  lastUnits: number;
  lastSeconds: number;
  lastVoiceKey?: string;
}

interface SpeechRateFile {
  version: 1;
  entries: Record<string, SpeechRateEntry>;
}

/** Mẫu quá ngắn thì nhiễu (một câu, im lặng đầu/cuối chiếm tỉ trọng lớn). */
const MIN_SAMPLE_SECONDS = 20;
const MIN_SAMPLE_UNITS = 60;
/** Trọng số tối thiểu cho mẫu mới — luôn còn bám theo giọng hiện tại. */
const MIN_SAMPLE_WEIGHT = 0.35;
/** Gộp mọi ngôn ngữ cùng nhóm — dùng khi chưa có số đo cho đúng ngôn ngữ đó. */
const ANY_LANGUAGE = '*';

function filePath(): string {
  return path.join(app.getPath('userData'), 'speech-rate.json');
}

function readFileSafe(): SpeechRateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as SpeechRateFile;
    if (raw?.entries && typeof raw.entries === 'object') {
      return { version: 1, entries: raw.entries };
    }
  } catch {
    /* chưa có file / file hỏng → coi như chưa đo lần nào */
  }
  return { version: 1, entries: {} };
}

function writeFileSafe(data: SpeechRateFile): void {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* Không ghi được thì chỉ mất hiệu chỉnh, không được làm hỏng job TTS. */
  }
}

/**
 * Rút gọn ngôn ngữ về mã ISO để hai đầu khớp nhau: bước 1 nhận nhãn
 * ("Japanese"), bước tạo voice nhận mã ('ja') — cùng trỏ về một chỗ lưu.
 */
export function speechRateLanguageKey(language?: string | null): string {
  const raw = String(language || '').trim();
  if (!raw) return ANY_LANGUAGE;
  return resolveElevenLabsLanguageCode(raw) || raw.toLowerCase().slice(0, 16);
}

export function speechRateKindOf(language?: string | null, text?: string): SpeechRateUnitKind {
  if (isCjkLanguage(language)) return 'cjk';
  // Ngôn ngữ để «Tự động» → nhìn chính đoạn lời để phân nhóm.
  if (text && countCjkChars(text) >= 8) return 'cjk';
  return 'latin';
}

function countUnits(text: string, kind: SpeechRateUnitKind): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (kind === 'cjk') return countCjkChars(trimmed);
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function entryKey(kind: SpeechRateUnitKind, languageKey: string): string {
  return `${kind}:${languageKey}`;
}

function clampFor(kind: SpeechRateUnitKind, value: number): number {
  return kind === 'cjk' ? clampCjkCharsPerSec(value) : clampWordsPerSec(value);
}

function defaultFor(kind: SpeechRateUnitKind): number {
  return kind === 'cjk' ? DEFAULT_CJK_CHARS_PER_SECOND : DEFAULT_WORDS_PER_SECOND;
}

function manualFor(kind: SpeechRateUnitKind): number | null {
  const settings = getSettings();
  const raw = Number(
    kind === 'cjk' ? settings.speechRateCjkCharsPerSec : settings.speechRateWordsPerSec
  );
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return clampFor(kind, raw);
}

function mergeSample(prev: SpeechRateEntry | undefined, observed: number): number {
  if (!prev || !prev.samples) return observed;
  const weight = Math.max(MIN_SAMPLE_WEIGHT, 1 / (prev.samples + 1));
  return prev.unitsPerSec * (1 - weight) + observed * weight;
}

/**
 * Ghi lại một lần đo. Gọi sau khi TTS xong, với ĐÚNG đoạn text đã gửi đi và độ dài
 * file audio thô. Trả về entry vừa cập nhật, hoặc null nếu mẫu không đáng tin.
 */
export function recordNarrationRateSample(input: {
  language?: string | null;
  text: string;
  seconds: number;
  voiceKey?: string;
}): SpeechRateEntry | null {
  const seconds = Number(input.seconds);
  if (!Number.isFinite(seconds) || seconds < MIN_SAMPLE_SECONDS) return null;

  const kind = speechRateKindOf(input.language, input.text);
  const units = countUnits(input.text || '', kind);
  if (units < MIN_SAMPLE_UNITS) return null;

  const observed = units / seconds;
  // Lệch quá xa biên → text và audio không phải một cặp (đọc thiếu, file lỗi).
  const ceiling = kind === 'cjk' ? MAX_CJK_CHARS_PER_SECOND : MAX_WORDS_PER_SECOND;
  if (observed > ceiling * 1.6 || observed <= 0) return null;

  const data = readFileSafe();
  const languageKey = speechRateLanguageKey(input.language);
  const now = new Date().toISOString();
  let updated: SpeechRateEntry | null = null;

  for (const key of new Set([entryKey(kind, languageKey), entryKey(kind, ANY_LANGUAGE)])) {
    const prev = data.entries[key];
    const next: SpeechRateEntry = {
      unitsPerSec: clampFor(kind, mergeSample(prev, observed)),
      samples: Math.min(20, (prev?.samples || 0) + 1),
      updatedAt: now,
      lastUnits: units,
      lastSeconds: Math.round(seconds * 10) / 10,
      lastVoiceKey: input.voiceKey,
    };
    data.entries[key] = next;
    if (key === entryKey(kind, languageKey)) updated = next;
  }

  writeFileSafe(data);
  return updated ?? data.entries[entryKey(kind, ANY_LANGUAGE)] ?? null;
}

function resolveKind(kind: SpeechRateUnitKind, languageKey: string) {
  const manual = manualFor(kind);
  if (manual != null) {
    return { perSec: manual, source: 'manual' as const, samples: 0, entry: undefined };
  }
  const data = readFileSafe();
  const entry =
    data.entries[entryKey(kind, languageKey)] || data.entries[entryKey(kind, ANY_LANGUAGE)];
  if (entry?.unitsPerSec) {
    return {
      perSec: clampFor(kind, entry.unitsPerSec),
      source: 'measured' as const,
      samples: entry.samples || 0,
      entry,
    };
  }
  return { perSec: defaultFor(kind), source: 'default' as const, samples: 0, entry: undefined };
}

/** Nhịp đọc dùng cho một ngôn ngữ cụ thể (manual > đo được > mặc định). */
export function getSpeechRateInfo(language?: string | null): SpeechRateInfo {
  const languageKey = speechRateLanguageKey(language);
  const kind = speechRateKindOf(language);
  const cjk = resolveKind('cjk', languageKey);
  const latin = resolveKind('latin', languageKey);
  const active = kind === 'cjk' ? cjk : latin;

  return {
    wordsPerSec: latin.perSec,
    cjkCharsPerSec: cjk.perSec,
    kind,
    perSec: active.perSec,
    unitLabel: kind === 'cjk' ? 'ký tự' : 'từ',
    source: active.source,
    samples: active.samples,
    languageKey,
    lastUnits: active.entry?.lastUnits,
    lastSeconds: active.entry?.lastSeconds,
    updatedAt: active.entry?.updatedAt,
    defaultPerSec: defaultFor(kind),
  };
}

/**
 * Nạp nhịp đọc vào `shared/models` cho tiến trình main. Gọi TRƯỚC mỗi bước tính
 * theo thời lượng (viết lời, chia cảnh) vì mỗi dự án có ngôn ngữ riêng.
 */
export function applySpeechRateProfile(language?: string | null): SpeechRateInfo {
  const info = getSpeechRateInfo(language);
  setSpeechRateProfile({
    wordsPerSec: info.wordsPerSec,
    cjkCharsPerSec: info.cjkCharsPerSec,
  });
  return info;
}
