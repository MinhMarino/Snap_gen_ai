import type { ImageFamily, MediaKind, ModelOption, VideoFamily } from './types';

export const VIDEO_FAMILIES: { id: VideoFamily; label: string }[] = [
  { id: 'veo', label: 'Veo / Omni' },
  { id: 'sora', label: 'Sora' },
  { id: 'grok', label: 'Grok' },
  { id: 'seedance', label: 'Seedance' },
  { id: 'kling', label: 'Kling' },
  { id: 'meta', label: 'Meta AI' },
];

export const IMAGE_FAMILIES: { id: ImageFamily; label: string }[] = [
  { id: 'snapgen-image', label: 'Snapgen Image' },
  { id: 'gpt-image', label: 'GPT Image' },
  { id: 'grok-image', label: 'Grok Image' },
];

export const DEFAULT_VIDEO_FAMILY: VideoFamily = 'veo';
export const DEFAULT_VIDEO_MODEL_ID = 'veo-3.1-fast';
export const DEFAULT_IMAGE_FAMILY: ImageFamily = 'snapgen-image';
export const DEFAULT_IMAGE_MODEL_ID = 'nano-banana-2';
/** Ngôn ngữ kịch bản/TTS mặc định; visual prompt luôn English, không chữ trên màn hình. */
export const DEFAULT_PROJECT_LANGUAGE = 'English';

/**
 * Style mặc định: video học tập đơn giản cho trẻ nhỏ, cảm hứng Pingpong / kids cartoon.
 * Visual: mascot động vật & đồ vật — KHÔNG mô tả trẻ em (Snapgen/Google chặn).
 */
export const DEFAULT_STYLE_PROMPT =
  'Simple Pingpong-style kids learning cartoon: bright flat colors, soft rounded shapes, ' +
  'cute animal or toy mascots, big friendly expressions, playful gentle bounce motion, ' +
  'clean uncluttered backgrounds, warm cheerful lighting. No readable text on screen. ' +
  'Never depict real children or babies — only animals, toys, and everyday objects as characters.';

/**
 * Style mặc định cho dự án hoạt hình nhạc.
 * DEFAULT_STYLE_PROMPT (kids cartoon) hoàn toàn sai cho music video — nếu user
 * không tự sửa thì mọi scene MV đều bị bọc style "mascot học chữ cho trẻ".
 */
export const MUSIC_ANIMATION_STYLE_PROMPT =
  'Cinematic anime music-video illustration: painterly key-frame quality, expressive characters, ' +
  'rich rim lighting and bloom, atmospheric depth (foreground / midground / background layers), ' +
  'saturated but harmonious palette, film grain, dramatic sky and weather as emotional backdrop. ' +
  'No readable text on screen.';

export function defaultStylePromptForProjectKind(kind?: string | null): string {
  return String(kind || '') === 'music-animation'
    ? MUSIC_ANIMATION_STYLE_PROMPT
    : DEFAULT_STYLE_PROMPT;
}

export function defaultFamilyForKind(kind: MediaKind): VideoFamily | ImageFamily {
  return kind === 'image' ? DEFAULT_IMAGE_FAMILY : DEFAULT_VIDEO_FAMILY;
}

export function defaultModelIdForKind(kind: MediaKind): string {
  return kind === 'image' ? DEFAULT_IMAGE_MODEL_ID : DEFAULT_VIDEO_MODEL_ID;
}

export const VIDEO_MODELS: ModelOption[] = [
  {
    id: 'veo-3.1-fast',
    label: 'Veo 3.1 Fast',
    family: 'veo',
    kind: 'video',
    durations: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    defaultDuration: 8,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'veo-3.1',
    label: 'Veo 3.1',
    family: 'veo',
    kind: 'video',
    durations: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    defaultDuration: 8,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'veo-3.1-lite',
    label: 'Veo 3.1 Lite',
    family: 'veo',
    kind: 'video',
    durations: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    defaultDuration: 8,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'veo-2',
    label: 'Veo 2',
    family: 'veo',
    kind: 'video',
    durations: [4, 6, 8],
    resolutions: ['720p'],
    aspectRatios: ['16:9', '9:16'],
    defaultDuration: 8,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'omni-flash',
    label: 'Omni Flash',
    family: 'veo',
    kind: 'video',
    durations: [10],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    defaultDuration: 10,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'sora-2',
    label: 'Sora 2',
    family: 'sora',
    kind: 'video',
    durations: [10, 15],
    resolutions: ['small'],
    aspectRatios: ['landscape', 'portrait'],
    defaultDuration: 10,
    defaultResolution: 'small',
    defaultAspectRatio: 'landscape',
  },
  {
    id: 'sora-2-pro',
    label: 'Sora 2 Pro',
    family: 'sora',
    kind: 'video',
    durations: [25],
    resolutions: ['small'],
    aspectRatios: ['landscape', 'portrait'],
    defaultDuration: 25,
    defaultResolution: 'small',
    defaultAspectRatio: 'landscape',
  },
  {
    id: 'sora-2-pro-hd',
    label: 'Sora 2 Pro HD',
    family: 'sora',
    kind: 'video',
    durations: [15],
    resolutions: ['large'],
    aspectRatios: ['landscape', 'portrait'],
    defaultDuration: 15,
    defaultResolution: 'large',
    defaultAspectRatio: 'landscape',
  },
  {
    id: 'grok-3',
    label: 'Grok 3',
    family: 'grok',
    kind: 'video',
    durations: [6, 10, 15],
    resolutions: ['480p', '720p'],
    aspectRatios: ['landscape', 'portrait', 'square'],
    defaultDuration: 10,
    defaultResolution: '720p',
    defaultAspectRatio: 'landscape',
    extraFields: {
      mode: ['custom', 'normal', 'extremely-crazy', 'extremely-spicy-or-crazy'],
    },
  },
  {
    id: 'seedance-2',
    label: 'Seedance 2',
    family: 'seedance',
    kind: 'video',
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ['720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
    defaultDuration: 8,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['fast', 'pro'] },
  },
  {
    id: 'seedance-2-omni',
    label: 'Seedance 2 Omni',
    family: 'seedance',
    kind: 'video',
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ['720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
    defaultDuration: 10,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['fast', 'pro', 'fast-2', 'pro-2', 'fast-vip', 'pro-vip'] },
  },
  {
    id: 'kling-video-3-0',
    label: 'Kling Video 3.0',
    family: 'kling',
    kind: 'video',
    durations: [5, 8, 10, 15],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultDuration: 8,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['standard', 'professional'] },
  },
  {
    id: 'kling-video-2-6',
    label: 'Kling Video 2.6',
    family: 'kling',
    kind: 'video',
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultDuration: 5,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['standard', 'professional', 'professional_audio'] },
  },
  {
    id: 'kling-video-2-5',
    label: 'Kling Video 2.5',
    family: 'kling',
    kind: 'video',
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultDuration: 5,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['relax', 'standard', 'professional'] },
  },
  {
    id: 'kling-video-o1',
    label: 'Kling Video O1',
    family: 'kling',
    kind: 'video',
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultDuration: 5,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['standard', 'professional'] },
  },
  {
    id: 'meta-ai-video',
    label: 'Meta AI Video',
    family: 'meta',
    kind: 'video',
    durations: [5, 10],
    resolutions: ['720p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultDuration: 5,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
  },
];

