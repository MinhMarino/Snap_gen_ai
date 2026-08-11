import type { TimedLyricLine } from './types';

/**
 * Căn cảnh theo lời hát thật.
 *
 * AI chọn MỐC THỜI GIAN cắt cảnh (nó thấy cả timestamp từng câu và các đoạn không
 * lời), còn module này bảo đảm trục thời gian hợp lệ: không lỗ hổng, không chồng
 * lấn, phủ trọn bài, mọi mốc rơi đúng đầu/cuối câu hát.
 *
 * Vì sao không để AI tự tính độ dài: cách cũ là ChatGPT đoán `duration_hint` từ số
 * chữ lyric rồi scale cho vừa bài — tức coi tốc độ HÁT bằng tốc độ NÓI, lại bỏ quên
 * nhạc dạo đầu. Đó là lý do hình lệch nhạc và lệch dồn về cuối.
 *
 * Vì sao không để code tự chia hết: chỉ AI mới biết chỗ nào là điệp khúc, chỗ nào
 * đáng cho nhạc dạo một cảnh riêng.
 */

/** Mốc cảnh do AI trả về (giây). */
export interface AiSceneSlot {
  start: number;
  end: number;
}

export interface AlignedSlot {
  /** Index cảnh AI đã viết visual — slot cắt thêm dùng lại visual của cảnh này. */
  sourceIndex: number;
  start: number;
  end: number;
  /** Câu hát nằm trong slot (1-based, 0 = không có câu nào → đoạn không lời). */
  firstLine: number;
  lastLine: number;
  /** true khi slot là phần cắt thêm của một cảnh quá dài. */
  isSplit: boolean;
}

export interface TimelineOptions {
  audioDurationSec: number;
  /** Cảnh ngắn hơn mức này bị gộp vào cảnh kề. */
  minSec: number;
  /** Cảnh dài hơn mức này bị cắt (phương án cuối — tốn thêm credit). */
  maxSec: number;
  /** Ngân sách media: mỗi slot là một lần gen. */
  maxCount: number;
}

const EPS = 0.05;
/** Mốc AI trả về lệch dưới mức này thì hút về ranh giới câu hát gần nhất. */
const SNAP_WINDOW_SEC = 1.5;
/** Khoảng không lời ngắn hơn mức này không đáng tách cảnh riêng. */
export const MIN_INSTRUMENTAL_SEC = 4;

// ---------------------------------------------------------------------------
// Mô tả trục thời gian cho prompt
// ---------------------------------------------------------------------------

/**
 * Khối lời hát + các đoạn không lời, đưa nguyên vào prompt.
 * Đoạn không lời phải hiện rõ, nếu không AI mặc định cả bài đều có lời và mọi
 * cảnh bị dồn hết vào phần hát.
 */
export function describeTimelineForPrompt(
  lines: TimedLyricLine[],
  audioDurationSec: number,
  maxChars = 6000
): string {
  if (!lines.length) return '';
  const rows: string[] = [];

  const intro = lines[0].start;
  if (intro >= MIN_INSTRUMENTAL_SEC) {
    rows.push(`[INTRO 0.0s–${intro.toFixed(1)}s — instrumental, no singing]`);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    rows.push(`L${line.index} [${line.start.toFixed(1)}s–${line.end.toFixed(1)}s] ${line.text}`);
    const next = lines[i + 1];
    if (next && next.start - line.end >= MIN_INSTRUMENTAL_SEC) {
      rows.push(`[BREAK ${line.end.toFixed(1)}s–${next.start.toFixed(1)}s — instrumental]`);
    }
  }

  const lastEnd = lines[lines.length - 1].end;
  if (audioDurationSec - lastEnd >= MIN_INSTRUMENTAL_SEC) {
    rows.push(`[OUTRO ${lastEnd.toFixed(1)}s–${audioDurationSec.toFixed(1)}s — instrumental]`);
  }

  let out = '';
  for (const row of rows) {
    if (out.length + row.length + 1 > maxChars) break;
    out += (out ? '\n' : '') + row;
  }
  return out;
}

/** Mọi mốc hợp lệ để cắt cảnh: 0, đầu/cuối mỗi câu, hết bài. */
export function timelineBoundaries(
  lines: TimedLyricLine[],
  audioDurationSec: number
): number[] {
  const set = new Set<number>([0]);
  for (const line of lines) {
    set.add(Math.round(line.start * 100) / 100);
    set.add(Math.round(line.end * 100) / 100);
  }
  if (audioDurationSec > 0) set.add(Math.round(audioDurationSec * 100) / 100);
  return [...set].sort((a, b) => a - b);
}

