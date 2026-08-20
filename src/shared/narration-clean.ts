/**
 * Làm sạch narration do LLM trả về.
 *
 * Model đôi khi nhả rác vào CHÍNH chuỗi narration: nhắc lại đề bài ("...outro
 * narration for 88s (approx. 440 characters)... Only JSON. Begin immediately."),
 * heading / blockquote markdown ("># Final answer below."), rồi lặp vô hạn một
 * mẩu ngắn ("? ># ? ># ? >#..."). JSON vẫn hợp lệ nên `JSON.parse` qua được, và
 * toàn bộ rác đó chảy tiếp vào TTS (đọc thành tiếng) lẫn visual_prompt.
 *
 * Đây là lưới chắn: giữ lời thoại thật, bỏ phần meta + phần lặp vô nghĩa.
 */

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
/** Kana + Hán + Hangul — dùng để nhận diện narration CJK. */
const CJK_CHAR =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F\uAC00-\uD7AF]/;
const CJK_CHAR_G = new RegExp(CJK_CHAR.source, 'g');
/** Có ít nhất một chữ/số → mới có gì để đọc. */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * Câu chỉ có thể là chỉ dẫn dành cho model, không bao giờ là lời đọc.
 * Cố ý viết hẹp: thà bỏ sót vài mảnh rác hơn là cắt mất lời thoại thật.
 */
const META_PATTERNS: RegExp[] = [
  /\b(?:only|return|returns|output|respond\s+with|just\s+the)\b[^.?!]{0,40}\bjson\b/i,
  /\bjson\s*(?:string|object|format|schema|only)\b/i,
  /^\s*(?:short|final)\s+answer\b/i,
  /\bfinal\s+answer\b/i,
  /\bbegin\s+(?:immediately|now|below)\b/i,
  /\bend\s+immediately\b/i,
  /\bno\s+(?:stage\s+directions?|bullet\s+points?|markdown|summary|summaries|explanations?|extra\s+text|preamble|repeats?)\b/i,
  /\bdo\s+not\s+(?:mention|repeat|include|restart|summarize)\b/i,
  /\bexactly\s+as\s+instructed\b/i,
  /\bno\s+more\b[^.?!]{0,10}\bno\s+less\b/i,
  /\b\d+\s*(?:characters?|words?)\s*(?:minimum|maximum|min|max)\b/i,
  /\bapprox\.?\s*\d+\s*(?:characters?|words?)\b/i,
  /\b(?:narration|voiceover|voice-over)\s+(?:for|string)\b/i,
  /^\s*(?:language|audience|voice|style|budget|time|chapter|summary|title)\s*[:：]/i,
  /^\s*(?:narration|continuation|script|output|answer|response)\s*[:：]/i,
];

/**
 * Câu chào hàng model đặt TRƯỚC lời đọc: "Dưới đây là bản dịch tiếng Việt tự
 * nhiên, phù hợp để dùng làm narration cho video YouTube:", "Here is the script:".
 *
 * Không nằm trong `META_PATTERNS` được vì luật ở đây hẹp hơn hẳn: chỉ xét câu ĐẦU
 * TIÊN, và phải vừa kết thúc bằng dấu hai chấm vừa gọi tên chính thứ sắp viết ra.
 * Lời đọc thật cũng có câu kết thúc bằng ":" ("Có ba lý do:") — những câu đó không
 * nhắc tới narration/bản dịch/kịch bản nên vẫn qua được.
 */
const PREAMBLE_NOUN =
  /narration|voiceover|voice-over|transcript|script|kịch bản|bản dịch|bản tiếng|lời bình|lời dẫn|lời đọc|phiên bản|đoạn văn|video|ナレーション|動画|台本|字幕|旁白|视频|脚本|나레이션|영상/i;

function looksLikePreamble(sentence: string): boolean {
  const s = sentence.trim();
  return s.length <= 220 && /[:：]$/.test(s) && PREAMBLE_NOUN.test(s);
}

/**
 * Preamble thường dính LIỀN vào câu đầu tiên ("…cho video YouTube: Trồng khoai
 * lang…") vì dấu hai chấm không phải dấu kết câu — tách câu không cắt ở đó, nên
 * lưới lọc theo câu bên dưới không thấy. Ở đây cắt đúng phần đầu tới dấu hai chấm.
 *
 * Đòi có khoảng trắng SAU dấu hai chấm để tỉ lệ khung hình ("16:9") không bị coi
 * là preamble.
 */
const LEADING_COLON_HEAD = /^\s*[^.?!。！？\n]{6,220}?[:：]\s+/;

/**
 * Câu đệm kiểu trợ lý đứng trước preamble ("Chắc chắn rồi! Đây là lời bình…").
 * Phải là câu NGẮN và trọn vẹn ngay đầu chuỗi — chương 2 trở đi mở bằng "Dĩ nhiên,
 * không phải giống nào cũng vậy." là lời thật, dài quá mức này nên không dính.
 */