export const IMAGE_MODELS: ModelOption[] = [
  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2',
    family: 'snapgen-image',
    kind: 'image',
    durations: [4, 5, 6, 8, 10],
    resolutions: ['1K', '2K'],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    defaultDuration: 5,
    defaultResolution: '1K',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'nano-banana-2-lite',
    label: 'Nano Banana 2 Lite',
    family: 'snapgen-image',
    kind: 'image',
    durations: [4, 5, 6, 8, 10],
    resolutions: ['1K', '2K'],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    defaultDuration: 5,
    defaultResolution: '1K',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    family: 'snapgen-image',
    kind: 'image',
    durations: [4, 5, 6, 8, 10],
    resolutions: ['1K', '2K'],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    defaultDuration: 5,
    defaultResolution: '1K',
    defaultAspectRatio: '16:9',
  },
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    family: 'gpt-image',
    kind: 'image',
    durations: [4, 5, 6, 8, 10],
    resolutions: ['1k', '2k', '4k'],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'],
    defaultDuration: 5,
    defaultResolution: '2k',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['low', 'medium', 'high'] },
  },
  {
    id: 'grok-image',
    label: 'Grok Image',
    family: 'grok-image',
    kind: 'image',
    durations: [4, 5, 6, 8, 10],
    resolutions: ['default'],
    aspectRatios: ['landscape', 'portrait', 'square'],
    defaultDuration: 5,
    defaultResolution: 'default',
    defaultAspectRatio: 'landscape',
    extraFields: { mode: ['normal', 'fun', 'custom'] },
  },
];

export const ALL_MODELS: ModelOption[] = [...VIDEO_MODELS, ...IMAGE_MODELS];

/** Old Snapgen image model ids → current allowed ids. */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'imagen-4': 'nano-banana-2',
  'imagen-3': 'nano-banana-2',
  'flux-kontext-pro': 'nano-banana-pro',
  'flux-kontext': 'nano-banana-pro',
};

export function resolveModelId(modelId: string): string {
  return LEGACY_MODEL_ALIASES[modelId] || modelId;
}

export function getFamilies(kind: MediaKind): { id: string; label: string }[] {
  return kind === 'image' ? IMAGE_FAMILIES : VIDEO_FAMILIES;
}

export function getModelsByFamily(family: string, kind?: MediaKind): ModelOption[] {
  const pool = kind ? ALL_MODELS.filter((m) => m.kind === kind) : ALL_MODELS;
  return pool.filter((m) => m.family === family);
}

export function getModelById(id: string): ModelOption | undefined {
  return ALL_MODELS.find((m) => m.id === id);
}

export function clampDuration(modelId: string, hint: number): number {
  const model = getModelById(modelId);
  if (!model) return hint;
  return model.durations.reduce((best, d) =>
    Math.abs(d - hint) < Math.abs(best - hint) ? d : best
  );
}

/** Max seconds one API generate/extend call can produce for this model. */
export function maxSingleShotDuration(modelId: string): number {
  const model = getModelById(modelId);
  if (!model?.durations.length) return 8;
  return Math.max(...model.durations);
}

export function familySupportsExtend(family: string): boolean {
  return family === 'veo' || family === 'grok' || family === 'seedance' || family === 'kling';
}

/**
 * Plan how to cover a long scene:
 * - short scene → one generate
 * - long + supports extend → first generate, then extend chunks (same scene continuity)
 * - long + no extend → multiple independent generates (hard cuts inside scene)
 *
 * Across scenes: pipeline may chain via video-extend `ref_history` when familySupportsExtend.
 */
export function planSceneChunks(
  modelId: string,
  family: string,
  desiredSeconds: number
): { mode: 'single' | 'extend' | 'multi-cut'; chunks: number[] } {
  const max = Math.max(1, maxSingleShotDuration(modelId));
  // Chặn duration_hint lỗi / quá lớn — tránh vòng extend hàng trăm shot.
  const desired = Math.min(Math.max(1, Number(desiredSeconds) || 1), max * 20);

  if (desired <= max + 0.25) {
    return { mode: 'single', chunks: [clampDuration(modelId, desired)] };
  }

  // Scene chỉ dài hơn max một ít (vd. 11–12s với Veo 8s): gen 1 shot max
  // thay vì 2 đoạn + FFmpeg concat (hay treo / rất chậm trên ổ ngoài).
  if (desired <= max * 1.5) {
    return { mode: 'single', chunks: [clampDuration(modelId, max)] };
  }

  const chunks: number[] = [];
  let left = desired;
  const maxChunks = 20;
  while (left > 0.4 && chunks.length < maxChunks) {
    const take = Math.min(left, max);
    if (!(take > 0)) break;
    chunks.push(clampDuration(modelId, take));
    left -= take;
  }

  if (!chunks.length) {
    return { mode: 'single', chunks: [clampDuration(modelId, Math.min(desired, max))] };
  }

  if (familySupportsExtend(family)) {
    return { mode: 'extend', chunks };
  }
  return { mode: 'multi-cut', chunks };
}

export function withStylePrompt(visualPrompt: string, stylePrompt?: string): string {
  const style = stylePrompt?.trim();
  if (!style) return visualPrompt;
  if (visualPrompt.toLowerCase().includes(style.toLowerCase())) return visualPrompt;
  return `${visualPrompt.trim()}. Style: ${style}`;
}

