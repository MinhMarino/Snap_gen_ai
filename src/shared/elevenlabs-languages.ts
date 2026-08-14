/**
 * Ngôn ngữ ElevenLabs hỗ trợ (Eleven v3 ≈ 74).
 * Nguồn: https://help.elevenlabs.io/hc/en-us/articles/13313366263441
 * `id` = ISO 639-1 (hoặc mã phổ biến trên Voice Library labels).
 * `flag` = ISO 3166-1 alpha-2 cho icon cờ.
 */
export type ElevenLabsLanguage = {
  id: string;
  label: string;
  flag: string;
  /** Alias khớp label voice (language / locale / accent). */
  aliases?: string[];
};

export const ELEVENLABS_LANGUAGES: ElevenLabsLanguage[] = [
  { id: 'af', label: 'Afrikaans', flag: 'ZA', aliases: ['afrikaans', 'afr'] },
  { id: 'ar', label: 'Arabic', flag: 'SA', aliases: ['arabic', 'ara'] },
  { id: 'hy', label: 'Armenian', flag: 'AM', aliases: ['armenian', 'hye'] },
  { id: 'as', label: 'Assamese', flag: 'IN', aliases: ['assamese', 'asm'] },
  { id: 'az', label: 'Azerbaijani', flag: 'AZ', aliases: ['azerbaijani', 'aze'] },
  { id: 'be', label: 'Belarusian', flag: 'BY', aliases: ['belarusian', 'bel'] },
  { id: 'bn', label: 'Bengali', flag: 'BD', aliases: ['bengali', 'ben'] },
  { id: 'bs', label: 'Bosnian', flag: 'BA', aliases: ['bosnian', 'bos'] },
  { id: 'bg', label: 'Bulgarian', flag: 'BG', aliases: ['bulgarian', 'bul'] },
  { id: 'ca', label: 'Catalan', flag: 'ES', aliases: ['catalan', 'cat'] },
  { id: 'ceb', label: 'Cebuano', flag: 'PH', aliases: ['cebuano'] },
  { id: 'ny', label: 'Chichewa', flag: 'MW', aliases: ['chichewa', 'nya', 'nyanja'] },
  { id: 'hr', label: 'Croatian', flag: 'HR', aliases: ['croatian', 'hrv'] },
  { id: 'cs', label: 'Czech', flag: 'CZ', aliases: ['czech', 'ces'] },
  { id: 'da', label: 'Danish', flag: 'DK', aliases: ['danish', 'dan'] },
  { id: 'nl', label: 'Dutch', flag: 'NL', aliases: ['dutch', 'nld'] },
  { id: 'en', label: 'English', flag: 'GB', aliases: ['english', 'eng'] },
  { id: 'et', label: 'Estonian', flag: 'EE', aliases: ['estonian', 'est'] },
  { id: 'fil', label: 'Filipino', flag: 'PH', aliases: ['filipino', 'tl', 'tagalog'] },
  { id: 'fi', label: 'Finnish', flag: 'FI', aliases: ['finnish', 'fin'] },
  { id: 'fr', label: 'French', flag: 'FR', aliases: ['french', 'fra'] },
  { id: 'gl', label: 'Galician', flag: 'ES', aliases: ['galician', 'glg'] },
  { id: 'ka', label: 'Georgian', flag: 'GE', aliases: ['georgian', 'kat'] },
  { id: 'de', label: 'German', flag: 'DE', aliases: ['german', 'deu'] },
  { id: 'el', label: 'Greek', flag: 'GR', aliases: ['greek', 'ell'] },
  { id: 'gu', label: 'Gujarati', flag: 'IN', aliases: ['gujarati', 'guj'] },
  { id: 'ha', label: 'Hausa', flag: 'NG', aliases: ['hausa', 'hau'] },
  { id: 'he', label: 'Hebrew', flag: 'IL', aliases: ['hebrew', 'heb'] },
  { id: 'hi', label: 'Hindi', flag: 'IN', aliases: ['hindi', 'hin'] },
  { id: 'hu', label: 'Hungarian', flag: 'HU', aliases: ['hungarian', 'hun'] },
  { id: 'is', label: 'Icelandic', flag: 'IS', aliases: ['icelandic', 'isl'] },
  { id: 'id', label: 'Indonesian', flag: 'ID', aliases: ['indonesian', 'ind'] },
  { id: 'ga', label: 'Irish', flag: 'IE', aliases: ['irish', 'gle'] },
  { id: 'it', label: 'Italian', flag: 'IT', aliases: ['italian', 'ita'] },
  { id: 'ja', label: 'Japanese', flag: 'JP', aliases: ['japanese', 'jpn', 'jp'] },
  { id: 'jv', label: 'Javanese', flag: 'ID', aliases: ['javanese', 'jav'] },
  { id: 'kn', label: 'Kannada', flag: 'IN', aliases: ['kannada', 'kan'] },
  { id: 'kk', label: 'Kazakh', flag: 'KZ', aliases: ['kazakh', 'kaz'] },
  { id: 'ky', label: 'Kirghiz', flag: 'KG', aliases: ['kirghiz', 'kyrgyz', 'kir'] },
  { id: 'ko', label: 'Korean', flag: 'KR', aliases: ['korean', 'kor', 'kr'] },
  { id: 'lv', label: 'Latvian', flag: 'LV', aliases: ['latvian', 'lav'] },
  { id: 'ln', label: 'Lingala', flag: 'CD', aliases: ['lingala', 'lin'] },
  { id: 'lt', label: 'Lithuanian', flag: 'LT', aliases: ['lithuanian', 'lit'] },
  { id: 'lb', label: 'Luxembourgish', flag: 'LU', aliases: ['luxembourgish', 'ltz'] },
  { id: 'mk', label: 'Macedonian', flag: 'MK', aliases: ['macedonian', 'mkd'] },
  { id: 'ms', label: 'Malay', flag: 'MY', aliases: ['malay', 'msa'] },
  { id: 'ml', label: 'Malayalam', flag: 'IN', aliases: ['malayalam', 'mal'] },
  { id: 'zh', label: 'Chinese', flag: 'CN', aliases: ['chinese', 'mandarin', 'cmn', 'zh-cn', 'zh-hans'] },
  { id: 'mr', label: 'Marathi', flag: 'IN', aliases: ['marathi', 'mar'] },
  { id: 'ne', label: 'Nepali', flag: 'NP', aliases: ['nepali', 'nep'] },
  { id: 'no', label: 'Norwegian', flag: 'NO', aliases: ['norwegian', 'nor'] },
  { id: 'ps', label: 'Pashto', flag: 'AF', aliases: ['pashto', 'pus'] },
  { id: 'fa', label: 'Persian', flag: 'IR', aliases: ['persian', 'farsi', 'fas'] },
  { id: 'pl', label: 'Polish', flag: 'PL', aliases: ['polish', 'pol'] },
  { id: 'pt', label: 'Portuguese', flag: 'PT', aliases: ['portuguese', 'por'] },
  { id: 'pa', label: 'Punjabi', flag: 'IN', aliases: ['punjabi', 'pan'] },
  { id: 'ro', label: 'Romanian', flag: 'RO', aliases: ['romanian', 'ron'] },
  { id: 'ru', label: 'Russian', flag: 'RU', aliases: ['russian', 'rus'] },
  { id: 'sr', label: 'Serbian', flag: 'RS', aliases: ['serbian', 'srp'] },
  { id: 'sd', label: 'Sindhi', flag: 'PK', aliases: ['sindhi', 'snd'] },
  { id: 'sk', label: 'Slovak', flag: 'SK', aliases: ['slovak', 'slk'] },
  { id: 'sl', label: 'Slovenian', flag: 'SI', aliases: ['slovenian', 'slv'] },
  { id: 'so', label: 'Somali', flag: 'SO', aliases: ['somali', 'som'] },
  { id: 'es', label: 'Spanish', flag: 'ES', aliases: ['spanish', 'spa'] },
  { id: 'sw', label: 'Swahili', flag: 'KE', aliases: ['swahili', 'swa'] },
  { id: 'sv', label: 'Swedish', flag: 'SE', aliases: ['swedish', 'swe'] },
  { id: 'ta', label: 'Tamil', flag: 'IN', aliases: ['tamil', 'tam'] },
  { id: 'te', label: 'Telugu', flag: 'IN', aliases: ['telugu', 'tel'] },
  { id: 'th', label: 'Thai', flag: 'TH', aliases: ['thai', 'tha'] },
  { id: 'tr', label: 'Turkish', flag: 'TR', aliases: ['turkish', 'tur'] },
  { id: 'uk', label: 'Ukrainian', flag: 'UA', aliases: ['ukrainian', 'ukr', 'ua'] },
  { id: 'ur', label: 'Urdu', flag: 'PK', aliases: ['urdu', 'urd'] },
  {
    id: 'vi',
    label: 'Vietnamese',
    flag: 'VN',
    aliases: ['vietnamese', 'vie', 'vietnam', 'tiếng việt', 'vn'],
  },
  { id: 'cy', label: 'Welsh', flag: 'GB', aliases: ['welsh', 'cym'] },
];

