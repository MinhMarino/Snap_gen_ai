import type { AppSettings, ProjectVoiceSettings, TtsProvider } from './types';
import { DEFAULT_QWEN_TTS_MODEL } from './types';
import { resolveQwenTtsVoice } from './qwen-voices';

export {
  buildQwenTtsInstructions,
  filterQwenVoices,
  getQwenVoiceOption,
  isQwenInstructFlashModel,
  isQwenVoiceSupportedByModel,
  listQwenVoicesForLanguage,
  pickQwenVoiceForLanguage,
  qwenAgeLabel,
  qwenPurposeLabels,
  resolveQwenTtsVoice,
  QWEN_ENGLISH_DEEP_VOICE_IDS,
  QWEN_TTS_MODEL,
  QWEN_TTS_VOICE_CATALOG,
  QWEN_VOICE_AGES,
  QWEN_VOICE_PURPOSES,
} from './qwen-voices';
export type { QwenVoiceFilter } from './qwen-voices';

export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-4o-mini';

/** Model viết kịch bản theo dự án; fallback Settings → default. */
export function resolveProjectChatModel(
  draftModel?: string | null,
  settingsDefault?: string | null
): string {
  const value = String(draftModel || settingsDefault || DEFAULT_OPENAI_CHAT_MODEL).trim();
  return value || DEFAULT_OPENAI_CHAT_MODEL;
}

function isTtsProvider(value: unknown): value is TtsProvider {
  return value === 'openai' || value === 'elevenlabs' || value === 'qwen';
}

export const DEFAULT_PROJECT_VOICE: ProjectVoiceSettings = {
  ttsProvider: 'openai',
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiTtsVoice: 'onyx',
  elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  elevenLabsModelId: 'eleven_flash_v2_5',
  qwenTtsModel: DEFAULT_QWEN_TTS_MODEL,
  qwenTtsVoice: 'Vincent',
  qwenLanguageType: 'English',
  qwenRegion: 'singapore',
};

export function projectDraftHasVoice(
  partial: Partial<ProjectVoiceSettings> | null | undefined
): boolean {
  if (!partial) return false;
  return (
    isTtsProvider(partial.ttsProvider) ||
    Boolean(partial.openaiTtsVoice) ||
    Boolean(partial.elevenLabsVoiceId) ||
    Boolean(partial.qwenTtsVoice)
  );
}

/**
 * Gộp voice từ draft/input với default app (cho dự án cũ thiếu field).
 * Nếu draft đã có voice → ưu tiên tuyệt đối draft (không lấy Settings ghi đè).
 */
export function resolveProjectVoice(
  partial: Partial<ProjectVoiceSettings> | null | undefined,
  defaults?: Partial<AppSettings> | null
): ProjectVoiceSettings {
  const base: ProjectVoiceSettings = {
    ttsProvider: isTtsProvider(defaults?.ttsProvider)
      ? defaults.ttsProvider
      : DEFAULT_PROJECT_VOICE.ttsProvider,
    openaiTtsModel: defaults?.openaiTtsModel || DEFAULT_PROJECT_VOICE.openaiTtsModel,
    openaiTtsVoice: defaults?.openaiTtsVoice || DEFAULT_PROJECT_VOICE.openaiTtsVoice,
    elevenLabsVoiceId: defaults?.elevenLabsVoiceId || DEFAULT_PROJECT_VOICE.elevenLabsVoiceId,
    elevenLabsModelId: defaults?.elevenLabsModelId || DEFAULT_PROJECT_VOICE.elevenLabsModelId,
    qwenTtsModel: DEFAULT_QWEN_TTS_MODEL,
    qwenTtsVoice: resolveQwenTtsVoice(
      defaults?.qwenTtsVoice || DEFAULT_PROJECT_VOICE.qwenTtsVoice,
      defaults?.qwenLanguageType || DEFAULT_PROJECT_VOICE.qwenLanguageType
    ),
    qwenLanguageType: defaults?.qwenLanguageType || DEFAULT_PROJECT_VOICE.qwenLanguageType,
    qwenRegion: 'singapore',
  };
  if (!projectDraftHasVoice(partial)) return base;
  const qwenLanguageType = partial!.qwenLanguageType || base.qwenLanguageType;
  return {
    ttsProvider: isTtsProvider(partial!.ttsProvider) ? partial!.ttsProvider : base.ttsProvider,
    openaiTtsModel: partial!.openaiTtsModel || base.openaiTtsModel,
    openaiTtsVoice: partial!.openaiTtsVoice || base.openaiTtsVoice,
    elevenLabsVoiceId: partial!.elevenLabsVoiceId || base.elevenLabsVoiceId,
    elevenLabsModelId: partial!.elevenLabsModelId || base.elevenLabsModelId,
    elevenLabsPublicOwnerId: partial!.elevenLabsPublicOwnerId?.trim() || undefined,
    elevenLabsOriginalVoiceId: partial!.elevenLabsOriginalVoiceId?.trim() || undefined,
    elevenLabsVoiceName: partial!.elevenLabsVoiceName?.trim() || undefined,
    qwenTtsModel: DEFAULT_QWEN_TTS_MODEL,
    qwenTtsVoice: resolveQwenTtsVoice(
      partial!.qwenTtsVoice || base.qwenTtsVoice,
      qwenLanguageType
    ),
    qwenLanguageType,
    qwenRegion: 'singapore',
  };
}

/** Map ngôn ngữ dự án → DashScope language_type (không có Vietnamese → Auto). */
export function resolveQwenLanguageType(
  preferred?: string | null,
  projectLanguage?: string | null
): string {
  const direct = String(preferred || '').trim();
  if (direct) return direct;

  const lang = String(projectLanguage || '').toLowerCase();
  if (!lang) return 'Auto';
  if (lang.includes('中') || lang.includes('chinese') || lang.includes('mandarin') || lang === 'zh') {
    return 'Chinese';
  }
  if (lang.includes('en') || lang.includes('english') || lang.includes('anh')) return 'English';
  if (lang.includes('ja') || lang.includes('japan') || lang.includes('nhật')) return 'Japanese';
  if (lang.includes('ko') || lang.includes('korea') || lang.includes('hàn')) return 'Korean';
  if (lang.includes('fr') || lang.includes('french') || lang.includes('pháp')) return 'French';
  if (lang.includes('de') || lang.includes('german') || lang.includes('đức')) return 'German';
  if (lang.includes('es') || lang.includes('spanish') || lang.includes('tây ban')) return 'Spanish';
  if (lang.includes('pt') || lang.includes('portug')) return 'Portuguese';
  if (lang.includes('it') || lang.includes('ital')) return 'Italian';
  if (lang.includes('ru') || lang.includes('russ')) return 'Russian';
  return 'Auto';
}