/** Gợi ý văn hóa / nhân vật theo language setting — dùng cho image prompt. */
export function resolveVisualLocaleHint(language?: string | null): string | null {
  const value = String(language || '').toLowerCase();
  if (!value) return null;
  if (/japan|日本語|nihongo|tiếng nhật|nhật bản|\bja\b/.test(value)) {
    return 'Japanese cultural setting; when people appear, depict them as Japanese with accurate age, clothing, and environment matching the narration';
  }
  if (/việt|vietnam|tiếng việt|\bvi\b/.test(value)) {
    return 'Vietnamese cultural setting; when people appear, depict them as Vietnamese with accurate age, clothing, and environment matching the narration';
  }
  if (/korean|한국어|hangul|tiếng hàn|hàn quốc|\bko\b/.test(value)) {
    return 'Korean cultural setting; when people appear, depict them as Korean with accurate age, clothing, and environment matching the narration';
  }
  if (/chinese|中文|mandarin|cantonese|tiếng trung|trung quốc|\bzh\b/.test(value)) {
    return 'Chinese cultural setting; when people appear, depict them as Chinese with accurate age, clothing, and environment matching the narration';
  }
  if (/english|tiếng anh|\ben\b/.test(value)) {
    return 'English-language / Western cultural setting when people and places appear; match the narration';
  }
  if (/thai|ไทย|tiếng thái|\bth\b/.test(value)) {
    return 'Thai cultural setting; when people appear, depict them as Thai with accurate age, clothing, and environment matching the narration';
  }
  return `Cultural setting matching language "${String(language).trim()}"; people and places must match that locale and the narration`;
}

/** Chỉ câu luật văn hóa — dùng chung cho standard lock và music wrapper. */
function resolveCultureRule(language?: string | null): string {
  const label = String(language || '').trim() || DEFAULT_PROJECT_LANGUAGE;
  const value = label.toLowerCase();

  if (/japan|日本語|nihongo|tiếng nhật|nhật bản|\bja\b/.test(value)) {
    return 'People, places, props, clothing, and atmosphere MUST match Japanese culture when applicable.';
  }
  if (/việt|vietnam|tiếng việt|\bvi\b/.test(value)) {
    return 'People, places, props, clothing, and atmosphere MUST match Vietnamese culture when applicable.';
  }
  if (/korean|한국어|hangul|tiếng hàn|hàn quốc|\bko\b/.test(value)) {
    return 'People, places, props, clothing, and atmosphere MUST match Korean culture when applicable.';
  }
  if (/chinese|中文|mandarin|cantonese|tiếng trung|trung quốc|\bzh\b/.test(value)) {
    return 'People, places, props, clothing, and atmosphere MUST match Chinese culture when applicable.';
  }
  if (/english|tiếng anh|\ben\b/.test(value)) {
    return 'People, places, props, clothing, and atmosphere should match Western/English cultural context when applicable.';
  }
  if (/thai|ไทย|tiếng thái|\bth\b/.test(value)) {
    return 'People, places, props, clothing, and atmosphere MUST match Thai culture when applicable.';
  }
  return `People, places, props, clothing, and atmosphere should match the "${label}" cultural context when applicable.`;
}

/**
 * Khóa visual: khớp văn hóa theo Language (kịch bản/TTS) nhưng không hiện chữ trên màn hình.
 */
export function resolveVisualLanguageLock(language?: string | null): string {
  return (
    `VISUAL RULE (mandatory): ${resolveCultureRule(language)} ` +
    `Do NOT show any readable text, subtitles, captions, signs, labels, screens, books, posters, or UI text in the frame. ` +
    `Purely visual storytelling — no written language on screen.`
  );
}

/**
 * Prompt gửi Snapgen: visual + style + locale + khóa language.
 * Không gắn narration — lời thoại chỉ dùng cho TTS/subtitle, không đưa vào prompt gen media.
 * visual_prompt ưu tiên English mô tả hình; không hiện chữ trên màn hình.
 */
export function buildSceneImagePrompt(options: {
  visualPrompt: string;
  language?: string | null;
  stylePrompt?: string;
}): string {
  let prompt = withStylePrompt(options.visualPrompt || '', options.stylePrompt);
  const locale = resolveVisualLocaleHint(options.language);
  const languageLock = resolveVisualLanguageLock(options.language);
  const lower = prompt.toLowerCase();

  if (locale) {
    const localeAlready =
      /japanese|vietnamese|korean|chinese|thai|english-language|cultural setting|locale/.test(
        lower
      ) || lower.includes(locale.slice(0, 24).toLowerCase());
    if (!localeAlready) {
      prompt = `${prompt.trim()}. Visual locale: ${locale}.`;
    }
  }

  if (!lower.includes('visual rule') && !lower.includes('language lock')) {
    prompt = `${prompt.trim()} ${languageLock}`;
  }

  return prompt.trim();
}

// ---------------------------------------------------------------------------
// Prompt wrapper riêng cho hoạt hình nhạc (music-animation)
// ---------------------------------------------------------------------------

/**
 * Cỡ cảnh luân phiên theo scene index.
 * MV mà mọi shot cùng cỡ thì xem rất chán — nhất là khi ảnh đã không zoom/pan nữa.
 * Chỉ áp dụng khi visual_prompt CHƯA tự nói cỡ cảnh.
 */
const MUSIC_SHOT_LADDER = [
  'wide establishing shot, full environment visible, subject small in frame',
  'medium shot, subject waist-up, balanced headroom',
  'intimate close-up on face and hands, shallow depth of field',
  'wide dynamic angle with a strong foreground element framing the subject',
  'low-angle hero shot looking up at the subject',
  'over-the-shoulder shot looking past the subject into the scene',
];

const FRAMING_ALREADY_RE =
  /close-?up|wide shot|wide angle|medium shot|establishing|extreme close|aerial|bird'?s[- ]eye|over[- ]the[- ]shoulder|low[- ]angle|high[- ]angle|macro|full[- ]body|two[- ]shot|profile shot/i;

/** Cấm cứng: chữ/lyric, watermark, ghép nhiều khung — 3 lỗi hay gặp nhất ở MV AI. */
const MUSIC_HARD_RULES =
  'HARD RULES: absolutely no readable text of any kind — no lyrics, captions, subtitles, ' +
  'song titles, credits, signs, logos, watermarks, timecodes or UI overlays; ' +
  'no split screen, collage, grid, comic panels, film strip, borders, frames or letterboxing; ' +
  'one single continuous image, edge to edge.';