function snap(value: number, boundaries: number[], window = SNAP_WINDOW_SEC): number {
  let best = value;
  let bestDist = Infinity;
  for (const b of boundaries) {
    const dist = Math.abs(b - value);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return bestDist <= window ? best : value;
}

// ---------------------------------------------------------------------------
// Dựng trục thời gian
// ---------------------------------------------------------------------------

/**
 * Mốc AI → slot hợp lệ.
 * Thứ tự xử lý quan trọng: snap → nối liền mạch → gộp ngắn → ép ngân sách → cắt dài.
 * Cắt dài để CUỐI vì nó là thứ duy nhất làm tăng số lần gen (tăng credit).
 */
export function buildTimelineSlots(options: {
  aiSlots: AiSceneSlot[];
  lines: TimedLyricLine[];
  timeline: TimelineOptions;
}): AlignedSlot[] {
  const { lines } = options;
  const { audioDurationSec, minSec, maxSec, maxCount } = options.timeline;
  if (!lines.length) return [];

  const audioEnd = Math.max(audioDurationSec, lines[lines.length - 1].end);
  const boundaries = timelineBoundaries(lines, audioEnd);

  const usable = options.aiSlots
    .map((slot, index) => ({
      sourceIndex: index,
      start: Number(slot.start),
      end: Number(slot.end),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start + EPS)
    .map((s) => ({
      ...s,
      start: snap(Math.min(Math.max(0, s.start), audioEnd), boundaries),
      end: snap(Math.min(Math.max(0, s.end), audioEnd), boundaries),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const chained = usable.length
    ? chainSlots(usable, audioEnd)
    : deriveTimelineSlots(lines, { audioDurationSec: audioEnd, minSec, maxSec, maxCount });
  if (!chained.length) return [];

  const merged = mergeShortSlots(chained, minSec);
  const capped = capSlotCount(merged, maxCount);
  const split = splitLongSlots(capped, maxSec);
  return split.map((slot) => ({ ...slot, ...lineRangeFor(lines, slot) }));
}

/** Nối liền mạch: cảnh sau bắt đầu đúng chỗ cảnh trước dứt, cảnh đầu từ 0, cảnh cuối tới hết bài. */
function chainSlots(
  slots: Array<{ sourceIndex: number; start: number; end: number }>,
  audioEnd: number
): AlignedSlot[] {
  const out: AlignedSlot[] = [];
  let cursor = 0;
  for (const slot of slots) {
    const end = Math.max(slot.end, cursor + EPS);
    if (end <= cursor + EPS) continue;
    out.push({
      sourceIndex: slot.sourceIndex,
      start: cursor,
      end: Math.min(end, audioEnd),
      firstLine: 0,
      lastLine: 0,
      isSplit: false,
    });
    cursor = Math.min(end, audioEnd);
    if (cursor >= audioEnd - EPS) break;
  }
  if (!out.length) return [];
  out[out.length - 1].end = audioEnd;
  return out;
}

/**
 * Chia trục không cần AI: nhạc dạo / nhạc chen / outro thành cảnh riêng,
 * phần hát gom theo câu cho tới khi đủ `minSec`.
 */
export function deriveTimelineSlots(
  lines: TimedLyricLine[],
  timeline: TimelineOptions
): AlignedSlot[] {
  if (!lines.length) return [];
  const audioEnd = Math.max(timeline.audioDurationSec, lines[lines.length - 1].end);
  const target = Math.max(timeline.minSec, Math.min(timeline.maxSec, timeline.minSec * 2));
  const cuts: number[] = [0];

  if (lines[0].start >= MIN_INSTRUMENTAL_SEC) cuts.push(lines[0].start);

  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    acc += line.end - line.start;
    const next = lines[i + 1];
    const gap = next ? next.start - line.end : audioEnd - line.end;
    // Đoạn không lời dài → luôn cắt ở đây, dù cảnh đang ngắn.
    if (gap >= MIN_INSTRUMENTAL_SEC) {
      cuts.push(line.end);
      acc = 0;
      continue;
    }
    if (acc >= target && next) {
      cuts.push(next.start);
      acc = 0;
    }
  }
  cuts.push(audioEnd);

  const uniq = [...new Set(cuts.map((c) => Math.round(c * 100) / 100))].sort((a, b) => a - b);
  const out: AlignedSlot[] = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    if (uniq[i + 1] - uniq[i] <= EPS) continue;
    out.push({
      sourceIndex: out.length,
      start: uniq[i],
      end: uniq[i + 1],
      firstLine: 0,
      lastLine: 0,
      isSplit: false,
    });
  }
  return out;
}

/** Cảnh quá ngắn (một câu 1.2s) → gộp vào cảnh kề, đỡ nhảy hình loạn. */
function mergeShortSlots(slots: AlignedSlot[], minSec: number): AlignedSlot[] {
  if (slots.length < 2) return slots;
  const out: AlignedSlot[] = [];
  for (const slot of slots) {
    const prev = out[out.length - 1];
    if (prev && slot.end - slot.start < minSec - EPS) {
      prev.end = slot.end;
      continue;
    }
    out.push({ ...slot });
  }
  if (out.length > 1 && out[0].end - out[0].start < minSec - EPS) {
    out[0].end = out[1].end;
    out.splice(1, 1);
  }
  return out;
}

/**
 * Ép số slot về ngân sách media (mỗi slot = 1 lần gen = credit).
 * Gộp cặp kề NGẮN NHẤT trước để không phá nhịp những cảnh đang dài đúng ý.
 */
export function capSlotCount(slots: AlignedSlot[], maxCount: number): AlignedSlot[] {
  const limit = Math.max(1, Math.round(maxCount));
  if (slots.length <= limit) return slots;

  const out = slots.map((s) => ({ ...s }));
  while (out.length > limit) {
    let bestI = 0;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i++) {
      const span = out[i + 1].end - out[i].start;
      if (span < bestSpan) {
        bestSpan = span;
        bestI = i;
      }
    }
    out[bestI].end = out[bestI + 1].end;
    out.splice(bestI + 1, 1);
  }
  return out;
}

/**
 * Cảnh dài quá mức → cắt thành nhiều slot, cùng trỏ về một visual gốc.
 * Wrapper prompt tự luân phiên cỡ cảnh theo index nên hai slot của cùng một cảnh
 * ra hai khung khác nhau. Ngưỡng để rộng (2×) vì mỗi lần cắt là thêm một lần gen:
 * ảnh giữ 14s cho đoạn nhạc dạo vẫn hợp lý hơn là ép người dùng trả credit gấp đôi.
 */
function splitLongSlots(slots: AlignedSlot[], maxSec: number): AlignedSlot[] {
  const limit = Math.max(1, maxSec) * 2;
  const out: AlignedSlot[] = [];
  for (const slot of slots) {
    const span = slot.end - slot.start;
    if (span <= limit) {
      out.push(slot);
      continue;
    }
    const pieces = Math.min(3, Math.max(2, Math.round(span / Math.max(1, maxSec))));
    const step = span / pieces;
    for (let p = 0; p < pieces; p++) {
      out.push({
        ...slot,
        start: slot.start + p * step,
        end: p === pieces - 1 ? slot.end : slot.start + (p + 1) * step,
        isSplit: p > 0,
      });
    }
  }
  return out;
}

/** Câu hát chồng lấn với slot → dùng làm narration_segment. */
function lineRangeFor(
  lines: TimedLyricLine[],
  slot: { start: number; end: number }
): { firstLine: number; lastLine: number } {
  let firstLine = 0;
  let lastLine = 0;
  for (const line of lines) {
    // Tính là thuộc slot khi phần lớn câu nằm trong slot.
    const overlap = Math.min(line.end, slot.end) - Math.max(line.start, slot.start);
    const span = Math.max(0.01, line.end - line.start);
    if (overlap >= Math.min(0.6 * span, 0.5)) {
      if (!firstLine) firstLine = line.index;
      lastLine = line.index;
    }
  }
  return { firstLine, lastLine };
}

/** Mốc → duration_hint (1 chữ số thập phân). */
export function slotDurationSec(slot: { start: number; end: number }): number {
  return Math.max(0.1, Math.round((slot.end - slot.start) * 10) / 10);
}

/** Lời hát thuộc một slot, nối lại thành narration_segment. */
export function linesTextForSlot(lines: TimedLyricLine[], slot: AlignedSlot): string {
  if (!slot.firstLine) return '';
  return lines
    .slice(slot.firstLine - 1, slot.lastLine)
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SRT thật từ lời hát đã có mốc — thay bản giả "mọi dòng 0→2s". */
export function timedLinesToSrt(lines: TimedLyricLine[]): string {
  const stamp = (sec: number): string => {
    const total = Math.max(0, sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  };

  return lines
    .map((line, i) => {
      const end = Math.max(line.end, line.start + 0.4);
      return `${i + 1}\n${stamp(line.start)} --> ${stamp(end)}\n${line.text.trim()}\n`;
    })
    .join('\n');
}
