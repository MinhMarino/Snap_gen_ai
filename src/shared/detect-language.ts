/**
 * Tự nhận diện ngôn ngữ của một đoạn văn bản.
 *
 * Studio không còn ô "Language" — người dùng viết brief bằng tiếng nào thì lời
 * bình ra tiếng đó. Nhưng vẫn có 3 chỗ BẮT BUỘC phải biết ngôn ngữ:
 *  1. Ngân sách lời theo giây: CJK đếm KÝ TỰ (5/s), còn lại đếm TỪ (2.5/s).
 *  2. Language code cho ElevenLabs (giọng đọc sai ngữ điệu nếu thiếu).
 *  3. Bộ lọc "câu lạc ngôn ngữ" chỉ được bật cho narration CJK.
 *
 * Nhận diện theo HỆ CHỮ trước (chắc chắn), rồi mới tới dấu tiếng Việt, cuối cùng
 * mới đoán bằng từ chức năng cho các thứ tiếng Latin. Không nhận ra được thì trả
 * về English — đúng với mặc định cũ của app.
 */

export const DEFAULT_DETECTED_LANGUAGE = 'English';

/** Dấu tiếng Việt (kể cả chữ đ) — thứ phân biệt tiếng Việt với các tiếng Latin khác. */
const VIETNAMESE_MARKS =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;

/**
 * Từ chức năng đặc trưng — chỉ dùng cho chữ Latin, khi đã loại tiếng Việt.
 * Cố tình chọn từ ngắn, tần suất cao và ÍT trùng giữa các thứ tiếng.
 */
const LATIN_STOPWORDS: Array<{ lang: string; re: RegExp }> = [
  { lang: 'French', re: /\b(le|la|les|des|une|est|dans|pour|avec|nous|vous|c'est)\b/gi },
  { lang: 'Spanish', re: /\b(el|los|las|una|para|con|pero|porque|esto|muy|también)\b/gi },
  { lang: 'Portuguese', re: /\b(uma|não|você|para|com|mais|muito|isso|então|também)\b/gi },
  { lang: 'German', re: /\b(der|die|das|und|ist|nicht|mit|auch|für|wird|eine)\b/gi },
  { lang: 'Italian', re: /\b(il|lo|gli|una|che|per|con|questo|molto|anche|perché)\b/gi },
  { lang: 'Indonesian', re: /\b(yang|dan|untuk|dengan|tidak|ini|itu|adalah|akan|bisa)\b/gi },
];

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) || []).length;
}

/**
 * Đoán ngôn ngữ của `text`. Trả về nhãn dạng tiếng Anh ("Vietnamese", "Japanese"…)
 * đúng dạng mà `isCjkLanguage`, `resolveElevenLabsLanguageCode` đang nhận.
 */
export function detectScriptLanguage(text?: string | null): string {
  const raw = String(text || '');
  if (!raw.trim()) return DEFAULT_DETECTED_LANGUAGE;

  const latin = countMatches(raw, /[A-Za-z]/g);
  const hangul = countMatches(raw, /[가-힯]/g);
  const kana = countMatches(raw, /[぀-ヿ]/g);
  const han = countMatches(raw, /[㐀-䶿一-鿿]/g);
  const thai = countMatches(raw, /[฀-๿]/g);
  const cyrillic = countMatches(raw, /[Ѐ-ӿ]/g);
  const arabic = countMatches(raw, /[؀-ۿ]/g);

  // Tiếng Nhật dùng chung chữ Hán với tiếng Trung — có kana mới là tiếng Nhật,
  // và khi đó chữ Hán trong bài cũng tính cho tiếng Nhật.
  const japanese = kana >= 2 ? kana + han : 0;
  const chinese = kana >= 2 ? 0 : han;

  const nonLatin = [
    { n: hangul, lang: 'Korean' },
    { n: japanese, lang: 'Japanese' },
    { n: chinese, lang: 'Chinese' },
    { n: thai, lang: 'Thai' },
    { n: cyrillic, lang: 'Russian' },
    { n: arabic, lang: 'Arabic' },
  ].sort((a, b) => b.n - a.n)[0];

  // Vài ký tự lạ lọt vào (tên riêng, emoji chữ) không được lật cả bài — đòi hệ chữ
  // đó phải áp đảo phần chữ Latin thì mới kết luận.
  if (nonLatin.n >= 4 && nonLatin.n * 3 >= latin) return nonLatin.lang;

  if (countMatches(raw, VIETNAMESE_MARKS) >= 2) return 'Vietnamese';

  const best = LATIN_STOPWORDS.map(({ lang, re }) => ({
    lang,
    n: countMatches(raw, re),
  })).sort((a, b) => b.n - a.n)[0];
  // Ngưỡng cao hơn hệ chữ: từ chức năng hay trùng giữa các tiếng Latin
  // ("il", "la", "die"… cũng xuất hiện trong văn bản tiếng Anh).
  if (best && best.n >= 5) return best.lang;

  return DEFAULT_DETECTED_LANGUAGE;
}