/**
 * Một khung ĐỨNG YÊN: sau khi bỏ Ken Burns, ảnh phải tự đứng vững như một
 * key frame — mô tả chuyển động camera chỉ làm model vẽ blur / motion streak vô ích.
 */
const MUSIC_STILL_FRAME_RULE =
  'This is ONE HELD STILL FRAME (no camera movement, no zoom, no pan): ' +
  'sharp focus on the subject, no motion blur or speed lines, ' +
  'composition must read as a finished poster key-frame on its own.';

export interface MusicScenePromptOptions {
  visualPrompt: string;
  language?: string | null;
  stylePrompt?: string;
  /**
   * Cast/style bible ngắn, LẶP NGUYÊN VĂN ở mọi scene — cách rẻ nhất để chống
   * nhân vật "biến hình" giữa các scene (mỗi scene là một lần gen độc lập).
   */
  castLock?: string;
  /** Index scene (0-based) → luân phiên cỡ cảnh. */
  sceneIndex?: number;
  /** intro/body/outro → mức năng lượng của shot. */
  section?: string;
  /** true khi ảnh sẽ đứng yên trong video (music-animation + mediaKind image). */
  stillFrame?: boolean;
}

function musicEnergyLine(section?: string): string | null {
  const value = String(section || '').toLowerCase();
  if (value === 'introduction') {
    return 'Energy: restrained and establishing — softer, cooler light, more negative space.';
  }
  if (value === 'conclusion') {
    return 'Energy: resolving final beat — warm fading light, calm settled staging.';
  }
  return null;
}

/**
 * Prompt gửi Snapgen cho hoạt hình nhạc.
 *
 * Khác `buildSceneImagePrompt` ở 4 điểm:
 *  1. Cast lock đứng ĐẦU prompt (model ưu tiên phần đầu) → nhân vật nhất quán.
 *  2. Luân phiên cỡ cảnh khi storyboard không nói rõ → đỡ đơn điệu.
 *  3. Yêu cầu "một khung đứng yên" khi ảnh không còn Ken Burns.
 *  4. Cấm cứng chữ/lyric/watermark/ghép khung, không nhắc "narration"
 *     (MV không có narration — chỉ có lyric, và lyric KHÔNG được hiện lên hình).
 */
export function buildMusicSceneImagePrompt(options: MusicScenePromptOptions): string {
  const parts: string[] = [];

  const cast = options.castLock?.trim();
  if (cast) {
    parts.push(`CAST LOCK (identical in every shot, do not redesign): ${cast.slice(0, 600)}`);
  }

  const visual = options.visualPrompt?.trim() || '';
  parts.push(visual);

  if (options.sceneIndex != null && visual && !FRAMING_ALREADY_RE.test(visual)) {
    parts.push(
      `Framing: ${MUSIC_SHOT_LADDER[options.sceneIndex % MUSIC_SHOT_LADDER.length]}.`
    );
  }

  const energy = musicEnergyLine(options.section);
  if (energy) parts.push(energy);

  const style = options.stylePrompt?.trim();
  // Chỉ bỏ style khi nó thực sự đã nằm trong visual_prompt — style quá ngắn
  // (vài ký tự) rất dễ "trùng" ngẫu nhiên nên không dùng để loại.
  const styleAlready =
    !!style && style.length >= 12 && visual.toLowerCase().includes(style.toLowerCase());
  if (style && !styleAlready) {
    parts.push(`Style: ${style}`);
  }

  parts.push(resolveCultureRule(options.language));

  if (options.stillFrame) parts.push(MUSIC_STILL_FRAME_RULE);

  parts.push(MUSIC_HARD_RULES, SAFE_SUBJECT_RULE);

  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Chống prompt bị Google chặn (GEMINI_RAI_MEDIA_FILTERED)
// ---------------------------------------------------------------------------

/**
 * Luật an toàn gắn vào mọi prompt.
 * Google chặn: trẻ em/em bé, người thật & người nổi tiếng, nhân vật có bản quyền,
 * logo thương hiệu. Nhạc thiếu nhi rất dễ dính vì storyboard hay viết "a little boy".
 */
export const SAFE_SUBJECT_RULE =
  'SAFETY: all characters are original stylized adult cartoon characters or friendly ' +
  'animal / toy mascots. No children, babies or toddlers. No real people, celebrities ' +
  'or public figures. No copyrighted, branded or third-party characters, no brand logos.';

/** Số mức làm sạch prompt (0 = prompt gốc). */
export const MAX_PROMPT_SAFETY_LEVEL = 2;

/** Danh từ chỉ trẻ em (dùng chung cho biến thể có/không mạo từ). */
const CHILD_NOUNS =
  'boys?|girls?|kids?|child|children|schoolchildren|toddlers?|babies|baby|infants?|' +
  'schoolboys?|schoolgirls?|preschoolers?|pupils?|little sisters?|little brothers?|' +
  'sons?|daughters?|teenagers?|teens?|youngsters?|minors?';
const CHILD_QUALIFIERS = '(?:little\\s+|small\\s+|young\\s+|cute\\s+|baby\\s+|tiny\\s+)*';

/**
 * Mốc tuổi bị XÓA HẲN (không thay bằng "adult") — thay chữ sẽ đẻ ra
 * "a cheerful adult a cartoon mascot"; xóa rồi gộp khoảng trắng thì câu còn sạch.
 */
const AGE_PATTERNS: RegExp[] = [
  /\b\d{1,2}\s*[- ]?years?[- ]?old\b/gi,
  /\baged?\s+\d{1,2}\b/gi,
];

/** Từ chỉ trẻ em → mascot. Bắt luôn mạo từ đứng trước để câu không vỡ. */
const CHILD_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [new RegExp(`\\b(?:a|an|the)\\s+${CHILD_QUALIFIERS}(?:${CHILD_NOUNS})\\b`, 'gi'),
    'a friendly cartoon mascot'],
  [new RegExp(`\\b${CHILD_QUALIFIERS}(?:${CHILD_NOUNS})\\b`, 'gi'), 'friendly cartoon mascots'],
  [/\b(kindergarten|nursery|playschool|elementary school|primary school|school bus)\b/gi,
    'colourful town setting'],
  [/\b(childlike|childish|youthful innocence)\b/gi, 'playful'],
];