export type ElevenLabsAccent = {
  id: string;
  label: string;
  flag: string;
  aliases?: string[];
};

/** Accent / vùng phổ biến trên Voice Library. */
export const ELEVENLABS_ACCENTS: ElevenLabsAccent[] = [
  { id: 'american', label: 'American', flag: 'US', aliases: ['us', 'usa', 'en-us', 'en_us'] },
  { id: 'british', label: 'British', flag: 'GB', aliases: ['england', 'en-gb', 'en_gb', 'uk'] },
  { id: 'australian', label: 'Australian', flag: 'AU', aliases: ['australia', 'en-au'] },
  { id: 'canadian', label: 'Canadian', flag: 'CA', aliases: ['canada', 'en-ca'] },
  { id: 'indian', label: 'Indian', flag: 'IN', aliases: ['india', 'en-in'] },
  { id: 'irish', label: 'Irish', flag: 'IE', aliases: ['ireland'] },
  { id: 'scottish', label: 'Scottish', flag: 'GB', aliases: ['scotland'] },
  { id: 'south-african', label: 'South African', flag: 'ZA', aliases: ['south african', 'en-za'] },
  { id: 'new-zealand', label: 'New Zealand', flag: 'NZ', aliases: ['new zealand', 'en-nz'] },
  { id: 'mexican', label: 'Mexican', flag: 'MX', aliases: ['mexico', 'es-mx'] },
  { id: 'latam', label: 'Latin American', flag: 'MX', aliases: ['latin american', 'latin america'] },
  { id: 'brazilian', label: 'Brazilian', flag: 'BR', aliases: ['brazil', 'pt-br', 'pt_br'] },
  { id: 'peninsular', label: 'Peninsular', flag: 'ES', aliases: ['spain', 'castilian'] },
];

export function languageMatchTokens(lang: ElevenLabsLanguage): string[] {
  return [lang.id, lang.label, ...(lang.aliases || [])].map((s) => s.toLowerCase());
}

export function accentMatchTokens(accent: ElevenLabsAccent): string[] {
  return [accent.id, accent.label, ...(accent.aliases || [])].map((s) => s.toLowerCase());
}

/**
 * Mã ISO ('ja') → tên tiếng Anh ('Japanese'), dùng làm nhãn ngôn ngữ cho AI viết
 * kịch bản. Không khớp / rỗng → chuỗi rỗng, nghĩa là "tự nhận diện từ brief".
 */
export function elevenLabsLanguageLabel(id?: string | null): string {
  const value = String(id || '').trim().toLowerCase();
  if (!value) return '';
  return ELEVENLABS_LANGUAGES.find((l) => l.id === value)?.label || '';
}
