import type { QwenTtsVoiceOption } from './types';

/** Model hiển thị — backend thực tế là Irodori Qwen3-TTS 1.7B trên RunPod. */
export const DEFAULT_QWEN_TTS_MODEL = 'irodori-qwen3-tts-1.7b';

/** @deprecated Dùng DEFAULT_QWEN_TTS_MODEL — giữ alias tương thích. */
export const QWEN_TTS_MODEL = DEFAULT_QWEN_TTS_MODEL;

export const DEFAULT_RUNPOD_ENDPOINT_ID = '3gq6tivo3ms4ls';

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

/** 9 speaker CustomVoice của Irodori (ID API đúng underscore). */
export const IRODORI_SPEAKER_IDS = [
  'Vivian',
  'Serena',
  'Uncle_Fu',
  'Dylan',
  'Eric',
  'Ryan',
  'Aiden',
  'Ono_Anna',
  'Sohee',
] as const;

export type IrodoriSpeakerId = (typeof IRODORI_SPEAKER_IDS)[number];

/** Chuẩn hóa voice ID → speaker API (vd. "Ono Anna" → "Ono_Anna"). */
export function toIrodoriSpeakerId(voiceId?: string | null): string {
  const raw = String(voiceId || '')
    .trim()
    .replace(/\s+/g, '_');
  if (!raw) return 'Vivian';
  const hit = IRODORI_SPEAKER_IDS.find((id) => id.toLowerCase() === raw.toLowerCase());
  return hit || raw;
}

export function isQwenInstructFlashModel(_model?: string | null): boolean {
  // Irodori custom_voice luôn nhận `instruct` tùy chọn — không còn DashScope Instruct-Flash.
  return true;
}

export function isQwenVoiceSupportedByModel(voiceId?: string | null, _model?: string | null): boolean {
  const id = toIrodoriSpeakerId(voiceId);
  return IRODORI_SPEAKER_IDS.some((s) => s === id);
}

/**
 * Catalog 9 voice Irodori Qwen3-TTS CustomVoice (RunPod).
 * Nguồn: API.md §5
 */
export const QWEN_TTS_VOICE_CATALOG: readonly QwenTtsVoiceOption[] = [
  {
    id: 'Vivian',
    label: 'Vivian',
    description: 'Nữ trẻ sáng, hơi sắc — host năng động, product pitch, Chinese / English.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'brand', 'narration'],
    presetFor: ['Chinese', 'English', 'Auto'],
  },
  {
    id: 'Serena',
    label: 'Serena',
    description: 'Nữ trẻ ấm, dịu — storytelling chậm, narration ấm áp, Chinese / English.',
    gender: 'female',
    age: 'young',
    purposes: ['narration', 'sleep', 'explainer'],
    presetFor: ['Chinese', 'English'],
  },
  {
    id: 'Uncle_Fu',
    label: 'Uncle Fu',
    description: 'Nam trung niên trầm ấm — kể chuyện Chinese, lore, narration chín chắn.',
    gender: 'male',
    age: 'elder',
    purposes: ['narration', 'documentary'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Dylan',
    label: 'Dylan',
    description: 'Nam trẻ Bắc Kinh — rõ, tự nhiên; Mandarin Bắc Kinh + English.',
    gender: 'male',
    age: 'young',
    purposes: ['narration', 'entertainment'],
    presetFor: ['Chinese', 'English'],
  },
  {
    id: 'Eric',
    label: 'Eric',
    description: 'Nam Thành Đô / Tứ Xuyên — hơi khàn sáng, sinh động.',
    gender: 'male',
    age: 'adult',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Chinese'],
  },
  {
    id: 'Ryan',
    label: 'Ryan',
    description: 'Nam năng động, nhịp mạnh — podcast / documentary / trailer English.',
    gender: 'male',
    age: 'adult',
    purposes: ['documentary', 'narration', 'brand'],
    presetFor: ['English', 'Chinese', 'Auto'],
  },
  {
    id: 'Aiden',
    label: 'Aiden',
    description: 'Nam Mỹ sunny, trung âm rõ — English casual / howto / friendly host.',
    gender: 'male',
    age: 'young',
    purposes: ['explainer', 'entertainment', 'narration'],
    presetFor: ['English'],
  },
  {
    id: 'Ono_Anna',
    label: 'Ono Anna',
    description: 'Nữ Nhật vui, linh hoạt — anime / VTuber / narration tiếng Nhật (best JP).',
    gender: 'female',
    age: 'young',
    purposes: ['narration', 'anime', 'entertainment'],
    presetFor: ['Japanese', 'English'],
  },
  {
    id: 'Sohee',
    label: 'Sohee',
    description: 'Nữ Hàn ấm, giàu cảm xúc — Korean narration / ballad-style.',
    gender: 'female',
    age: 'young',
    purposes: ['entertainment', 'narration'],
    presetFor: ['Korean', 'English'],
  },
] as const;

export const QWEN_TTS_VOICES = QWEN_TTS_VOICE_CATALOG.map((v) => v.id);

export const QWEN_JAPANESE_PRESET_VOICES = QWEN_TTS_VOICE_CATALOG.filter((v) =>
  v.presetFor?.includes('Japanese')
).map((v) => v.id);

/** Ưu tiên giọng nam trầm / mạnh khi language = English. */
export const QWEN_ENGLISH_DEEP_VOICE_IDS = ['Ryan', 'Aiden', 'Uncle_Fu', 'Dylan'] as const;

function sortEnglishDeepFirst(voices: QwenTtsVoiceOption[]): QwenTtsVoiceOption[] {
  const rank = new Map<string, number>(QWEN_ENGLISH_DEEP_VOICE_IDS.map((id, index) => [id, index]));
  return [...voices].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : 1000;
    const rb = rank.has(b.id) ? rank.get(b.id)! : 1000;
    return ra - rb;
  });
}