/** Người thật / nhân vật bản quyền — Google chặn chắc chắn, xử ngay từ mức 1. */
const LIKENESS_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(celebrity|celebrities|famous singer|pop star|movie star|influencer)\b/gi,
    'original character'],
  [/\b(real person|real people|photorealistic person|lookalike|resembling)\b/gi,
    'original character'],
  [
    /\b(disney|pixar|marvel|dc comics|pokemon|pokémon|hello kitty|doraemon|mickey mouse|elsa|spider-?man|batman|superman)\b/gi,
    'original design',
  ],
  [/\b(brand\s+)?(logos?|branded|trademark|brand name)\b/gi, 'unbranded'],
];

/** Dọn rác do thay từ: mạo từ lặp, "mascot mascot", khoảng trắng thừa. */
const CLEANUP_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(a|an|the)\s+(a|an|the)\b/gi, '$1'],
  [/\bfriendly cartoon mascots?\s+friendly cartoon mascots?\b/gi, 'friendly cartoon mascots'],
  [/\banimal mascot\s+animal mascot\b/gi, 'animal mascots'],
  [/\s+([,.;:])/g, '$1'],
  [/([,.;:])\1+/g, '$1'],
];

function applyReplacements(text: string, pairs: Array<[RegExp, string]>): string {
  let out = text;
  for (const [re, to] of pairs) out = out.replace(re, to);
  return out;
}

/**
 * Viết lại prompt an toàn hơn sau khi bị RAI chặn.
 *  level 1 — xóa mốc tuổi, đổi từ chỉ trẻ em → mascot, bỏ tên thương hiệu /
 *            nhân vật bản quyền, gắn SAFE_SUBJECT_RULE.
 *  level 2 — thêm: ép MỌI chủ thể thành mascot động vật phi-người (phương án cuối).
 */
export function sanitizeUnsafePrompt(prompt: string, level: number): string {
  const src = String(prompt || '').trim();
  if (!src || level <= 0) return src;

  let out = src;
  for (const re of AGE_PATTERNS) out = out.replace(re, ' ');
  out = applyReplacements(out, CHILD_TERM_REPLACEMENTS);
  out = applyReplacements(out, LIKENESS_TERM_REPLACEMENTS);

  if (level >= 2) {
    out = applyReplacements(out, [
      [/\b(men|women|people|humans|persons|characters)\b/gi, 'animal mascots'],
      [/\b(man|woman|person|human|character)\b/gi, 'animal mascot'],
    ]);
    out = `${out} All subjects are non-human friendly animal mascots in a simple cartoon world.`;
  }

  out = applyReplacements(out, CLEANUP_REPLACEMENTS);
  if (!out.toUpperCase().includes('SAFETY:')) out = `${out} ${SAFE_SUBJECT_RULE}`;
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Ước tính credit Snapgen
// ---------------------------------------------------------------------------

/**
 * Bảng giá credit MỖI LƯỢT GỌI API, chép từ https://snapgen.ai/pricing (11/08/2026).
 * Trang chỉ công bố một mức cho mỗi họ model, không tách theo biến thể/độ dài/độ phân giải
 * → đây là ƯỚC TÍNH, không phải hoá đơn. Model nào Snapgen chưa công bố giá thì trả null
 * để UI hiện "—" thay vì đoán bừa.
 */
export const SNAPGEN_CREDITS_BY_FAMILY: Record<string, number> = {
  veo: 7,
  grok: 6,
  seedance: 16,
  kling: 21,
  'snapgen-image': 3,
  'gpt-image': 9,
  'grok-image': 1,
};

/** Model có giá riêng khác mức chung của họ (vd. Omni Flash nằm trong họ Veo). */
export const SNAPGEN_CREDITS_BY_MODEL: Record<string, number> = {
  'omni-flash': 5,
  'nano-banana-2': 3,
  'nano-banana-2-lite': 3,
  'nano-banana-pro': 3,
  'gpt-image-2': 9,
  'grok-image': 1,
};

/** $10 = 2.000 credit theo ưu đãi 100% bonus đang chạy trên trang pricing. */
export const SNAPGEN_USD_PER_CREDIT = 10 / 2000;

/** Giá credit cho 1 lượt gọi API; null = Snapgen chưa công bố (sora, meta…). */
export function creditsPerApiCall(modelId?: string | null, family?: string | null): number | null {
  const byModel = SNAPGEN_CREDITS_BY_MODEL[String(modelId || '').trim()];
  if (byModel != null) return byModel;
  const byFamily = SNAPGEN_CREDITS_BY_FAMILY[String(family || '').trim()];
  return byFamily ?? null;
}

export interface CreditEstimate {
  /** Số lượt gọi API (video dài bị chia nhiều shot). */
  calls: number;
  /** null khi model chưa có giá công bố. */
  credits: number | null;
  perCall: number | null;
  usd: number | null;
}

/**
 * Ước tính credit cho một đợt gen.
 * `durations` = duration_hint của đúng những scene sắp gen (đã lọc).
 */
export function estimateGenerationCredits(options: {
  mediaKind: MediaKind;
  modelId: string;
  family: string;
  durations: number[];
}): CreditEstimate {
  const perCall = creditsPerApiCall(options.modelId, options.family);
  const calls =
    options.mediaKind === 'image'
      ? options.durations.length
      : options.durations.reduce(
          (sum, dur) =>
            sum + planSceneChunks(options.modelId, options.family, Math.max(1, dur)).chunks.length,
          0
        );
  const credits = perCall == null ? null : perCall * calls;
  return {
    calls,
    credits,
    perCall,
    usd: credits == null ? null : credits * SNAPGEN_USD_PER_CREDIT,
  };
}

export function formatCreditEstimate(estimate: CreditEstimate): string {
  if (estimate.credits == null) {
    return `${estimate.calls} lượt gọi API · Snapgen chưa công bố giá credit cho model này`;
  }
  const usd = estimate.usd == null ? '' : ` ≈ $${estimate.usd.toFixed(2)}`;
  return `~${estimate.credits.toLocaleString('vi-VN')} credit${usd} · ${estimate.calls} lượt gọi × ${estimate.perCall} credit`;
}

/** Fallback when a model has no declared durations (not a hard scene length). */
export const DEFAULT_DURATION_PER_SCENE = 8;

/**
 * Soft beat guidance — AI chia scene theo ý, không hardcode 8s/15s cố định.
 * Dùng để gợi ý UI + post-process split/merge.
 */
export const MIN_SCENE_BEAT_SEC = 3;
export const MAX_SCENE_BEAT_SEC = 12;
export const IDEAL_SCENE_BEAT_SEC = 6;
/** @deprecated alias — prefer IDEAL_SCENE_BEAT_SEC */
export const TYPICAL_NARRATIVE_BEAT_SEC = IDEAL_SCENE_BEAT_SEC;

/** Cách chia scene → số ảnh/video (cost control). */
export type SceneDensityId = 'dense' | 'normal' | 'economy' | 'custom';

export const SCENE_DENSITY_OPTIONS: Array<{
  id: SceneDensityId;
  label: string;
  hint: string;
  /** null = user nhập số lượng. */
  beatSec: number | null;
}> = [
  { id: 'dense', label: 'Dày', hint: '~6s / scene', beatSec: 6 },
  { id: 'normal', label: 'Vừa', hint: '~15s / scene', beatSec: 15 },
  { id: 'economy', label: 'Tiết kiệm', hint: '~30s / scene', beatSec: 30 },
  { id: 'custom', label: 'Tùy chỉnh', hint: 'Chọn số ảnh/video', beatSec: null },
];

export const DEFAULT_SCENE_DENSITY: SceneDensityId = 'economy';

export function resolveSceneDensity(raw?: string | null): SceneDensityId {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'dense' || value === 'normal' || value === 'economy' || value === 'custom') {
    return value;
  }
  return DEFAULT_SCENE_DENSITY;
}

