import type { AppSettings, ProjectVoiceSettings, TtsProvider } from './types';
import { DEFAULT_QWEN_TTS_MODEL } from './types';
import { resolveIrodoriSpeedPreset, resolveQwenTtsVoice } from './qwen-voices';

export {
  buildIrodoriInstruct,
  buildQwenTtsInstructions,
  filterQwenVoices,
  getQwenVoiceOption,
  isIrodoriSpeedPreset,
  isQwenInstructFlashModel,
  isQwenVoiceSupportedByModel,
  listQwenVoicesForLanguage,
  pickQwenVoiceForLanguage,
  qwenAgeLabel,
  qwenPurposeLabels,
  resolveIrodoriSpeedPreset,
  resolveQwenTtsVoice,
  toIrodoriSpeakerId,
  DEFAULT_RUNPOD_ENDPOINT_ID,
  IRODORI_SPEED_PRESETS,
  QWEN_ENGLISH_DEEP_VOICE_IDS,
  QWEN_TTS_MODEL,
  QWEN_TTS_VOICE_CATALOG,
  QWEN_VOICE_AGES,
  QWEN_VOICE_PURPOSES,
} from './qwen-voices';
export type { IrodoriSpeedPreset, QwenVoiceFilter } from './qwen-voices';

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
  return (
    value === 'openai' || value === 'elevenlabs' || value === 'qwen' || value === 'genmax'
  );
}

function resolveGenmaxBackendField(
  value?: string | null
): ProjectVoiceSettings['genmaxBackend'] {
  if (value === 'minimax' || value === 'capcut' || value === 'elevenlabs') return value;
  return 'elevenlabs';
}

/** Tạm ẩn khỏi UI chọn giọng (vẫn giữ code/pipeline). */
export const TTS_PROVIDERS_TEMPORARILY_HIDDEN: ReadonlySet<TtsProvider> = new Set([
  'openai',
  'qwen',
]);

export function coerceSelectableTtsProvider(provider: TtsProvider): TtsProvider {
  if (TTS_PROVIDERS_TEMPORARILY_HIDDEN.has(provider)) return 'genmax';
  return provider;
}

export const DEFAULT_PROJECT_VOICE: ProjectVoiceSettings = {
  ttsProvider: 'genmax',
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiTtsVoice: 'onyx',
  elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  elevenLabsModelId: 'eleven_flash_v2_5',
  qwenTtsModel: DEFAULT_QWEN_TTS_MODEL,
  qwenTtsVoice: 'Ryan',
  qwenLanguageType: 'English',
  qwenRegion: 'singapore',
  qwenSpeedPreset: 'default',
  qwenInstruct: '',
  genmaxBackend: 'elevenlabs',
  genmaxVoiceId: 'hpp4J3VqNfWAUOO0d1Us',
  genmaxModelId: 'eleven_flash_v2_5',
};

export function projectDraftHasVoice(
  partial: Partial<ProjectVoiceSettings> | null | undefined
): boolean {
  if (!partial) return false;
  return (
    isTtsProvider(partial.ttsProvider) ||
    Boolean(partial.openaiTtsVoice) ||
    Boolean(partial.elevenLabsVoiceId) ||
    Boolean(partial.qwenTtsVoice) ||
    Boolean(partial.genmaxVoiceId)
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
    ttsProvider: coerceSelectableTtsProvider(
      isTtsProvider(defaults?.ttsProvider)
        ? defaults.ttsProvider
        : DEFAULT_PROJECT_VOICE.ttsProvider
    ),
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
    qwenSpeedPreset: resolveIrodoriSpeedPreset(
      defaults?.qwenSpeedPreset || DEFAULT_PROJECT_VOICE.qwenSpeedPreset
    ),
    qwenInstruct: defaults?.qwenInstruct?.trim() || DEFAULT_PROJECT_VOICE.qwenInstruct,
    genmaxBackend: resolveGenmaxBackendField(
      defaults?.genmaxBackend || DEFAULT_PROJECT_VOICE.genmaxBackend
    ),
    genmaxVoiceId: defaults?.genmaxVoiceId || DEFAULT_PROJECT_VOICE.genmaxVoiceId,
    genmaxModelId: defaults?.genmaxModelId || DEFAULT_PROJECT_VOICE.genmaxModelId,
  };
  if (!projectDraftHasVoice(partial)) return base;
  const qwenLanguageType = partial!.qwenLanguageType || base.qwenLanguageType;
  return {
    ttsProvider: coerceSelectableTtsProvider(
      isTtsProvider(partial!.ttsProvider) ? partial!.ttsProvider : base.ttsProvider
    ),
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
    qwenSpeedPreset: resolveIrodoriSpeedPreset(
      partial!.qwenSpeedPreset ?? base.qwenSpeedPreset
    ),
    qwenInstruct:
      partial!.qwenInstruct !== undefined
        ? String(partial!.qwenInstruct || '').trim()
        : base.qwenInstruct,
    genmaxBackend: resolveGenmaxBackendField(partial!.genmaxBackend ?? base.genmaxBackend),
    genmaxVoiceId: partial!.genmaxVoiceId || base.genmaxVoiceId,
    genmaxModelId: partial!.genmaxModelId || base.genmaxModelId,
    genmaxVoiceName: partial!.genmaxVoiceName?.trim() || undefined,
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
