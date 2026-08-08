import type { QwenTtsVoiceOption } from './types';

/** Model Qwen TTS cloud (DashScope Singapore). Giữ ở đây để tránh circular import với types.ts. */
export const DEFAULT_QWEN_TTS_MODEL = 'qwen3-tts-instruct-flash';

/** @deprecated Dùng DEFAULT_QWEN_TTS_MODEL — giữ alias tương thích. */
export const QWEN_TTS_MODEL = DEFAULT_QWEN_TTS_MODEL;

export const QWEN_VOICE_AGES = [
  { id: 'child' as const, label: 'Trẻ em' },
  { id: 'young' as const, label: 'Trẻ' },
  { id: 'adult' as const, label: 'Trưởng thành' },
  { id: 'elder' as const, label: 'Già' },
] as const;

export const QWEN_VOICE_PURPOSES = [
  { id: 'narration' as const, label: 'Voiceover / kể chuyện' },
  { id: 'explainer' as const, label: 'Giải thích / giáo dục' },
  { id: 'anime' as const, label: 'Anime / character' },
  { id: 'documentary' as const, label: 'Documentary / trailer' },
  { id: 'news' as const, label: 'Tin tức / báo cáo' },
  { id: 'entertainment' as const, label: 'Giải trí / social' },
  { id: 'brand' as const, label: 'Brand / cinematic' },
  { id: 'sleep' as const, label: 'Thư giãn / ngủ' },
  { id: 'comedy' as const, label: 'Hài / vui' },
  { id: 'kids' as const, label: 'Thiếu nhi' },
] as const;

export type QwenVoiceFilter = {
  query?: string;
  gender?: 'female' | 'male' | '';
  age?: QwenTtsVoiceOption['age'] | '';
  purpose?: NonNullable<QwenTtsVoiceOption['purposes']>[number] | '';
};

/**
 * Voice được DashScope hỗ trợ trên qwen3-tts-instruct-flash (model mặc định của app).
 * Các giọng còn lại trong catalog chỉ dùng được với qwen3-tts-flash (Flash thuần).
 * Nguồn: https://help.aliyun.com/en/model-studio/qwen-tts-voice-list
 */
export const QWEN_INSTRUCT_FLASH_VOICE_IDS = new Set<string>([
  'Cherry',
  'Serena',
  'Ethan',
  'Chelsie',
  'Momo',
  'Vivian',
  'Moon',
  'Maia',
  'Kai',
  'Nofish',
  'Bella',
  'Eldric Sage',
  'Mia',
  'Mochi',
  'Bellona',
  'Vincent',
  'Bunny',
  'Neil',
  'Elias',
  'Arthur',
  'Nini',
  'Seren',
  'Pip',
  'Stella',
]);

export function isQwenInstructFlashModel(model?: string | null): boolean {
  return String(model || DEFAULT_QWEN_TTS_MODEL)
    .toLowerCase()
    .includes('instruct-flash');
}

/** Voice có dùng được với model đang chọn không. */
export function isQwenVoiceSupportedByModel(
  voiceId?: string | null,
  model?: string | null
): boolean {
  const id = String(voiceId || '').trim();
  if (!id) return false;
  if (!isQwenInstructFlashModel(model)) return QWEN_TTS_VOICE_CATALOG.some((v) => v.id === id);
  return QWEN_INSTRUCT_FLASH_VOICE_IDS.has(id);
}

/**
 * Catalog voice Qwen3-TTS (+ Instruct-Flash subset) + tag lọc (giới tính, tuổi, mục đích).
 */
