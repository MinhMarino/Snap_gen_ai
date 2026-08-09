/**
 * Cắt narration theo script (scene → câu) để TTS nhiều đoạn,
 * rồi nối lại nghe tự nhiên hơn so với cắt cứng theo số ký tự.
 */

export type NarrationChunkPlan = {
  text: string;
  /** Im lặng chèn SAU đoạn này khi concat (ms). Đoạn cuối luôn 0. */
  pauseAfterMs: number;
  /** boundary giúp debug / UI */
  boundary: 'scene' | 'sentence' | 'soft' | 'hard';
};

const SENTENCE_PAUSE_MS = 90;
const SCENE_PAUSE_MS = 170;
const MIN_PACK_RATIO = 0.35;

type Unit = {
  text: string;
  /** Đơn vị này kết thúc một scene trong script. */
  sceneEnd: boolean;
};

/** Tách câu — hỗ trợ EN/VI + CJK + xuống dòng đôi kiểu script. */
export function splitNarrationSentences(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const sentences: string[] = [];
  for (const para of paragraphs) {
    const parts = para
      .split(/(?<=[.!?…。！？])\s+|(?<=[.!?…。！？])(?=\S)/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) sentences.push(...parts);
    else sentences.push(para);
  }
  return sentences;
}

function softBreakIndex(window: string, maxChars: number): number {
  const marks = ['. ', '! ', '? ', '。', '！', '？', '… ', '; ', ': ', ', ', '、', ' '];
  let best = -1;
  for (const m of marks) {
    const at = window.lastIndexOf(m);
    const end = at < 0 ? -1 : at + (m.endsWith(' ') ? m.length - 1 : m.length);
    if (end > best) best = end;
  }
  if (best > maxChars * MIN_PACK_RATIO) return best;
  return maxChars;
}

/** Cắt cứng khi một câu dài hơn maxChars — ưu tiên dấu câu / khoảng trắng. */
export function splitOversizedSentence(text: string, maxChars: number): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];
  const out: string[] = [];
  let remaining = cleaned;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const cut = softBreakIndex(window, maxChars);
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out.filter(Boolean);
}

function joinedLength(parts: string[]): number {
  if (!parts.length) return 0;
  return parts.reduce((n, p) => n + p.length, 0) + (parts.length - 1);
}

function unitsFromScenes(scenes: Array<{ narration_segment?: string }>, maxChars: number): Unit[] {
  const units: Unit[] = [];
  for (const scene of scenes) {
    const seg = String(scene.narration_segment || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!seg) continue;
    const pieces = splitNarrationSentences(seg).flatMap((s) => splitOversizedSentence(s, maxChars));
    pieces.forEach((text, idx) => {
      units.push({ text, sceneEnd: idx === pieces.length - 1 });
    });
  }
  return units;
}

function unitsFromText(text: string, maxChars: number): Unit[] {
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  return splitNarrationSentences(raw)
    .flatMap((s) => splitOversizedSentence(s, maxChars))
    .map((t) => ({ text: t, sceneEnd: false }));
}

/**
 * Gói câu thành chunk ≤ maxChars.
 * Khi đầy: cắt tại scene gần nhất (trong cửa sổ), không thì tại câu; chèn pause ngắn lúc nối.
 */
export function planNarrationTtsChunks(options: {
  scenes?: Array<{ narration_segment?: string }>;
  text?: string;
  maxChars: number;
  minTailChars?: number;
}): NarrationChunkPlan[] {
  const maxChars = Math.max(80, options.maxChars);
  const minTail = options.minTailChars ?? Math.round(maxChars * 0.22);

  const units = options.scenes?.length
    ? unitsFromScenes(options.scenes, maxChars)
    : unitsFromText(String(options.text || ''), maxChars);

  if (!units.length) return [];

  const plans: NarrationChunkPlan[] = [];
  let bag: Unit[] = [];

  const emit = (slice: Unit[], boundary: NarrationChunkPlan['boundary'], pauseAfterMs: number) => {
    const text = slice
      .map((u) => u.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return;
    plans.push({ text, boundary, pauseAfterMs });
  };

  for (const unit of units) {
    if (unit.text.length > maxChars) {
      if (bag.length) {
        const boundary = bag[bag.length - 1]?.sceneEnd ? 'scene' : 'sentence';
        emit(bag, boundary, boundary === 'scene' ? SCENE_PAUSE_MS : SENTENCE_PAUSE_MS);
        bag = [];
      }
      for (const piece of splitOversizedSentence(unit.text, maxChars)) {
        plans.push({ text: piece, boundary: 'hard', pauseAfterMs: SENTENCE_PAUSE_MS });
      }
      continue;
    }

    while (bag.length && joinedLength([...bag, unit].map((u) => u.text)) > maxChars) {
      // Ưu tiên cắt tại scene end gần cuối bag; không thì cả bag (ranh câu).
      let cutAt = bag.length;
      for (let i = bag.length - 1; i >= 0; i--) {
        if (bag[i].sceneEnd) {
          cutAt = i + 1;
          break;
        }
      }
      const headLen = joinedLength(bag.slice(0, cutAt).map((u) => u.text));
      if (cutAt < bag.length && headLen < maxChars * MIN_PACK_RATIO) {
        cutAt = bag.length;
      }
      const out = bag.splice(0, cutAt);
      if (!out.length) break;
      const boundary = out[out.length - 1]?.sceneEnd ? 'scene' : 'sentence';
      emit(out, boundary, boundary === 'scene' ? SCENE_PAUSE_MS : SENTENCE_PAUSE_MS);
    }

    bag.push(unit);
  }

  if (bag.length) {
    const tailText = bag
      .map((u) => u.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sceneEnd = Boolean(bag[bag.length - 1]?.sceneEnd);
    if (
      plans.length &&
      tailText.length < minTail &&
      plans[plans.length - 1].text.length + 1 + tailText.length <= maxChars
    ) {
      const prev = plans[plans.length - 1];
      prev.text = `${prev.text} ${tailText}`.trim();
      if (sceneEnd) prev.boundary = 'scene';
      prev.pauseAfterMs = 0;
    } else {
      emit(bag, sceneEnd ? 'scene' : 'soft', 0);
    }
  }

  if (plans.length) plans[plans.length - 1].pauseAfterMs = 0;
  return plans.filter((p) => p.text);
}

/** API cũ: chỉ lấy mảng text. */
export function chunkNarrationText(text: string, maxChars: number): string[] {
  return planNarrationTtsChunks({ text, maxChars }).map((c) => c.text);
}