/** Giới hạn số media hợp lệ theo thời lượng (mỗi scene ≤ MAX_SCENE_DURATION_SEC). */
export function clampTargetSceneCount(targetDurationSec: number, count: number): number {
  const target = Math.max(MIN_SCENE_BEAT_SEC * 3, Math.round(targetDurationSec));
  const minCount = Math.max(3, Math.ceil(target / MAX_SCENE_DURATION_SEC));
  const maxCount = Math.max(minCount, Math.floor(target / MIN_SCENE_BEAT_SEC));
  const n = Math.round(Number(count));
  if (!Number.isFinite(n)) return Math.max(minCount, Math.round(target / IDEAL_SCENE_BEAT_SEC));
  return Math.min(maxCount, Math.max(minCount, n));
}
/** Absolute ceiling for one scene (extend/multi-cut covers model shot limits). */
export const MAX_SCENE_DURATION_SEC = 180;
export const WORDS_PER_SECOND = 2.5;
/** Nhịp đọc tiếng Nhật/Trung/Hàn ≈ ký tự/giây (không dựa vào khoảng trắng). */
export const CJK_CHARS_PER_SECOND = 5;
/** Narration phải đạt tối thiểu tỉ lệ này so với target trước TTS. */
export const MIN_NARRATION_COVERAGE = 0.85;
/**
 * Per-scene: nới hơn tổng coverage.
 * `duration_hint` thường đã scale theo target (dài hơn lời) → so 85% sẽ false-positive hàng loạt.
 */
export const MIN_SCENE_NARRATION_FILL = 0.6;
/** Bỏ qua lệch nhỏ (giây) — làm tròn / scale hint. */
export const MIN_SCENE_NARRATION_GAP_SEC = 2;
/** Sau TTS: nếu |audio − target| / target > ngưỡng này → AI rewrite + TTS lại. */
export const AUDIO_DURATION_TOLERANCE = 0.03;
/** Số lần TTS tối đa trong vòng fit duration. */
export const MAX_TTS_FIT_ATTEMPTS = 4;

export interface SceneDurationPlan {
  targetDurationSec: number;
  /** Số media mục tiêu (ảnh/video) — dùng để kiểm soát chi phí. */
  sceneCountHint: number;
  sceneCountMin: number;
  sceneCountMax: number;
  typicalBeatSec: number;
  /** Trần khi tách narration local (có thể > MAX_SCENE_BEAT_SEC khi tiết kiệm). */
  maxBeatSec: number;
  /** Soft average nếu chia đều — chỉ để hiển thị. */
  secondsPerScene: number;
  /** Total words needed ≈ target * WORDS_PER_SECOND. */
  targetWordCount: number;
}

export type PlanScenesOptions = {
  /** Số ảnh/video mong muốn (ưu tiên hơn beatSec). */
  targetSceneCount?: number;
  /** Độ dài beat trung bình khi không chỉ định count. */
  typicalBeatSec?: number;
  mediaKind?: MediaKind;
};

/**
 * Ước lượng số scene từ thời lượng (+ tùy chọn mật độ / số media).
 * Dùng cho UI cost hint và chia narration khi gen script.
 */
export function planScenesFromDuration(
  targetDurationSec: number,
  optionsOrLegacy?: number | PlanScenesOptions
): SceneDurationPlan & { sceneCount: number; durationPerScene: number } {
  const target = Math.max(MIN_SCENE_BEAT_SEC * 3, Math.round(targetDurationSec));
  const options: PlanScenesOptions =
    typeof optionsOrLegacy === 'number'
      ? { typicalBeatSec: optionsOrLegacy > 0 ? optionsOrLegacy : IDEAL_SCENE_BEAT_SEC }
      : optionsOrLegacy || {};

  const sceneCountMin = Math.max(3, Math.ceil(target / MAX_SCENE_DURATION_SEC));
  const sceneCountMax = Math.max(sceneCountMin, Math.floor(target / MIN_SCENE_BEAT_SEC));

  let sceneCountHint: number;
  let typicalBeatSec: number;

  if (options.targetSceneCount != null && Number(options.targetSceneCount) > 0) {
    sceneCountHint = clampTargetSceneCount(target, options.targetSceneCount);
    typicalBeatSec = Math.round((target / sceneCountHint) * 10) / 10;
  } else {
    const beat = Math.max(
      MIN_SCENE_BEAT_SEC,
      Number(options.typicalBeatSec) > 0 ? Number(options.typicalBeatSec) : IDEAL_SCENE_BEAT_SEC
    );
    sceneCountHint = clampTargetSceneCount(target, Math.round(target / beat));
    typicalBeatSec = Math.round((target / sceneCountHint) * 10) / 10;
  }

  const maxBeatSec = Math.min(
    MAX_SCENE_DURATION_SEC,
    Math.max(MAX_SCENE_BEAT_SEC, Math.round(typicalBeatSec * 1.35))
  );
  const secondsPerScene = typicalBeatSec;

  return {
    targetDurationSec: target,
    sceneCountHint,
    sceneCountMin,
    sceneCountMax,
    typicalBeatSec,
    maxBeatSec,
    secondsPerScene,
    targetWordCount: Math.round(target * WORDS_PER_SECOND),
    sceneCount: sceneCountHint,
    durationPerScene: secondsPerScene,
  };
}