export function listQwenVoicesForLanguage(
  languageType?: string | null,
  _model?: string | null
): {
  presets: QwenTtsVoiceOption[];
  others: QwenTtsVoiceOption[];
} {
  const lang = String(languageType || 'Auto').trim() || 'Auto';
  const presets: QwenTtsVoiceOption[] = [];
  const others: QwenTtsVoiceOption[] = [];
  for (const voice of QWEN_TTS_VOICE_CATALOG) {
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
  _model?: string | null
): string {
  const lang = String(languageType || 'Auto').trim() || 'Auto';
  const { presets, others } = listQwenVoicesForLanguage(lang);
  const available = [...presets, ...others];
  const current = toIrodoriSpeakerId(currentVoice);
  const keepCurrent =
    current &&
    available.some((v) => v.id === current) &&
    !(lang === 'English' && (current === 'Vivian' || current === 'Serena' || current === 'Ono_Anna'));
  if (keepCurrent) return current;
  if (lang === 'English') {
    for (const id of QWEN_ENGLISH_DEEP_VOICE_IDS) {
      if (available.some((v) => v.id === id)) return id;
    }
  }
  if (lang === 'Japanese') return 'Ono_Anna';
  if (lang === 'Korean') return 'Sohee';
  return presets[0]?.id || others[0]?.id || 'Ryan';
}

/** Preset tốc độ nói → phần instruct gửi CustomVoice (không có param speed số). */
export type IrodoriSpeedPreset = 'default' | 'slow' | 'normal' | 'fast';

export const IRODORI_SPEED_PRESETS: readonly {
  id: IrodoriSpeedPreset;
  label: string;
  instruct: string;
}[] = [
  { id: 'default', label: 'Mặc định', instruct: '' },
  { id: 'slow', label: 'Chậm', instruct: 'Speak slowly and calmly, with clear pauses.' },
  { id: 'normal', label: 'Vừa', instruct: 'Speak at a natural, steady pace.' },
  { id: 'fast', label: 'Nhanh', instruct: 'Speak quickly and energetically.' },
] as const;

export function isIrodoriSpeedPreset(value: unknown): value is IrodoriSpeedPreset {
  return value === 'default' || value === 'slow' || value === 'normal' || value === 'fast';
}

export function resolveIrodoriSpeedPreset(value?: string | null): IrodoriSpeedPreset {
  return isIrodoriSpeedPreset(value) ? value : 'default';
}

/**
 * Ghép preset tốc độ + instruct tùy chỉnh → 1 chuỗi `instruct` cho API.
 * Trả '' nếu không có gì (không gửi field instruct).
 */
export function buildIrodoriInstruct(
  speedPreset?: string | null,
  customInstruct?: string | null
): string {
  const preset = resolveIrodoriSpeedPreset(speedPreset);
  const speedPart =
    IRODORI_SPEED_PRESETS.find((p) => p.id === preset)?.instruct.trim() || '';
  const custom = String(customInstruct || '')
    .replace(/\s+/g, ' ')
    .trim();
  return [speedPart, custom].filter(Boolean).join(' ');
}

/** Optional instruct cho custom_voice — ép tone khi English / giọng trầm. */
export function buildQwenTtsInstructions(
  voiceId?: string | null,
  languageType?: string | null
): string | undefined {
  const lang = String(languageType || 'Auto').trim() || 'Auto';
  const voice = toIrodoriSpeakerId(voiceId);
  const deep =
    lang === 'English' ||
    (QWEN_ENGLISH_DEEP_VOICE_IDS as readonly string[]).includes(voice) ||
    voice === 'Uncle_Fu';

  if (!deep) return undefined;

  return (
    'Speak with a deep, low, resonant chest voice. ' +
    'Calm documentary narrator: steady pace, clear diction, warm and authoritative. ' +
    'Avoid bright, youthful, nasal, or high-pitched tone.'
  );
}

export function resolveQwenTtsVoice(
  voiceId?: string | null,
  languageType?: string | null,
  _model?: string | null
): string {
  return pickQwenVoiceForLanguage(languageType || 'Auto', voiceId);
}

export function getQwenVoiceOption(voiceId?: string | null): QwenTtsVoiceOption | undefined {
  const id = toIrodoriSpeakerId(voiceId);
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