const ASSISTANT_FILLER =
  /^\s*(?:sure|certainly|of course|absolutely|okay|ok|got it|here you go|chắc chắn rồi|được thôi|của bạn đây)[^.?!\n]{0,12}[.!…]\s+/i;

function stripLeadingPreamble(text: string): string {
  let out = text;
  const filler = out.match(ASSISTANT_FILLER)?.[0];
  if (filler) out = out.slice(filler.length);
  const head = out.match(LEADING_COLON_HEAD)?.[0];
  if (head && PREAMBLE_NOUN.test(head)) out = out.slice(head.length);
  // Chỉ có câu đệm, không có preamble theo sau → vẫn bỏ: giọng đọc sẽ đọc cả nó.
  return out;
}

/** Blockquote / heading rác rải giữa câu: "... ? ># ? ># ..." */
const INLINE_MARKUP_RUN = /(?:^|\s)[?>#*|]{1,}(?:[\s?>#*|]*[?>#*|])?(?=\s|$)/g;

/** Gỡ markup rác nằm GIỮA chuỗi (stripMarkupEdges chỉ lo hai đầu). */
export function stripInlineMarkupJunk(text: string): string {
  return text.replace(INLINE_MARKUP_RUN, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripMarkupEdges(line: string): string {
  return line
    // ```json / ``` mở đầu hoặc kết thúc
    .replace(/^\s*`{3,}\s*\w*\s*/, '')
    .replace(/\s*`{3,}\s*$/, '')
    // blockquote / heading / bullet lặp nhiều lớp: "># ", ">>* ", "- # "
    .replace(/^\s*(?:[>#*•·|\-–—]+\s*)+/, '')
    .trim();
}

function looksLikeInstruction(line: string): boolean {
  return META_PATTERNS.some((re) => re.test(line));
}

/**
 * Rác dạng "đề bài bị echo" cũng lọt vào visual_prompt (prompt hình được dựng từ
 * narration) → wrapper prompt dùng lại đúng bộ nhận diện này.
 */
export function looksLikeLlmInstruction(text: string): boolean {
  return looksLikeInstruction(text);
}

function latinLetterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) || []).length;
}

/**
 * Bỏ đoạn lặp vô nghĩa. Model lỗi thường lặp cùng một mẩu hàng trăm lần —
 * TTS sẽ đọc hết chỗ đó nếu không cắt.
 */
export function collapseLlmRepeats(text: string): string {
  return collapseRepeats(text);
}

function collapseRepeats(text: string): string {
  // 1) Cùng một "từ" lặp liên tiếp > 2 lần → giữ 2 (lời cho trẻ có lặp thật).
  const kept: string[] = [];
  let dup = 1;
  for (const token of text.split(/\s+/)) {
    if (kept.length && token === kept[kept.length - 1]) {
      dup += 1;
      if (dup > 2) continue;
    } else {
      dup = 1;
    }
    kept.push(token);
  }
  let out = kept.join(' ');

  // 2) Một dấu câu lặp ≥ 4 lần ("!!!!!", "-----") → giữ 1.
  out = out.replace(/([^\p{L}\p{N}\s])\1{3,}/gu, '$1');

  // 3) Mẩu ngắn lặp ≥ 4 lần liền nhau → giữ 1. Chỉ chạy trên chuỗi vừa phải để
  //    regex backtracking không thành điểm treo.
  if (out.length <= 200_000) {
    out = out.replace(/(.{2,24}?)(?:\1){3,}/g, '$1');
  }
  return out;
}

/** Tách câu — cùng quy ước với chỗ chia scene (kể cả dấu câu CJK). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…。！？])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Dấu câu / ngoặc CJK — coi như thuộc cùng "mạch chữ" với chữ CJK. */
const CJK_ADJACENT = /[。、！？…「」『』（）]/;

function isCjkish(char: string | undefined): boolean {
  return Boolean(char) && (CJK_CHAR.test(char as string) || CJK_ADJACENT.test(char as string));
}

/**
 * Ghép lại KHÔNG chèn dấu cách ở ranh giới CJK–CJK. Tiếng Nhật/Trung không viết
 * cách; nếu tự thêm thì narration sạch cũng bị coi là "đã đổi" → hash TTS lệch →
 * đọc lại toàn bộ (mất tiền) dù chẳng có rác nào.
 */
function joinPieces(pieces: string[], spaceAfterCjk: boolean): string {
  return pieces.reduce((acc, piece) => {
    if (!acc) return piece;
    if (!spaceAfterCjk && isCjkish(acc[acc.length - 1]) && isCjkish(piece[0])) {
      return acc + piece;
    }
    return `${acc} ${piece}`;
  }, '');
}

export function sanitizeNarrationText(
  raw: string,
  options?: {
    /**
     * Narration CJK: bỏ luôn câu thuần Latin dài (đề bài tiếng Anh bị echo).
     * Chỉ bật khi biết chắc đây là văn xuôi narration — KHÔNG bật cho lyric
     * (lời hát romaji hoàn toàn hợp lệ).
     */
    dropForeignSentences?: boolean;
  }
): string {
  if (!raw) return '';

  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(/\uFFFD/g, '');

  // Luật "bỏ câu thuần Latin" chỉ đúng cho narration CJK — bật sai chỗ là xoá
  // sạch cả bài tiếng Việt/Anh. Ngoài cờ của caller, đòi thêm: văn bản có chữ
  // CJK (đúng là narration CJK), HOẶC có dấu hiệu meta (scene toàn rác tiếng
  // Anh, không còn chữ CJK nào để nhận ra).
  const dropForeign =
    Boolean(options?.dropForeignSentences) &&
    (CJK_CHAR.test(normalized) || looksLikeInstruction(normalized));

  // Bản gốc đã viết cách sau dấu câu CJK? Thì ghép lại cũng phải viết cách y
  // vậy — narration sạch phải ra ĐÚNG chuỗi cũ, nếu không hash TTS đổi và cả
  // project bị đọc lại dù không có rác nào.
  const spaceAfterCjk = /[。！？…、][ \t]/.test(normalized);
  const trimmed = stripLeadingPreamble(normalized);
  let removedAnything = trimmed !== normalized;

  // Đơn vị xét là CÂU, không phải dòng: model hay dồn cả narration lẫn rác vào
  // một dòng duy nhất, loại theo dòng là xoá luôn lời thật. Tách câu ngay trong
  // từng dòng để dòng thiếu dấu kết câu ("># Final answer below") vẫn là một
  // đơn vị riêng, không bị dán vào câu thật kế tiếp.
  const pieces: string[] = [];
  for (const rawLine of trimmed.split('\n')) {
    const line = stripMarkupEdges(rawLine);
    if (line !== rawLine.trim()) removedAnything = true;
    if (!line || !SPEAKABLE.test(line)) {
      if (rawLine.trim()) removedAnything = true;
      continue;
    }
    pieces.push(...splitSentences(line));
  }

  const sentences: string[] = [];
  // Rác thường đi thành CỤM, và tách câu theo dấu "." lại băm cụm đó thành mảnh
  // vụn không khớp pattern nào ("440 characters)", "No more.", "Begin."). Với
  // narration CJK ta biết chắc câu thật phải đậm chữ CJK → sau khi gặp một câu
  // meta, mọi câu nghèo CJK liền sau đều thuộc cùng cụm rác đó.
  let inJunkRun = false;
  for (const rawSentence of pieces) {
    const sentence = stripMarkupEdges(rawSentence);
    if (!sentence || !SPEAKABLE.test(sentence)) {
      removedAnything = true;
      continue;
    }

    // Preamble chỉ tính ở câu đầu: giữa bài, một câu kết thúc bằng ":" là lời thật
    // đang dẫn vào danh sách, không phải model chào hàng.
    const isMeta =
      looksLikeInstruction(sentence) ||
      (sentences.length === 0 && looksLikePreamble(sentence)) ||
      (dropForeign && !CJK_CHAR.test(sentence) && latinLetterCount(sentence) >= 12);
    if (isMeta) {
      inJunkRun = true;
      removedAnything = true;
      continue;
    }
    if (dropForeign) {
      const cjk = (sentence.match(CJK_CHAR_G) || []).length;
      const latin = latinLetterCount(sentence);
      const cjkRatio = cjk / Math.max(1, cjk + latin);
      if (inJunkRun && cjkRatio < 0.5) {
        removedAnything = true;
        continue;
      }
      inJunkRun = false;
    }
    sentences.push(sentence);
  }

  // Không bỏ gì cả → trả lại nguyên văn, đừng dựng lại chuỗi (mọi khác biệt về
  // khoảng trắng đều làm project phải TTS lại).
  const body = removedAnything ? joinPieces(sentences, spaceAfterCjk) : normalized;

  return collapseRepeats(body)
    // Dấu ngoặc / ngoặc nhọn lẻ sót lại từ JSON model tự đóng sai.
    .replace(/\s*[{}[\]]+\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Rác đã ăn vào project cũ (script.json đã lưu) → làm sạch tại chỗ dùng cho
 * TTS/timeline, để không phải generate lại từ đầu.
 */
export function sanitizeSceneNarration<T extends { narration_segment?: string }>(
  scenes: T[],
  options?: { dropForeignSentences?: boolean }
): { scenes: T[]; changed: boolean } {
  let changed = false;
  const out = scenes.map((scene) => {
    const original = scene.narration_segment || '';
    if (!original) return scene;
    const clean = sanitizeNarrationText(original, options);
    if (clean === original) return scene;
    changed = true;
    return { ...scene, narration_segment: clean };
  });
  return { scenes: out, changed };
}