/**
 * Gộp scene kề nhau để không vượt quá số media mục tiêu (tiết kiệm API ảnh/video).
 */
export function coalesceScenesToTargetCount<
  T extends {
    id?: string;
    section?: string;
    chapter?: string;
    narration_segment?: string;
    visual_prompt?: string;
    duration_hint?: number;
  },
>(scenes: T[], targetCount: number): T[] {
  const target = Math.max(3, Math.round(targetCount));
  if (scenes.length <= target) return scenes;

  const out = scenes.map((scene) => ({ ...scene }));
  while (out.length > target) {
    let bestI = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      const sameChapter =
        (a.chapter || '').trim().toLowerCase() === (b.chapter || '').trim().toLowerCase();
      const sameSection = (a.section || '') === (b.section || '');
      const spoken =
        estimateSpokenSeconds(a.narration_segment || '', 0) +
        estimateSpokenSeconds(b.narration_segment || '', 0);
      const score = spoken + (sameChapter ? 0 : 800) + (sameSection ? 0 : 200);
      if (score < bestScore) {
        bestScore = score;
        bestI = i;
      }
    }
    if (bestI < 0) break;

    const a = out[bestI];
    const b = out[bestI + 1];
    a.narration_segment = `${(a.narration_segment || '').trim()} ${(b.narration_segment || '').trim()}`.trim();
    const prevVisual = (a.visual_prompt || '').trim();
    const nextVisual = (b.visual_prompt || '').trim();
    if (nextVisual && nextVisual !== prevVisual) {
      a.visual_prompt = prevVisual ? `${prevVisual}. Also: ${nextVisual}` : nextVisual;
    }
    const da = Number(a.duration_hint) || 0;
    const db = Number(b.duration_hint) || 0;
    if (da > 0 || db > 0) {
      a.duration_hint = Math.min(MAX_SCENE_DURATION_SEC, Math.round((da + db) * 10) / 10);
    }
    out.splice(bestI + 1, 1);
  }
  return out;
}

const CJK_CHAR_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export function isCjkLanguage(language?: string | null): boolean {
  const value = String(language || '').toLowerCase();
  if (!value) return false;
  return /japan|日本語|nihongo|chinese|中文|mandarin|cantonese|korean|한국어|hangul|tiếng nhật|tiếng trung|tiếng hàn|nhật bản|trung quốc|hàn quốc|\bja\b|\bzh\b|\bko\b/.test(
    value
  );
}

export function countCjkChars(text: string): number {
  return (text.match(CJK_CHAR_RE) || []).length;
}

export function countSpokenWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Tiếng Nhật/Trung/Hàn thường không cách từ — đếm ký tự CJK.
  const cjk = countCjkChars(trimmed);
  const latin = trimmed
    .replace(CJK_CHAR_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (cjk >= 8 && cjk >= latin * 2) return cjk;
  if (cjk > 0 && latin === 0) return cjk;
  // Hỗn hợp: quy đổi CJK → “từ tương đương” để so sánh ngân sách từ Latin.
  if (cjk > 0) {
    return latin + Math.round(cjk * (WORDS_PER_SECOND / CJK_CHARS_PER_SECOND));
  }
  return latin;
}

/** Natural speech pacing — Latin ≈ 2.5 từ/s, CJK ≈ 5 ký tự/s. */
export function estimateSpokenSeconds(text: string, fallback = 6): number {
  const trimmed = text.trim();
  if (!trimmed) return fallback;

  const cjk = countCjkChars(trimmed);
  const latin = trimmed
    .replace(CJK_CHAR_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  let seconds = 0;
  if (cjk) seconds += cjk / CJK_CHARS_PER_SECOND;
  if (latin) seconds += latin / WORDS_PER_SECOND;
  if (!seconds) return fallback;
  return Math.max(2, seconds);
}

export function wordsForDurationSec(seconds: number): number {
  return Math.max(4, Math.round(Math.max(0, seconds) * WORDS_PER_SECOND));
}

/** Ngân sách lời thoại theo ngôn ngữ (từ hoặc ký tự CJK). */
export function spokenBudgetForDurationSec(
  seconds: number,
  language?: string | null
): { amount: number; unitLabel: string; perSec: number } {
  if (isCjkLanguage(language)) {
    const amount = Math.max(8, Math.round(Math.max(0, seconds) * CJK_CHARS_PER_SECOND));
    return { amount, unitLabel: 'ký tự', perSec: CJK_CHARS_PER_SECOND };
  }
  return {
    amount: wordsForDurationSec(seconds),
    unitLabel: 'từ',
    perSec: WORDS_PER_SECOND,
  };
}

export function countSpokenBudgetUnits(text: string, language?: string | null): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (isCjkLanguage(language) || countCjkChars(trimmed) >= 8) {
    const cjk = countCjkChars(trimmed);
    if (cjk > 0) return cjk;
  }
  return countSpokenWords(trimmed);
}

export function estimateScriptSpokenSeconds(
  scenes: Array<{ narration_segment?: string }>
): number {
  return scenes.reduce(
    (sum, scene) => sum + estimateSpokenSeconds(scene.narration_segment || '', 0),
    0
  );
}

export function narrationCoverageRatio(
  scenes: Array<{ narration_segment?: string }>,
  targetDurationSec: number
): number {
  const target = Math.max(1, targetDurationSec);
  return estimateScriptSpokenSeconds(scenes) / target;
}

/** Chặn TTS/render nếu narration còn thiếu so với mục tiêu. */
export function assertNarrationCoversTarget(
  scenes: Array<{ narration_segment?: string }>,
  targetDurationSec: number,
  minRatio = MIN_NARRATION_COVERAGE
): void {
  const spoken = estimateScriptSpokenSeconds(scenes);
  const target = Math.max(1, Math.round(targetDurationSec));
  if (spoken < target * minRatio) {
    throw new Error(
      `Narration quá ngắn: ~${formatDurationLabel(spoken)} so với mục tiêu ${formatDurationLabel(target)}. ` +
        `AI chưa viết đủ lời thoại — hãy Generate script lại (hoặc rút ngắn thời lượng video).`
    );
  }
}