export const QWEN_TTS_VOICE_CATALOG: readonly QwenTtsVoiceOption[] = [
  {
    id: 'Ono Anna',
    label: 'Ono Anna',
    description:
      'Nữ — childhood friend thông minh, nhanh nhẹn. Tone thân mật, gần gũi, hợp narration tiếng Nhật nhẹ nhàng / slice-of-life.',
    gender: 'female',
    age: 'young',
    purposes: ['narration', 'anime', 'entertainment'],
    presetFor: ['Japanese'],
  },
  {
    id: 'Cherry',
    label: 'Cherry',
    description:
      'Nữ trẻ — nắng, tích cực, thân thiện và tự nhiên. Giọng đa ngôn ngữ ổn định, phù hợp explainer và voiceover chung.',
    gender: 'female',
    age: 'young',
    purposes: ['narration', 'explainer', 'entertainment'],
    presetFor: ['Japanese', 'Chinese', 'Auto'],
  },
  {
    id: 'Ethan',
    label: 'Ethan',
    description:
      'Nam — Mandarin chuẩn hơi Bắc; ấm, năng lượng, sống động. Hợp storytelling năng động, trailer ngắn, tiếng Nhật/Anh/Trung.',
    gender: 'male',
    age: 'young',
    purposes: ['narration', 'documentary', 'entertainment'],
    presetFor: ['Japanese', 'Chinese', 'Auto'],
  },
  {
    id: 'Mochi',
    label: 'Mochi',
    description:
      'Nam trẻ — thông minh, nhanh trí, vừa ngây thơ vừa có chiều sâu. Vibe anime / youthful, hợp kịch bản tiếng Nhật vui, nhẹ.',
    gender: 'male',
    age: 'young',
    purposes: ['anime', 'entertainment', 'comedy'],
    presetFor: ['Japanese'],
  },
  {
    id: 'Stella',
    label: 'Stella',
    description:
      'Nữ teen — ngọt, hơi “mơ”; khi cần có thể chuyển sang tone quyết liệt (anime heroine). Hợp JP narration phong cách anime.',
    gender: 'female',
    age: 'young',
    purposes: ['anime', 'entertainment', 'narration'],
    presetFor: ['Japanese'],
  },
  {
    id: 'Ryan',
    label: 'Ryan',
    description:
      'Nam — đầy nhịp điệu, kịch tính, cân bằng chân thật và căng thẳng. Hợp documentary / trailer / narration drama. (Chỉ qwen3-tts-flash — không dùng với Instruct-Flash.)',
    gender: 'male',
    age: 'adult',
    purposes: ['documentary', 'narration', 'brand'],
    presetFor: ['Japanese', 'English'],
  },
  {
    id: 'Serena',
    label: 'Serena',
    description:
      'Nữ trẻ — dịu dàng, êm. Phù hợp storytelling chậm, meditation-adjacent, hoặc nội dung cần cảm giác ấm áp.',
    gender: 'female',
    age: 'young',
    purposes: ['narration', 'sleep', 'explainer'],
    presetFor: ['Japanese', 'Chinese'],
  },
  {
    id: 'Chelsie',
    label: 'Chelsie',
    description:
      'Nữ — vibe “virtual girlfriend” 2D, dễ thương, gần gũi. Hợp nội dung giải trí, character-style, JP/CN casual.',
    gender: 'female',
    age: 'young',
    purposes: ['anime', 'entertainment'],
    presetFor: ['Japanese', 'Chinese'],
  },
  {
    id: 'Momo',
    label: 'Momo',
    description: 'Nữ — tinh nghịch, vui vẻ, mang cảm giác cổ vũ / cheer-up. Hợp short-form vui tươi.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'comedy'],
  },
  {
    id: 'Vivian',
    label: 'Vivian',
    description: 'Nữ — tự tin, dễ thương, hơi “cay” nhẹ. Hợp product pitch hoặc host năng động.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'brand', 'narration'],
  },
  {
    id: 'Moon',
    label: 'Moon',
    description: 'Nam (Yuebai) — mạnh mẽ, đẹp trai, rõ ràng. Hợp narration anh hùng / fantasy / epic nhẹ.',
    gender: 'male',
    age: 'young',
    purposes: ['narration', 'documentary', 'anime'],
  },
  {
    id: 'Maia',
    label: 'Maia',
    description: 'Nữ — trí tuệ kết hợp dịu dàng. Hợp giáo dục, explain phức tạp nhưng vẫn ấm.',
    gender: 'female',
    age: 'adult',
    purposes: ['explainer', 'narration'],
  },
  {
    id: 'Kai',
    label: 'Kai',
    description: 'Nam — êm, thư giãn như “audio spa”. Hợp ASMR-adjacent, wellness, sleep intro.',
    gender: 'male',
    age: 'adult',
    purposes: ['sleep', 'narration'],
  },
  {
    id: 'Nofish',
    label: 'Nofish',
    description: 'Nam — designer; không phát âm retroflex chuẩn (đặc trưng). Giọng đặc biệt, mang cá tính.',
    gender: 'male',
    age: 'adult',
    purposes: ['entertainment', 'narration'],
  },
  {
    id: 'Bella',
    label: 'Bella',
    description: 'Nữ trẻ — sôi nổi, tinh nghịch, bubbly. Hợp nội dung vui, social, character trẻ.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'comedy', 'anime'],
  },
  {
    id: 'Jennifer',
    label: 'Jennifer',
    description:
      'Nữ — American English cinematic, chất lượng premium. Rất hợp tiếng Anh narration / brand film.',
    gender: 'female',
    age: 'adult',
    purposes: ['brand', 'narration', 'documentary'],
    presetFor: ['English'],
  },
  {
    id: 'Katerina',
    label: 'Katerina',
    description: 'Nữ trưởng thành — nhịp điệu giàu, đáng nhớ. Hợp storytelling chín chắn, documentary.',
    gender: 'female',
    age: 'adult',
    purposes: ['documentary', 'narration'],
  },
  {
    id: 'Aiden',
    label: 'Aiden',
    description: 'Nam trẻ Mỹ — thân thiện, đời thường (cooking vibe). Hợp English casual / howto.',
    gender: 'male',
    age: 'young',
    purposes: ['explainer', 'entertainment', 'narration'],
    presetFor: ['English'],
  },
  {
    id: 'Eldric Sage',
    label: 'Eldric Sage',
    description:
      'Nam lớn tuổi — điềm đạm, khôn ngoan; “weathered like pine, clear as a mirror”. Giọng trầm, hợp English documentary / lore.',
    gender: 'male',
    age: 'elder',
    purposes: ['narration', 'documentary', 'anime'],
    presetFor: ['English'],
  },
  {
    id: 'Mia',
    label: 'Mia',
    description: 'Nữ — dịu như suối xuân, mềm mại. Hợp fairy-tale, lullaby-like, soft narration.',
    gender: 'female',
    age: 'young',
    purposes: ['narration', 'sleep', 'kids'],
  },
  {
    id: 'Bellona',
    label: 'Bellona',
    description:
      'Giọng mạnh, rõ, mang tính biểu diễn nhân vật — hùng tráng, đầy cảm xúc. Hợp epic / trailer / drama lớn.',
    gender: 'female',
    age: 'adult',
    purposes: ['documentary', 'brand', 'anime'],
  },
  {
    id: 'Vincent',
    label: 'Vincent',
    description:
      'Nam trầm — khàn, “smoky”, ngực vang; mặc định tốt nhất cho English narration / documentary giọng thấp.',
    gender: 'male',
    age: 'adult',
    purposes: ['documentary', 'anime', 'narration', 'brand'],
    presetFor: ['English', 'Auto'],
  },
  {
    id: 'Bunny',
    label: 'Bunny',
    description: 'Nữ bé — tràn “cuteness”. Dùng có chọn lọc (kids / character); tránh narration dài trang trọng.',
    gender: 'female',
    age: 'child',
    purposes: ['kids', 'anime', 'comedy'],
  },
  {
    id: 'Neil',
    label: 'Neil',
    description:
      'Nam — intonation phẳng, phát âm chính xác như news anchor chuyên nghiệp. Hợp English news / report.',
    gender: 'male',
    age: 'adult',
    purposes: ['news', 'explainer', 'narration'],
    presetFor: ['English'],
  },
  {
    id: 'Elias',
    label: 'Elias',
    description:
      'Giọng học thuật nhưng kể chuyện được — biến kiến thức phức tạp thành module dễ nuốt. Hợp education.',
    gender: 'female',
    age: 'adult',
    purposes: ['explainer', 'narration'],
  },
  {
    id: 'Arthur',
    label: 'Arthur',
    description:
      'Nam già — mộc mạc, hơi “khói thuốc”, trầm chậm; hợp English storytelling / folklore.',
    gender: 'male',
    age: 'elder',
    purposes: ['narration', 'documentary'],
    presetFor: ['English'],
  },
  {
    id: 'Nini',
    label: 'Nini',
    description: 'Nữ — mềm, “clingy”, ngọt như bánh nếp. Hợp character ngọt / romance nhẹ; không hợp hard news.',
    gender: 'female',
    age: 'young',
    purposes: ['anime', 'entertainment'],
  },
  {
    id: 'Seren',
    label: 'Seren',
    description: 'Nữ — êm, ru ngủ; “good night, sweet dreams”. Hợp sleep / calm outro.',
    gender: 'female',
    age: 'adult',
    purposes: ['sleep', 'narration'],
  },
  {
    id: 'Pip',
    label: 'Pip',
    description: 'Nam bé — tinh nghịch, đầy tò mò trẻ thơ (Shin-chan vibe). Hợp kids / comedy character.',
    gender: 'male',
    age: 'child',
    purposes: ['kids', 'comedy', 'anime'],
  },
  {
    id: 'Bodega',
    label: 'Bodega',
    description: 'Nam Tây Ban Nha — nhiệt huyết, đam mê. Hợp Spanish narration năng lượng cao.',
    gender: 'male',
    age: 'adult',
    purposes: ['narration', 'entertainment'],
    presetFor: ['Spanish'],
  },
  {
    id: 'Sonrisa',
    label: 'Sonrisa',
    description: 'Nữ Latin — vui vẻ, hướng ngoại. Hợp Spanish / LATAM friendly host.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Spanish'],
  },
  {
    id: 'Alek',
    label: 'Alek',
    description: 'Nam — lạnh như tinh thần Nga nhưng ấm như lớp lót áo len. Hợp Russian / cinematic cold-warm.',
    gender: 'male',
    age: 'adult',
    purposes: ['narration', 'brand', 'documentary'],
    presetFor: ['Russian'],
  },
  {
    id: 'Dolce',
    label: 'Dolce',
    description: 'Nam Ý — thong thả, laid-back. Hợp Italian casual / lifestyle.',
    gender: 'male',
    age: 'adult',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Italian'],
  },
  {
    id: 'Sohee',
    label: 'Sohee',
    description: 'Nữ Hàn — ấm, vui, biểu cảm (unnie). Hợp Korean friendly / vlog-style.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Korean'],
  },
  {
    id: 'Lenn',
    label: 'Lenn',
    description: 'Nam Đức trẻ — lý trí nhưng có nét nổi loạn; suit + post-punk vibe. Hợp German modern.',
    gender: 'male',
    age: 'young',
    purposes: ['entertainment', 'narration'],
    presetFor: ['German'],
  },
  {
    id: 'Emilien',
    label: 'Emilien',
    description: 'Nam Pháp — lãng mạn, “big brother”. Hợp French storytelling / lifestyle.',
    gender: 'male',
    age: 'adult',
    purposes: ['narration', 'entertainment'],
    presetFor: ['French'],
  },
  {
    id: 'Andre',
    label: 'Andre',
    description: 'Nam — hút, tự nhiên, vững. Hợp narration trung tính đa mục đích.',
    gender: 'male',
    age: 'adult',
    purposes: ['narration', 'explainer', 'brand'],
  },
  {
    id: 'Radio Gol',
    label: 'Radio Gol',
    description: 'Nam — bình luận bóng đá đầy chất thơ. Hợp sports / hype commentary (không phải narration trung tính).',
    gender: 'male',
    age: 'adult',
    purposes: ['entertainment', 'comedy'],
  },
  {
    id: 'Jada',
    label: 'Jada',
    description: 'Nữ Thượng Hải — nhanh, năng lượng (“Shanghai auntie”). Hợp Chinese dialect flavor / lively host.',
    gender: 'female',
    age: 'adult',
    purposes: ['entertainment', 'comedy', 'narration'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Dylan',
    label: 'Dylan',
    description: 'Nam Bắc Kinh — trẻ, lớn lên trong hutong. Hợp Mandarin Bắc Kinh đời thường.',
    gender: 'male',
    age: 'young',
    purposes: ['narration', 'entertainment'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Li',
    label: 'Li',
    description: 'Nam Nam Kinh — kiên nhẫn, giáo viên yoga. Hợp Mandarin dịu / wellness CN.',
    gender: 'male',
    age: 'adult',
    purposes: ['sleep', 'explainer', 'narration'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Marcus',
    label: 'Marcus',
    description: 'Nam Shaanxi — ít lời, chân thành, giọng sâu, đậm chất địa phương. Hợp storytelling CN nặng chất.',
    gender: 'male',
    age: 'adult',
    purposes: ['narration', 'documentary'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Roy',
    label: 'Roy',
    description: 'Nam Minnan / Đài — hài hước, thẳng, sống động. Hợp Southern Min flavored Chinese.',
    gender: 'male',
    age: 'young',
    purposes: ['comedy', 'entertainment'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Peter',
    label: 'Peter',
    description: 'Nam Thiên Tân — crosstalk / foil chuyên nghiệp. Hợp comedy / dialogue-style CN.',
    gender: 'male',
    age: 'adult',
    purposes: ['comedy', 'entertainment'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Sunny',
    label: 'Sunny',
    description: 'Nữ Tứ Xuyên — ngọt đến tan chảy. Hợp Sichuan dialect / sweet CN host.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Eric',
    label: 'Eric',
    description: 'Nam Thành Đô / Tứ Xuyên — nổi bật trong đời thường. Hợp Sichuan male casual.',
    gender: 'male',
    age: 'adult',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Rocky',
    label: 'Rocky',
    description: 'Nam Quảng Đông — hài hước, nhanh trí (A Qiang live-chat vibe). Hợp Cantonese witty.',
    gender: 'male',
    age: 'young',
    purposes: ['comedy', 'entertainment'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Kiki',
    label: 'Kiki',
    description: 'Nữ Hồng Kông — ngọt, best-friend vibe. Hợp Cantonese thân mật / friendly.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Chinese'],
  },
] as const;

export const QWEN_TTS_VOICES = QWEN_TTS_VOICE_CATALOG.map((v) => v.id);

export const QWEN_JAPANESE_PRESET_VOICES = QWEN_TTS_VOICE_CATALOG.filter(
  (v) => v.presetFor?.includes('Japanese') && QWEN_INSTRUCT_FLASH_VOICE_IDS.has(v.id)
).map((v) => v.id);

function catalogForModel(model?: string | null): readonly QwenTtsVoiceOption[] {
  if (!isQwenInstructFlashModel(model)) return QWEN_TTS_VOICE_CATALOG;
  return QWEN_TTS_VOICE_CATALOG.filter((v) => QWEN_INSTRUCT_FLASH_VOICE_IDS.has(v.id));
}

/** Ưu tiên giọng nam trầm khi language = English. */
export const QWEN_ENGLISH_DEEP_VOICE_IDS = [
  'Vincent',
  'Eldric Sage',
  'Arthur',
  'Neil',
  'Kai',
  'Moon',
] as const;

function sortEnglishDeepFirst(voices: QwenTtsVoiceOption[]): QwenTtsVoiceOption[] {
  const rank = new Map<string, number>(
    QWEN_ENGLISH_DEEP_VOICE_IDS.map((id, index) => [id, index])
  );
  return [...voices].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : 1000;
    const rb = rank.has(b.id) ? rank.get(b.id)! : 1000;
    return ra - rb;
  });
}

export function listQwenVoicesForLanguage(
  languageType?: string | null,
  model: string | null = DEFAULT_QWEN_TTS_MODEL
): {
  presets: QwenTtsVoiceOption[];
  others: QwenTtsVoiceOption[];
} {
  const lang = String(languageType || 'Auto').trim() || 'Auto';
  const presets: QwenTtsVoiceOption[] = [];
  const others: QwenTtsVoiceOption[] = [];
  for (const voice of catalogForModel(model)) {
    if (voice.presetFor?.includes(lang)) presets.push(voice);
    else others.push(voice);
  }
  if (lang === 'English') {
    return { presets: sortEnglishDeepFirst(presets), others: sortEnglishDeepFirst(others) };
  }
  return { presets, others };
}

export function filterQwenVoices(
  voices: readonly QwenTtsVoiceOption[],
  filter: QwenVoiceFilter
): QwenTtsVoiceOption[] {
  const q = String(filter.query || '')
    .trim()
    .toLowerCase();
  return voices.filter((voice) => {
    if (filter.gender && voice.gender !== filter.gender) return false;
    if (filter.age && voice.age !== filter.age) return false;
    if (filter.purpose && !voice.purposes?.includes(filter.purpose)) return false;
    if (!q) return true;
    const hay = [
      voice.id,
      voice.label,
      voice.description,
      voice.gender || '',
      voice.age || '',
      ...(voice.purposes || []),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

export function pickQwenVoiceForLanguage(
  languageType: string,
  currentVoice?: string | null,
  model: string | null = DEFAULT_QWEN_TTS_MODEL
): string {
  const lang = String(languageType || 'Auto').trim() || 'Auto';
  const { presets, others } = listQwenVoicesForLanguage(lang, model);
  const available = [...presets, ...others];
  const current = String(currentVoice || '').trim();
  // Cherry/Serena là giọng nữ trẻ — khi chọn English thì chuyển sang giọng trầm mặc định.
  const keepCurrent =
    current &&
    available.some((v) => v.id === current) &&
    !(lang === 'English' && (current === 'Cherry' || current === 'Serena'));
  if (keepCurrent) return current;
  if (lang === 'English') {
    for (const id of QWEN_ENGLISH_DEEP_VOICE_IDS) {
      if (available.some((v) => v.id === id)) return id;
    }
  }
  return presets[0]?.id || others[0]?.id || 'Vincent';
}

/** Instruction control (Instruct-Flash) — ép giọng trầm / English documentary. */
export function buildQwenTtsInstructions(
  voiceId?: string | null,
  languageType?: string | null
): string | undefined {
  const lang = String(languageType || 'Auto').trim() || 'Auto';
  const voice = String(voiceId || '').trim();
  const deep =
    lang === 'English' ||
    (QWEN_ENGLISH_DEEP_VOICE_IDS as readonly string[]).includes(voice) ||
    voice === 'Vincent';

  if (!deep) return undefined;

  return (
    'A mature man speaking natural English with a deep, low, resonant chest voice. ' +
    'Calm documentary narrator: steady pace, clear diction, warm and authoritative. ' +
    'Avoid bright, youthful, nasal, or high-pitched tone. Slight gravel is welcome.'
  );
}

/**
 * Chuẩn hóa voice trước khi gọi API — remap giọng Flash-only (vd. Ryan) sang giọng Instruct-Flash.
 */
export function resolveQwenTtsVoice(
  voiceId?: string | null,
  languageType?: string | null,
  model: string | null = DEFAULT_QWEN_TTS_MODEL
): string {
  return pickQwenVoiceForLanguage(languageType || 'Auto', voiceId, model);
}

export function getQwenVoiceOption(voiceId?: string | null): QwenTtsVoiceOption | undefined {
  const id = String(voiceId || '').trim();
  if (!id) return undefined;
  return QWEN_TTS_VOICE_CATALOG.find((v) => v.id === id);
}

export function qwenAgeLabel(age?: QwenTtsVoiceOption['age']): string {
  return QWEN_VOICE_AGES.find((a) => a.id === age)?.label || '';
}

export function qwenPurposeLabels(purposes?: readonly string[]): string {
  if (!purposes?.length) return '';
  return purposes
    .map((id) => QWEN_VOICE_PURPOSES.find((p) => p.id === id)?.label || id)
    .join(' · ');
}
