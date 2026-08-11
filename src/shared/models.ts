import { resolveAspectRatioForModel } from './output-format';
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
/**
 * Vẻ ngoài kênh thiếu nhi YouTube: 3D bóng bẩy kiểu đồ chơi (Cocomelon / Kids TV).
 * Nhân vật là xe cộ - đồ vật - con vật có MẮT TO và miệng cười — thứ làm nên
 * thể loại này, và cũng là thứ tránh được lệnh chặn của Google vì không có trẻ em.
 */
export const KIDS_3D_TOY_STYLE =
  'bright 3D cartoon animation for young children, glossy toy-like characters with big shiny ' +
  'cartoon eyes and happy smiles, chunky rounded shapes, bold saturated primary colors, ' +
  'sunny blue sky with fluffy white clouds, soft even lighting, clean simple background';

/** Bản 2D phẳng — giữ lại để đổi nhanh nếu muốn kiểu vẽ tay. */
export const KIDS_FLAT_2D_STYLE =
  'very simple flat 2D kids cartoon, thick clean outlines, bright cheerful colors, ' +
  'soft rounded shapes, big friendly eyes, minimal detail, plain empty background';

export const DEFAULT_STYLE_PROMPT = KIDS_3D_TOY_STYLE;

/**
 * Style mặc định cho dự án hoạt hình nhạc — dùng chung vẻ 3D đồ chơi.
 * Bản đầu là "cinematic anime, painterly, film grain": tông người lớn, sai hẳn thể loại.
 */
export const MUSIC_ANIMATION_STYLE_PROMPT = KIDS_3D_TOY_STYLE;

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

/** Sora gọi độ phân giải là small/large — hiện nhãn px để chọn được 1080p. */
const SORA_RESOLUTION_LABELS: Record<string, string> = {
  small: '720p (small)',
  large: '1080p (large)',
};

/**
 * Kling không nhận `resolution` (openapi.json: video-gen/kling chỉ có
 * prompt/model/mode/aspect_ratio/duration/ref_*) — mode quyết định độ phân giải.
 * Thứ tự khóa quan trọng: `modeForResolution` lấy mode ĐẦU TIÊN đạt yêu cầu.
 */