/**
 * Mỗi scene: lời đọc thiếu nặng so với duration_hint.
 * Không dùng cùng ngưỡng 85% với tổng — hint hay bị scale theo target.
 */
export function findScenesWithShortNarration<
  T extends { id?: string; narration_segment?: string; duration_hint?: number },
>(
  scenes: T[],
  minRatio = MIN_SCENE_NARRATION_FILL
): Array<{ index: number; scene: T; spoken: number; planned: number }> {
  const out: Array<{ index: number; scene: T; spoken: number; planned: number }> = [];
  scenes.forEach((scene, index) => {
    const planned = Math.max(2, Number(scene.duration_hint) || IDEAL_SCENE_BEAT_SEC);
    const spoken = estimateSpokenSeconds(scene.narration_segment || '', 0);
    const gap = planned - spoken;
    if (spoken < planned * minRatio && gap >= MIN_SCENE_NARRATION_GAP_SEC) {
      out.push({ index, scene, spoken, planned });
    }
  });
  return out;
}

/**
 * Soft-check only — không throw.
 * Trước đây chặn job:start vì duration_hint bị scale dài hơn lời; timing thật lấy từ TTS.
 */
export function assertScenesNarrationFillDuration(
  scenes: Array<{ id?: string; narration_segment?: string; duration_hint?: number }>,
  minRatio = MIN_SCENE_NARRATION_FILL
): void {
  void findScenesWithShortNarration(scenes, minRatio);
}

export interface SceneDurationInput {
  narration_segment?: string;
  duration_hint?: number;
}

/**
 * Gán duration_hint theo độ dài narration (beat nội dung), rồi scale tổng = target.
 * Không ép mọi scene cùng một số giây cố định.
 */
export function normalizeSceneDurations<T extends SceneDurationInput>(
  scenes: T[],
  targetDurationSec: number
): Array<T & { duration_hint: number }> {
  if (!scenes.length) return [];

  const target = Math.max(scenes.length * MIN_SCENE_BEAT_SEC, Math.round(targetDurationSec));
  const weights = scenes.map((scene) => {
    const fromWords = estimateSpokenSeconds(scene.narration_segment || '', 0);
    const fromHint = Number(scene.duration_hint);
    const hint = Number.isFinite(fromHint) && fromHint > 0 ? fromHint : 0;
    // Ưu tiên độ dài lời nói (nội dung); hint AI chỉ phụ.
    if (fromWords > 0 && hint > 0) return Math.max(MIN_SCENE_BEAT_SEC, fromWords * 0.75 + hint * 0.25);
    if (fromWords > 0) return Math.max(MIN_SCENE_BEAT_SEC, fromWords);
    if (hint > 0) return Math.max(MIN_SCENE_BEAT_SEC, hint);
    return IDEAL_SCENE_BEAT_SEC;
  });

  const weightSum = weights.reduce((sum, value) => sum + value, 0) || scenes.length;
  const assigned = scenes.map((scene, index) => {
    const raw = (weights[index] / weightSum) * target;
    const duration = Math.min(
      MAX_SCENE_DURATION_SEC,
      Math.max(MIN_SCENE_BEAT_SEC, Math.round(raw * 10) / 10)
    );
    return { ...scene, duration_hint: duration };
  });

  const sum = assigned.reduce((total, scene) => total + scene.duration_hint, 0);
  const drift = Math.round((target - sum) * 10) / 10;
  const last = assigned[assigned.length - 1];
  last.duration_hint = Math.min(
    MAX_SCENE_DURATION_SEC,
    Math.max(MIN_SCENE_BEAT_SEC, Math.round((last.duration_hint + drift) * 10) / 10)
  );

  return assigned;
}

/**
 * Gộp scene narration quá ngắn (< MIN) vào scene trước nếu cùng chapter/section.
 */
export function mergeUndersizedScenes<
  T extends {
    id?: string;
    section?: string;
    chapter?: string;
    narration_segment?: string;
    visual_prompt?: string;
    duration_hint?: number;
  },
>(scenes: T[]): T[] {
  if (scenes.length < 2) return scenes;
  const out: T[] = [];
  for (const scene of scenes) {
    const spoken = estimateSpokenSeconds(scene.narration_segment || '', 0);
    const prev = out[out.length - 1];
    const sameBucket =
      prev &&
      (prev.section || '') === (scene.section || '') &&
      (prev.chapter || '').trim().toLowerCase() === (scene.chapter || '').trim().toLowerCase();
    if (prev && sameBucket && spoken > 0 && spoken < MIN_SCENE_BEAT_SEC) {
      prev.narration_segment = `${(prev.narration_segment || '').trim()} ${(scene.narration_segment || '').trim()}`.trim();
      const prevVisual = (prev.visual_prompt || '').trim();
      const nextVisual = (scene.visual_prompt || '').trim();
      if (nextVisual && nextVisual !== prevVisual) {
        prev.visual_prompt = prevVisual
          ? `${prevVisual}. Also: ${nextVisual}`
          : nextVisual;
      }
      continue;
    }
    out.push({ ...scene });
  }
  // Scene cuối quá ngắn → gộp vào trước nếu cùng bucket.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    const spoken = estimateSpokenSeconds(last.narration_segment || '', 0);
    const sameBucket =
      (prev.section || '') === (last.section || '') &&
      (prev.chapter || '').trim().toLowerCase() === (last.chapter || '').trim().toLowerCase();
    if (sameBucket && spoken > 0 && spoken < MIN_SCENE_BEAT_SEC) {
      prev.narration_segment = `${(prev.narration_segment || '').trim()} ${(last.narration_segment || '').trim()}`.trim();
      const prevVisual = (prev.visual_prompt || '').trim();
      const nextVisual = (last.visual_prompt || '').trim();
      if (nextVisual && nextVisual !== prevVisual) {
        prev.visual_prompt = prevVisual
          ? `${prevVisual}. Also: ${nextVisual}`
          : nextVisual;
      }
      out.pop();
    }
  }
  return out;
}

export function formatDurationLabel(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  if (sec < 60) return `${sec}s`;
  const minutes = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${minutes} phút ${rem}s` : `${minutes} phút`;
}