const KLING_MODE_RESOLUTIONS: Record<string, string> = {
  standard: '720p',
  relax: '720p',
  professional: '1080p',
  professional_audio: '1080p',
};

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
    resolutionLabels: SORA_RESOLUTION_LABELS,
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
    resolutionLabels: SORA_RESOLUTION_LABELS,
    aspectRatios: ['landscape', 'portrait'],
    defaultDuration: 25,
    defaultResolution: 'small',
    defaultAspectRatio: 'landscape',
  },
  {
    // Biến thể Sora duy nhất cho 1080p (resolution=large).
    id: 'sora-2-pro-hd',
    label: 'Sora 2 Pro HD (1080p)',
    family: 'sora',
    kind: 'video',
    durations: [15],
    resolutions: ['large'],
    resolutionLabels: SORA_RESOLUTION_LABELS,
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
    // openapi.json: video-gen/seedance CÓ param `resolution` (default 720p).
    resolutions: ['480p', '720p', '1080p'],
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
    resolutions: ['480p', '720p', '1080p'],
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
    resolutionFromMode: KLING_MODE_RESOLUTIONS,
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
    resolutionFromMode: KLING_MODE_RESOLUTIONS,
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
    resolutionFromMode: KLING_MODE_RESOLUTIONS,
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
    resolutionFromMode: KLING_MODE_RESOLUTIONS,
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultDuration: 5,
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    extraFields: { mode: ['standard', 'professional'] },
  },
  {
    // openapi.json: video-gen/meta dùng `orientation`, không có aspect_ratio/resolution.
    id: 'meta-ai-video',
    label: 'Meta AI Video',
    family: 'meta',
    kind: 'video',
    durations: [5, 10],
    resolutions: ['720p'],
    aspectRatios: ['landscape', 'portrait', 'square'],
    defaultDuration: 5,
    defaultResolution: '720p',
    defaultAspectRatio: 'landscape',
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

/** Độ phân giải thực tế của một mode, với model không có param `resolution` (Kling). */
export function resolutionForMode(modelId: string, mode?: string | null): string | null {
  const model = getModelById(modelId);
  if (!model?.resolutionFromMode) return null;
  return model.resolutionFromMode[String(mode || '').trim()] ?? model.defaultResolution;
}

/**
 * Mode đạt được `resolution` mong muốn, cho model không có param `resolution`.
 * CHỈ nâng cấp (720p→1080p), không bao giờ hạ: project cũ lưu resolution=1080p +
 * mode=standard sẽ được đẩy lên professional thay vì âm thầm xuất 720p.
 */
export function modeForResolution(
  modelId: string,
  resolution: string,
  mode?: string | null
): string | undefined {
  const model = getModelById(modelId);
  const map = model?.resolutionFromMode;
  const current = String(mode || '').trim() || undefined;
  if (!map) return current;
  const want = String(resolution || '').trim();
  const currentRes = current ? map[current] : undefined;
  if (!want || currentRes === want || currentRes === '1080p') return current;
  const upgraded = Object.keys(map).find((m) => map[m] === want);
  return upgraded ?? current;
}

/** Các tên khác nhau của cùng một độ phân giải giữa các họ model. */
const RESOLUTION_SYNONYMS: string[][] = [
  ['480p'],
  ['720p', 'small'],
  ['1080p', 'large'],
];

/**
 * Hai giá trị resolution có chỉ cùng một độ phân giải không (720p ↔ small…).
 * Thiếu một bên → true: dữ liệu không đủ thì đừng loại oan (loại oan = gen lại, tốn credit).
 */
export function isSameResolution(a?: string | null, b?: string | null): boolean {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return true;
  return x === y || resolutionCandidates(x).includes(y);
}

function resolutionCandidates(value: string): string[] {
  const v = String(value || '').trim();
  const group = RESOLUTION_SYNONYMS.find((g) => g.includes(v));
  return group ? [v, ...group.filter((x) => x !== v)] : [v];
}

export interface NormalizedVideoRequest {
  model: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  mode?: string;
}

/**
 * Ép tham số về đúng bảng model TRƯỚC khi gọi API.
 * Cần thiết vì project lưu aspect/resolution độc lập với model: đổi family
 * (Veo `16:9` → Grok chỉ nhận `landscape`) hoặc đổi model (`1080p` → Sora `large`)
 * mà không normalize thì API trả INVALID_INPUT, mất một lượt gọi + lock credit.
 */
export function normalizeVideoRequest(input: {
  modelId: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  mode?: string;
}): NormalizedVideoRequest {
  const modelId = resolveModelId(input.modelId);
  const model = getModelById(modelId);
  if (!model) {
    return {
      model: modelId,
      duration: Math.max(1, Math.round(Number(input.duration) || 1)),
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      mode: input.mode,
    };
  }

  const resolution =
    resolutionCandidates(input.resolution).find((r) => model.resolutions.includes(r)) ??
    model.defaultResolution;

  const allowedModes = model.extraFields?.mode;
  let mode = input.mode?.trim() || undefined;
  if (allowedModes?.length && (!mode || !allowedModes.includes(mode))) {
    mode = allowedModes[0];
  }
  mode = modeForResolution(modelId, resolution, mode);

  return {
    model: modelId,
    duration: clampDuration(modelId, Math.max(1, Number(input.duration) || model.defaultDuration)),
    aspectRatio: resolveAspectRatioForModel(input.aspectRatio, model.aspectRatios),
    resolution,
    mode,
  };
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
/**
 * Chỉ thị/meta lọt vào visual_prompt qua các bước viết kịch bản cũ.
 * Veo nhận nguyên văn những câu này rồi cố VẼ chúng (nhất là narration trong ngoặc
 * kép — chữ tiếng Việt hay bị render lên màn hình) hoặc rối vì quá nhiều mệnh lệnh.
 * Cắt sạch ở wrapper để cả project CŨ (visual_prompt đã lưu trong JSON) cũng nhẹ theo.
 */
const PROMPT_DIRECTIVE_PATTERNS: RegExp[] = [
  /\bOPENING (?:beat )?of a continuous[^.]*\./gi,
  /\bCONTINUATION beat[^.]*\./gi,
  /\bCONTINUATION from previous narration[^]*?no hard cut\.?/gi,
  /\b(?:End the shot mid-action|End on a gentle satisfied pose|Leave motion ready for next beat)[^.]*\./gi,
  /\bGentle closing energy for sequence end\.?/gi,
  /\bRecurring cast:[^.]*\./gi,
  /\bStyle bible:[^.]*\./gi,
  /\bVISUAL RULE \(mandatory\):[^]*?on screen\.?/gi,
  /\bHARD RULES:[^]*?edge to edge\.?/gi,
  /\bSTRICT:[^.]*\./gi,
  /\bVisual locale:[^.]*\./gi,
  /\bChapter "[^"]*", beat \d+\/\d+\.\s*/gi,
  // Xóa CẢ câu narration trong ngoặc kép — narration tiếng Việt lọt vào prompt là
  // lý do Veo vẽ chữ lên màn hình.
  /\bStory beat to visualize[^"]*"[^"]*"\.?\s*/gi,
  /\b(?:seamless from previous shot|about) "[^"]*"\.?\s*/gi,
  // Nhãn viết hoa kiểu "SUBJECT:", "CAMERA:" — bỏ nhãn, giữ nội dung.
  /\b(SUBJECT|PROP \/ FOCUS OBJECT|PROP|ENVIRONMENT|ACTION \/ MOTION|ACTION|CAMERA|LIGHTING & COLOR|LIGHTING|COMPOSITION)\s*:\s*/g,
  // Nhãn của storyboard cinematic cũ ("Foreground: …", "Palette: …") — bản kids
  // không sinh ra nữa nhưng project cũ đã lưu đầy trong visual_prompt.
  /\b(Foreground|Midground|Background|Palette|Colour palette|Color palette|Motion quality|Framing|Energy)\s*:\s*/g,
];

/** Độ dài tối đa phần mô tả hình (ký tự) trước khi ghép style. */
const MAX_VISUAL_PROMPT_CHARS = 260;

/**
 * Rút prompt về một câu tả hình ngắn: bỏ chỉ thị, bỏ ngoặc kép, cắt theo ranh giới câu.
 * Prompt ngắn và cụ thể cho kết quả ổn định hơn hẳn trên Veo Fast — prompt dài,
 * nhiều mệnh lệnh mâu thuẫn là nguyên nhân chính gây lỗi và gen ra hình lộn xộn.
 */
export function compactVisualPrompt(
  visualPrompt: string,
  maxChars = MAX_VISUAL_PROMPT_CHARS
): string {
  let out = String(visualPrompt || '');
  for (const re of PROMPT_DIRECTIVE_PATTERNS) out = out.replace(re, ' ');

  // Bỏ mệnh lệnh (không phải tả hình) và lời thoại lọt vào. Cắt theo MỆNH ĐỀ
  // (câu + dấu ;) để câu "a fox mascot; big eyes; pose must act out…" vẫn giữ
  // được chủ thể, chỉ rụng đúng mệnh đề mệnh lệnh.
  const isDirective = (s: string) =>
    /\b(must|do not|don'?t|never|avoid|strictly|no readable|no on-screen)\b/i.test(s);
  const isLeakedNarration = (s: string) =>
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s) &&
    s.split(/\s+/).length > 4;

  out = out
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      const kept = sentence
        .split(';')
        .map((clause) => clause.trim())
        .filter((clause) => clause && !isDirective(clause) && !isLeakedNarration(clause));
      if (!kept.length) return '';
      const joined = kept.join('; ');
      return /[.!?]$/.test(joined) ? joined : `${joined}.`;
    })
    .filter(Boolean)
    .join(' ');

  out = out
    .replace(/["“”]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([,.;:])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (out.length <= maxChars) return out;

  // Cắt ở dấu chấm gần nhất trước giới hạn; không có thì cắt ở khoảng trắng.
  const head = out.slice(0, maxChars);
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '));
  if (lastStop > maxChars * 0.5) return head.slice(0, lastStop + 1).trim();
  const lastSpace = head.lastIndexOf(' ');
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trim()}.`;
}

/** Bối cảnh văn hóa dạng ngắn — bỏ mệnh đề "depict people with accurate age…". */
function shortLocaleHint(language?: string | null): string | null {
  const full = resolveVisualLocaleHint(language);
  if (!full) return null;
  const head = full.split(';')[0].trim();
  return /english|western/i.test(head) ? null : head;
}

// ---------------------------------------------------------------------------
// Luật "hoạt hình hoá mọi thứ + cực đơn giản" — dùng chung cho cả hai wrapper
// ---------------------------------------------------------------------------

/**
 * Style prompt chỉ nói "kids cartoon" thì model hiểu là NHÂN VẬT hoạt hình, còn
 * bối cảnh vẫn hay ra ảnh thực: ô tô đúng mẫu xe thật, nhà cửa - cây cối chi tiết
 * như ảnh chụp. Phải liệt kê thẳng những thứ hay bị "thật hoá".
 *
 * Luật này TRUNG TÍNH với kiểu vẽ: chỉ cấm "như ảnh thật / như phim người thật",
 * KHÔNG cấm 3D. Bản trước ghi "no 3D render" nên nó chặn đúng vẻ 3D bóng bẩy kiểu
 * Cocomelon — tức style prompt đòi một thứ mà luật wrapper lại cấm.
 */
export const CARTOON_WORLD_RULE =
  'everything is cartoon — vehicles, houses, trees, food and props all chunky rounded shapes, ' +
  'never photoreal, never live-action';

/**
 * Đơn giản, nhưng cho phép dàn 3–5 nhân vật xếp hàng — đó là bố cục kinh điển của
 * thể loại này (dàn xe cộ / dàn con vật cùng nhìn vào máy). Cấm là cấm ĐÁM ĐÔNG
 * người và cảnh rối: đó mới là thứ làm mặt nhân vật bị méo vì model phải chia độ
 * phân giải cho quá nhiều thứ.
 */
export const SIMPLE_STAGING_RULE =
  'simple staging: 3 to 5 friendly characters at most, never a crowd, few props';

/**
 * Chuyển động: chỉ nhún / lắc / nhảy nhẹ. Bản trước không nói gì nên model tự thêm
 * múa, chạy, xoay người — vừa quá sức Veo Fast (ra tay chân dính nhau) vừa không
 * phải cái người dùng cần.
 */
export const SIMPLE_MOTION_RULE =
  'motion is simple and bouncy — springy bounces, happy wiggles, little hops in place; ' +
  'no dance routine, no running, no fast action';

/**
 * Từ chỉ đông người / render thật / chi tiết rườm rà → mệnh đề đơn giản.
 * Luôn thay bằng cụm SỐ ÍT ("one cartoon friend") để câu không thành
 * "two characters cheers" — sai ngữ pháp thì model dễ hiểu lệch.
 */
const BUSY_SCENE_REPLACEMENTS: Array<[RegExp, string]> = [
  [
    /\b(?:a\s+|the\s+)?(?:huge |large |big |whole )?(?:crowd|crowds|mob|throng)(?:\s+of\s+\w+)?\b/gi,
    'one cartoon friend',
  ],
  // "a row of buses" là bố cục ĐÚNG của thể loại → chỉ hạ xuống 3 nhân vật, không
  // ép về 1. Giữ dạng "a small group of…" để động từ số ít phía sau vẫn đúng ngữ pháp.
  [
    /\b(?:a\s+|the\s+)?(?:group|bunch|team|line|row|circle)\s+of\s+(?:many\s+|several\s+)?(?:people|kids|friends|characters|animals|dancers|singers)\b/gi,
    'a small group of three cartoon friends',
  ],
  [
    /\b(?:many|several|lots of|dozens of|a dozen|hundreds of|numerous)\s+(?:people|kids|friends|characters|animals|dancers|singers)\b/gi,
    'three cartoon friends',
  ],
  [
    /\b(?:a\s+|the\s+)?(cheering audience|audience|spectators|onlookers|passers-?by|bystanders)\b/gi,
    'one cartoon friend',
  ],
  [/\b(busy|bustling|crowded|packed)\s+(street|city|market|square|stage|room)\b/gi, 'quiet cartoon $2'],
  // "with photorealistic chrome reflections", "with cinematic rim lighting" — XÓA CẢ
  // mệnh đề. Chỉ thay từ khóa thì còn lại "a red car with cartoon parked nearby".
  //
  // CHÚ Ý: không đụng tới "3D render / CGI" nữa. Style thiếu nhi YouTube chính là 3D
  // bóng bẩy kiểu đồ chơi; bản trước đổi "3D render" → "flat cartoon" nên nó phá
  // đúng vẻ ngoài người dùng muốn. Chỉ còn chặn "như ảnh chụp / như phim người thật".
  [
    /\s*\b(?:with|and)\s+[^,.;]*\b(?:photo-?realistic|photoreal\w*|hyper-?realistic|realistic|lifelike|live[- ]action|reflections?|film grain|bokeh|lens flare|depth of field|ray[- ]traced|octane)\b[^,.;]*/gi,
    '',
  ],
  // Thuật ngữ nhiếp ảnh đứng lẻ (", film grain", ", bokeh") → xóa hẳn; thay bằng
  // "cartoon" sẽ ra "a cartoon film grain" vô nghĩa.
  [/\s*,?\s*\b(film grain|bokeh|lens flare|shallow depth of field|depth of field|chrome reflections?|realistic reflections?)\b/gi, ''],
  // Từ khóa còn lại đứng độc lập ("photorealistic city street", "realistic bus").
  [
    /\b(photo-?realistic|photoreal|hyper-?realistic|realistic|lifelike|live[- ]action|octane render|ray[- ]traced)\b/gi,
    'cartoon',
  ],
  // "cinematic" không sai kiểu vẽ nhưng kéo theo ánh sáng u tối, tương phản mạnh.
  [/\bcinematic\b/gi, 'bright cheerful'],
  [/\b(intricate|highly detailed|ultra[- ]detailed|finely detailed|elaborate|ornate|detailed)\b/gi, 'simple'],
  // Dọn "cartoon cartoon", "simple simple" do thay liên tiếp.
  [/\b(cartoon)(\s+\1)+\b/gi, '$1'],
  [/\b(simple)(\s+\1)+\b/gi, '$1'],
];

/** Vũ đạo / hành động mạnh → nhún nhảy nhẹ. */
const BUSY_MOTION_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(dance choreography|choreography|dance routine|breakdanc\w*|somersault\w*|backflip\w*|cartwheel\w*)\b/gi,
    'a gentle bounce'],
  [/\b(sprint\w*|running fast|dashes?|leaps? high|jumps? high|spins? rapidly|twirls? fast)\b/gi,
    'bounces gently'],
];

/**
 * Rút cảnh về mức "một hai nhân vật, nhún nhún là đủ".
 * Chạy ở wrapper nên áp cho cả project CŨ (visual_prompt đã lưu trong JSON).
 */
function simplifyBusyScene(text: string): string {
  let out = applyReplacements(String(text || ''), BUSY_SCENE_REPLACEMENTS);
  out = applyReplacements(out, BUSY_MOTION_REPLACEMENTS);
  return applyReplacements(out, CLEANUP_REPLACEMENTS).replace(/\s+/g, ' ').trim();
}

/**
 * Prompt gửi Snapgen: mô tả hình NGẮN + style + luật hoạt hình + "no text".
 * Không gắn narration — lời thoại chỉ dùng cho TTS/subtitle.
 *
 * Cố tình KHÔNG dùng `resolveVisualLanguageLock` nữa: câu đó liệt kê hàng loạt thứ
 * cấm ("signs, labels, screens, books, posters…") nên chính nó gợi model vẽ ra,
 * và mệnh đề "depict people with accurate age" trong locale hint là lý do video
 * thiếu nhi hay bị Google chặn vì nghi mô tả trẻ em.
 */
export function buildSceneImagePrompt(options: {
  visualPrompt: string;
  language?: string | null;
  stylePrompt?: string;
  /** 'video' → gắn thêm luật chuyển động nhún/lắc. */
  mediaKind?: string | null;
}): string {
  const visual = simplifyBusyScene(compactVisualPrompt(options.visualPrompt || ''));
  const parts = [visual.replace(/\.*$/, '')];

  const locale = shortLocaleHint(options.language);
  if (locale && !new RegExp(locale.split(' ')[0], 'i').test(visual)) {
    parts.push(locale);
  }

  const style = (options.stylePrompt || DEFAULT_STYLE_PROMPT).trim().replace(/\.*$/, '');
  if (style && !visual.toLowerCase().includes(style.toLowerCase().slice(0, 30))) {
    parts.push(style);
  }

  parts.push(CARTOON_WORLD_RULE, SIMPLE_STAGING_RULE);
  if (options.mediaKind === 'video') parts.push(SIMPLE_MOTION_RULE);
  parts.push('no text');
  return parts.filter(Boolean).join('. ').replace(/\s+/g, ' ').trim() + '.';
}

// ---------------------------------------------------------------------------
// Prompt wrapper riêng cho hoạt hình nhạc (music-animation)
// ---------------------------------------------------------------------------

/**
 * Cỡ cảnh luân phiên theo scene index.
 * MV mà mọi shot cùng cỡ thì xem rất chán — nhất là khi ảnh đã không zoom/pan nữa.
 * Chỉ áp dụng khi visual_prompt CHƯA tự nói cỡ cảnh.
 *
 * Giữ NGẮN và không dùng từ nghề (shallow depth of field, low-angle hero, OTS):
 * phim thiếu nhi luôn để camera ngang tầm mắt, và mỗi từ nghề thêm vào là một cơ
 * hội để model đổi style giữa các scene.
 */
const MUSIC_SHOT_LADDER = [
  'wide shot, whole simple scene visible',
  'medium shot, character filling most of the frame',
  'close-up on the happy face and big eyes',
  'front-on line-up shot, characters side by side facing the camera',
];

const FRAMING_ALREADY_RE =
  /close-?up|wide shot|wide angle|medium shot|establishing|extreme close|aerial|bird'?s[- ]eye|over[- ]the[- ]shoulder|low[- ]angle|high[- ]angle|macro|full[- ]body|two[- ]shot|profile shot/i;

/**
 * Cấm cứng: chữ/lyric và ghép nhiều khung — 2 lỗi hay gặp nhất.
 * Bản cũ liệt kê 15 thứ cấm ("lyrics, captions, subtitles, song titles, credits,
 * signs, logos, watermarks, timecodes…"); chính danh sách đó gợi model vẽ ra chữ,
 * và nó dài hơn cả phần tả hình nên bị ưu tiên thấp hơn mong đợi.
 */
const MUSIC_HARD_RULES = 'no text anywhere, no split screen or collage';

/**
 * Một khung ĐỨNG YÊN: sau khi bỏ Ken Burns, ảnh phải tự đứng vững như một
 * key frame — mô tả chuyển động camera chỉ làm model vẽ blur / motion streak vô ích.
 */
const MUSIC_STILL_FRAME_RULE = 'one still frame, no camera movement, sharp and clean';

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
  /** 'video' → gắn luật chuyển động nhún/lắc thay vì để model tự nghĩ vũ đạo. */
  mediaKind?: string | null;
}

function musicEnergyLine(section?: string): string | null {
  const value = String(section || '').toLowerCase();
  // Tông thiếu nhi: mở đầu nhẹ nhàng, kết bài ấm áp. Không dùng "cooler light /
  // negative space / fading light" — nghe điện ảnh nhưng làm khung tối và trống trải.
  if (value === 'introduction') return 'calm gentle mood, soft daylight';
  if (value === 'conclusion') return 'warm happy ending mood, cosy light';
  return null;
}

/** Cast lock dài quá thì nó nuốt luôn phần tả hành động của scene. */
const MAX_MUSIC_CAST_LOCK_CHARS = 220;
/** Phần mô tả hình của scene MV — nhiều hơn video học tập một chút, vẫn phải ngắn. */
const MAX_MUSIC_VISUAL_PROMPT_CHARS = 320;

/**
 * Prompt gửi Snapgen cho hoạt hình nhạc thiếu nhi.
 *
 * Khác `buildSceneImagePrompt` ở 3 điểm:
 *  1. Cast lock đứng ĐẦU prompt (model ưu tiên phần đầu) → nhân vật nhất quán.
 *  2. Luân phiên cỡ cảnh khi storyboard không nói rõ → đỡ đơn điệu.
 *  3. Nói rõ "một khung đứng yên" khi ảnh không còn Ken Burns.
 *
 * Bản cũ ghép 6 khối mệnh lệnh viết hoa (CAST LOCK / Framing / Energy / Style /
 * culture rule / HARD RULES / SAFETY) → prompt ~600 ký tự toàn chỉ thị, phần tả
 * hình chỉ còn là một mẩu ở giữa. Giờ mọi thứ là mệnh đề ngắn nối bằng dấu phẩy,
 * đúng cách viết prompt cho ảnh, và tổng độ dài bị chặn cứng.
 */
export function buildMusicSceneImagePrompt(options: MusicScenePromptOptions): string {
  const parts: string[] = [];

  // Cast lock cũng phải đi qua compact + bỏ mốc tuổi: storyboard nhạc thiếu nhi rất
  // hay viết "a 5-year-old duckling", và một chữ "5-year-old" trong prompt là đủ để
  // Google chặn cả scene (mất credit) — không đợi tới lúc retry mới xử.
  const cast = simplifyBusyScene(
    stripAgeMarkers(compactVisualPrompt(options.castLock || '', MAX_MUSIC_CAST_LOCK_CHARS))
  );
  if (cast) parts.push(`Same characters in every shot: ${cast.replace(/\.*$/, '')}.`);

  const visual = simplifyBusyScene(
    stripAgeMarkers(compactVisualPrompt(options.visualPrompt || '', MAX_MUSIC_VISUAL_PROMPT_CHARS))
  );
  if (visual) parts.push(visual.replace(/\.*$/, ''));

  if (options.sceneIndex != null && visual && !FRAMING_ALREADY_RE.test(visual)) {
    parts.push(MUSIC_SHOT_LADDER[options.sceneIndex % MUSIC_SHOT_LADDER.length]);
  }

  const energy = musicEnergyLine(options.section);
  if (energy) parts.push(energy);

  const style = options.stylePrompt?.trim().replace(/\.*$/, '');
  // Chỉ bỏ style khi nó thực sự đã nằm trong visual_prompt — style quá ngắn
  // (vài ký tự) rất dễ "trùng" ngẫu nhiên nên không dùng để loại.
  const styleAlready =
    !!style && style.length >= 12 && visual.toLowerCase().includes(style.toLowerCase());
  if (style && !styleAlready) parts.push(style);

  // Bối cảnh văn hóa: chỉ một mệnh đề ngắn, và bỏ hẳn với English/Western
  // (`shortLocaleHint`) — mascot hoạt hình phẳng thì câu này chỉ là nhiễu.
  const locale = shortLocaleHint(options.language);
  if (locale && !new RegExp(locale.split(' ')[0], 'i').test(visual)) parts.push(locale);

  if (options.stillFrame) parts.push(MUSIC_STILL_FRAME_RULE);
  else if (options.mediaKind === 'video') parts.push(SIMPLE_MOTION_RULE);

  parts.push(CARTOON_WORLD_RULE, SIMPLE_STAGING_RULE, MUSIC_HARD_RULES, KIDS_SAFE_SUBJECT_HINT);

  return (
    parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join(', ')
      .replace(/\s+/g, ' ')
      // Cast lock tự kết bằng dấu chấm → "…backpack., Momo waddles" phải thành
      // "…backpack. Momo waddles".
      .replace(/\.\s*,\s*/g, '. ')
      .replace(/,\s*,/g, ',')
      .trim() + '.'
  );
}

/**
 * Bỏ mốc tuổi khỏi prompt hoạt hình thiếu nhi ("a 5-year-old…", "aged 6").
 * Xóa hẳn thay vì đổi thành "adult" — mascot con vịt thì không cần tuổi nào cả.
 */
function stripAgeMarkers(text: string): string {
  let out = String(text || '');
  for (const re of AGE_PATTERNS) out = out.replace(re, ' ');
  return out
    .replace(/\b(a|an)\s+(?=[,.;])/gi, '')
    .replace(/\s+([,.;:])/g, '$1')
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

/**
 * Bản NGẮN, viết theo hướng khẳng định — dùng cho prompt bình thường của hoạt hình
 * nhạc thiếu nhi. SAFE_SUBJECT_RULE đầy đủ (4 câu cấm) chỉ gắn khi đã bị RAI chặn
 * và phải viết lại prompt: ở lượt đầu nó dài hơn cả phần tả hình.
 */
export const KIDS_SAFE_SUBJECT_HINT =
  'original cartoon vehicles, animals or toys, no children, no real people';

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
 * $10 = 2.000 credit (ưu đãi 100% bonus trên trang pricing) → 1 credit = $0,005.
 * Đối chiếu với ví dụ trong docs: Veo 2 $0,1/video = 20 credit, Kling 720p 8s
 * $0,05/s = 80 credit — đúng khớp `estimated_credit` trong response mẫu.
 */
export const SNAPGEN_USD_PER_CREDIT = 10 / 2000;

/** Giá tính theo lượt gọi (video/ảnh) hay theo từng giây video. */
export type SnapgenPriceUnit = 'call' | 'second';

/**
 * Bảng giá Snapgen, đọc từ https://snapgen.ai/pricing ngày 11/08/2026 —
 * bung từng nhóm model ra để lấy giá theo BIẾN THỂ (độ phân giải / mode / độ dài).
 *
 * CẢNH BÁO LỊCH SỬ: bảng cũ dùng các số 7/6/16/21/3/9/1 tưởng là "credit mỗi lượt",
 * nhưng đó là SỐ DÒNG trong mỗi nhóm gấp lại của trang pricing (Nano Banana có 3
 * biến thể, GPT Image 2 có 9…), không phải giá. Vì vậy Seedance/Kling từng bị
 * ước tính thấp hơn thực tế hơn 10 lần.
 *
 * `usd` = đơn giá USD; `unit` = 'call' (mỗi video/ảnh) hoặc 'second' (mỗi giây video).
 * Tra cứu theo resolution, rồi mode, rồi duration — thiếu khóa nào thì lùi về `default`.
 */
interface SnapgenPrice {
  unit: SnapgenPriceUnit;
  /** Giá chung khi không phân theo resolution. */
  usd?: number;
  /** Theo resolution (720p/1080p/small/large/1K…). */
  byResolution?: Record<string, number>;
  /** Theo mode (fast/pro/standard/professional/low/high…), lồng trong resolution nếu cần. */
  byMode?: Record<string, number | Record<string, number>>;
  /** Theo độ dài video (giây) — dùng cho model tính giá theo từng mốc thời lượng. */
  byDuration?: Record<number, number>;
}

const SNAPGEN_PRICES: Record<string, SnapgenPrice> = {
  // --- Veo: giá mỗi video, không phụ thuộc 720p/1080p ---
  'veo-3.1-fast': { unit: 'call', usd: 0.02 },
  'veo-3.1-lite': { unit: 'call', usd: 0.02 },
  'veo-3.1': { unit: 'call', usd: 0.5 },
  'veo-2': { unit: 'call', usd: 0.1 },
  // Omni Flash: mỗi video, theo mốc thời lượng.
  'omni-flash': { unit: 'call', byDuration: { 4: 0.075, 6: 0.1, 8: 0.125, 10: 0.15 } },

  // --- Grok: mỗi video, theo resolution × thời lượng ---
  'grok-3': {
    unit: 'call',
    byDuration: { 6: 0.09, 10: 0.12, 15: 0.15 }, // giá 720p; 480p rẻ hơn $0,03 mỗi mốc
  },

  // --- Seedance: mỗi GIÂY, theo mode × resolution ---
  'seedance-2': {
    unit: 'second',
    byMode: {
      fast: { '480p': 0.06, '720p': 0.095, '1080p': 0.19 },
      pro: { '480p': 0.08, '720p': 0.135, '1080p': 0.27 },
    },
  },
  'seedance-2-omni': {
    unit: 'second',
    byMode: {
      // Trang pricing không tách riêng tier `-2`; xếp chung với fast/pro tương ứng.
      fast: { '480p': 0.095, '720p': 0.095, '1080p': 0.19 },
      'fast-2': { '480p': 0.095, '720p': 0.095, '1080p': 0.19 },
      pro: { '480p': 0.135, '720p': 0.135, '1080p': 0.27 },
      'pro-2': { '480p': 0.135, '720p': 0.135, '1080p': 0.27 },
      'fast-vip': { '480p': 0.135, '720p': 0.135, '1080p': 0.27 },
      'pro-vip': { '480p': 0.175, '720p': 0.175, '1080p': 0.345 },
    },
  },

  // --- Kling: mỗi GIÂY, theo model × mode (mode quyết định 720p/1080p) ---
  'kling-video-3-0': { unit: 'second', byMode: { standard: 0.05, professional: 0.06 } },
  'kling-video-o1': { unit: 'second', byMode: { standard: 0.05, professional: 0.06 } },
  'kling-video-2-5': {
    unit: 'second',
    byMode: { relax: 0.015, standard: 0.03, professional: 0.04 },
  },
  'kling-video-2-6': {
    unit: 'second',
    byMode: { standard: 0.03, professional: 0.05, professional_audio: 0.07 },
  },

  // --- Ảnh: mỗi ảnh ---
  'nano-banana-2': { unit: 'call', usd: 0.015 },
  'nano-banana-2-lite': { unit: 'call', usd: 0.015 },
  'nano-banana-pro': { unit: 'call', usd: 0.015 },
  'grok-image': { unit: 'call', usd: 0.01 },
  'gpt-image-2': {
    unit: 'call',
    byMode: {
      low: { '1k': 0.03, '2k': 0.035, '4k': 0.04 },
      medium: { '1k': 0.05, '2k': 0.095, '4k': 0.145 },
      high: { '1k': 0.16, '2k': 0.315, '4k': 0.47 },
    },
  },

  // Sora và Meta AI Video KHÔNG có trên trang pricing → để trống, UI hiện "chưa công bố".
};

/** Giá 480p của Grok thấp hơn 720p đúng $0,03 ở mọi mốc thời lượng. */
const GROK_480P_DISCOUNT_USD = 0.03;

function lookupUsd(
  price: SnapgenPrice,
  resolution?: string | null,
  mode?: string | null,
  duration?: number | null
): number | null {
  const res = String(resolution || '').trim().toLowerCase();
  const md = String(mode || '').trim();

  if (price.byMode) {
    const entry = price.byMode[md] ?? Object.values(price.byMode)[0];
    if (typeof entry === 'number') return entry;
    if (entry) {
      const keys = Object.keys(entry);
      const hit = keys.find((k) => k.toLowerCase() === res);
      return entry[hit ?? keys[0]];
    }
  }

  if (price.byDuration && duration != null) {
    const marks = Object.keys(price.byDuration)
      .map(Number)
      .sort((a, b) => a - b);
    const mark = marks.find((m) => duration <= m) ?? marks[marks.length - 1];
    const base = price.byDuration[mark];
    return res === '480p' ? Math.max(0, base - GROK_480P_DISCOUNT_USD) : base;
  }

  if (price.byResolution) {
    const keys = Object.keys(price.byResolution);
    const hit = keys.find((k) => k.toLowerCase() === res);
    return price.byResolution[hit ?? keys[0]];
  }

  return price.usd ?? null;
}

/**
 * Credit cho MỘT lượt gọi API với đúng thông số đang chọn.
 * null = Snapgen chưa công bố giá (Sora, Meta) → UI phải hiện "—", không đoán.
 */
export function creditsForOneCall(options: {
  modelId: string;
  resolution?: string | null;
  mode?: string | null;
  /** Thời lượng shot (giây) — bắt buộc với model tính theo giây. */
  duration?: number | null;
}): number | null {
  const modelId = resolveModelId(options.modelId);
  const price = SNAPGEN_PRICES[modelId];
  if (!price) return null;

  // Kling không có param resolution: mode quyết định giá. `normalizeVideoRequest`
  // nâng mode khi người dùng chọn 1080p, nên ước tính phải dùng ĐÚNG mode sẽ gửi đi,
  // nếu không thì báo giá standard mà bị trừ tiền professional.
  const mode = getModelById(modelId)?.resolutionFromMode
    ? modeForResolution(modelId, String(options.resolution || ''), options.mode)
    : options.mode;

  const usd = lookupUsd(price, options.resolution, mode, options.duration);
  if (usd == null) return null;

  const seconds = price.unit === 'second' ? Math.max(1, Number(options.duration) || 1) : 1;
  return Math.round((usd * seconds) / SNAPGEN_USD_PER_CREDIT);
}

export interface CreditEstimate {
  /** Số lượt gọi API (video dài bị chia nhiều shot). */
  calls: number;
  /** null khi model chưa có giá công bố. */
  credits: number | null;
  usd: number | null;
  /** Đơn giá để giải thích cho người dùng ("×4 credit/video" hay "×27 credit/giây"). */
  unit: SnapgenPriceUnit | null;
  unitCredits: number | null;
}

/**
 * Ước tính credit cho một đợt gen, tính từng shot một vì giá phụ thuộc thời lượng.
 * `durations` = duration_hint của đúng những scene sắp gen (đã lọc).
 */
export function estimateGenerationCredits(options: {
  mediaKind: MediaKind;
  modelId: string;
  family: string;
  durations: number[];
  resolution?: string | null;
  mode?: string | null;
}): CreditEstimate {
  const price = SNAPGEN_PRICES[resolveModelId(options.modelId)];
  const unit = price?.unit ?? null;

  if (options.mediaKind === 'image') {
    const calls = options.durations.length;
    const perImage = creditsForOneCall({
      modelId: options.modelId,
      resolution: options.resolution,
      mode: options.mode,
    });
    const credits = perImage == null ? null : perImage * calls;
    return {
      calls,
      credits,
      usd: credits == null ? null : credits * SNAPGEN_USD_PER_CREDIT,
      unit,
      unitCredits: perImage,
    };
  }

  let calls = 0;
  let credits: number | null = 0;
  let unitCredits: number | null = null;

  for (const dur of options.durations) {
    const plan = planSceneChunks(options.modelId, options.family, Math.max(1, dur));
    for (const chunk of plan.chunks) {
      calls += 1;
      const shot = creditsForOneCall({
        modelId: options.modelId,
        resolution: options.resolution,
        mode: options.mode,
        duration: chunk,
      });
      if (shot == null) {
        credits = null;
      } else if (credits != null) {
        credits += shot;
        // Đơn giá hiển thị: theo giây thì quy về 1 giây, theo lượt thì là giá 1 shot.
        unitCredits = unit === 'second' ? Math.round(shot / chunk) : shot;
      }
    }
  }

  return {
    calls,
    credits,
    usd: credits == null ? null : credits * SNAPGEN_USD_PER_CREDIT,
    unit,
    unitCredits,
  };
}

export function formatCreditEstimate(estimate: CreditEstimate): string {
  if (estimate.credits == null) {
    return `${estimate.calls} lượt gọi API · Snapgen chưa công bố giá credit cho model này`;
  }
  const usd = estimate.usd == null ? '' : ` ≈ $${estimate.usd.toFixed(2)}`;
  const perUnit =
    estimate.unitCredits == null
      ? ''
      : estimate.unit === 'second'
        ? ` (~${estimate.unitCredits} credit/giây)`
        : ` × ${estimate.unitCredits} credit`;
  return `~${estimate.credits.toLocaleString('vi-VN')} credit${usd} · ${estimate.calls} lượt gọi${perUnit}`;
}

/** Fallback when a model has no declared durations (not a hard scene length). */
export const DEFAULT_DURATION_PER_SCENE = 8;

/**
 * Soft beat guidance — AI chia scene theo ý, không hardcode 8s/15s cố định.
 * Dùng để gợi ý UI + post-process split/merge.
 */
/**
 * Veo tính tiền MỖI VIDEO, không theo giây: 4s, 6s hay 8s đều là 4 credit.
 * Nên beat 8s (đúng trần một lần gen của Veo) rẻ hơn beat 6s tới 25% cho cùng
 * độ dài thành phẩm, lại ít scene hơn → ít lần gọi API, ít chỗ để hỏng.
 */
export const MIN_SCENE_BEAT_SEC = 4;
export const MAX_SCENE_BEAT_SEC = 8;
export const IDEAL_SCENE_BEAT_SEC = 8;
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
  { id: 'dense', label: 'Dày', hint: '~8s / scene', beatSec: 8 },
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

  // Trước đây nới trần lên 1,35× beat → narration 10,8s nhưng Veo chỉ gen được 8s,
  // clip hụt so với lời đọc. Giữ trần bằng đúng beat để hình và tiếng khớp nhau.
  const maxBeatSec = Math.min(
    MAX_SCENE_DURATION_SEC,
    Math.max(MAX_SCENE_BEAT_SEC, Math.round(typicalBeatSec))
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
