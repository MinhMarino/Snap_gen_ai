import { resolveAspectRatioForModel } from './output-format';
import {
  collapseLlmRepeats,
  looksLikeLlmInstruction,
  stripInlineMarkupJunk,
} from './narration-clean';
import type {
  ImageFamily,
  MediaKind,
  ModelOption,
  ScriptDraft,
  VideoFamily,
} from './types';

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
 * Vẻ ngoài kênh thiếu nhi YouTube: 3D bóng bẩy kiểu đồ chơi (Cocomelon / Kids TV).
 * Nhân vật là xe cộ - đồ vật - con vật có MẮT TO và miệng cười — thứ làm nên
 * thể loại này, và cũng là thứ tránh được lệnh chặn của Google vì không có trẻ em.
 *
 * CHỈ dùng cho dự án hoạt hình nhạc (music-animation). Dự án thường phải trung tính
 * về thể loại — xem `GENERAL_STYLE_PROMPT`.
 */
export const KIDS_3D_TOY_STYLE =
  'bright 3D cartoon animation for young children, glossy toy-like characters with big shiny ' +
  'cartoon eyes and happy smiles, chunky rounded shapes, bold saturated primary colors, ' +
  'sunny blue sky with fluffy white clouds, soft even lighting, clean simple background';

/** Bản 2D phẳng — giữ lại để đổi nhanh nếu muốn kiểu vẽ tay. */
export const KIDS_FLAT_2D_STYLE =
  'very simple flat 2D kids cartoon, thick clean outlines, bright cheerful colors, ' +
  'soft rounded shapes, big friendly eyes, minimal detail, plain empty background';

/**
 * Style mặc định của dự án THƯỜNG (standard) — trung tính về thể loại.
 * Chỉ nói về chất lượng khung hình và tính nhất quán giữa các scene, KHÔNG áp
 * kiểu vẽ nào: chủ đề là gì thì visual đi theo brief + style prompt người dùng nhập.
 *
 * Bản trước để `DEFAULT_STYLE_PROMPT = KIDS_3D_TOY_STYLE`, nên mọi dự án thường
 * (tài liệu, review, kể chuyện người lớn…) đều bị kéo về hoạt hình thiếu nhi.
 */
export const GENERAL_STYLE_PROMPT =
  'consistent look across every shot, one clear subject, natural lighting, ' +
  'clean uncluttered background, sharp and well composed';

export const DEFAULT_STYLE_PROMPT = GENERAL_STYLE_PROMPT;

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

/**
 * Style thiếu nhi từng là MẶC ĐỊNH của mọi dự án, nên project thường tạo trước đây
 * đã lưu sẵn chuỗi đó trong draft.json. Đổi hằng số mặc định không cứu được chúng:
 * style đã lưu vẫn được nhét vào prompt AI viết visual_prompt lẫn prompt gửi
 * Snapgen → vẫn ra hoạt hình dù người dùng chọn dự án thường.
 *
 * Vì vậy: dự án KHÔNG phải hoạt hình nhạc mà style đúng bằng một trong hai hằng số
 * kids cũ thì coi như chưa đặt style → trả về style trung tính. So khớp NGUYÊN
 * CHUỖI để style do người dùng tự viết (kể cả tự viết kiểu cartoon) không bị đụng.
 */
export function normalizeStylePromptForProjectKind(
  stylePrompt: string | null | undefined,
  kind?: string | null
): string {
  const value = String(stylePrompt || '').trim();
  if (!value) return defaultStylePromptForProjectKind(kind);
  if (String(kind || '') === 'music-animation') return value;
  const legacyKidsDefaults = [KIDS_3D_TOY_STYLE, KIDS_FLAT_2D_STYLE];
  return legacyKidsDefaults.includes(value) ? GENERAL_STYLE_PROMPT : value;
}

/**
 * Giọng kể mặc định của bước viết lời — «wrapper» đính vào prompt gửi ChatGPT.
 *
 * Trước đây chỗ này chỉ có ba dòng chung chung ("clear and natural", "short
 * sentences") CỘNG với style HÌNH ẢNH của dự án nhét nhầm vào. Kết quả là lời đọc
 * vồ vập: mở bằng câu giật gân, câu nào cũng nhồi ba ý, hết ý này nhảy sang ý khác
 * không có cầu nối — nghe như đọc quảng cáo chứ không như một kênh YouTube.
 *
 * Viết bằng tiếng Anh cho khớp phần còn lại của system prompt; ví dụ câu cấm để
 * tiếng Việt vì lời đọc thường là tiếng Việt và model bắt chước ví dụ rất sát.
 * Người dùng sửa được nguyên khối này trong ô «Giọng kể» ở bước 1.
 */
export const DEFAULT_NARRATION_STYLE = `You are the regular narrator of a YouTube channel, talking to one person who already chose to watch. Not an ad, not a news bulletin, not a lecture.

PACE — the video must never feel rushed:
- Open on the subject itself. No shock hook, no teaser, no "Bạn có biết…", no "Điều sắp thấy sẽ khiến bạn bất ngờ".
- One idea per sentence. Follow a long sentence with a short one — that is where the listener breathes.
- Finish a point before moving on: say it, show what it means, then move. Never stack three facts into one sentence.
- Join ideas out loud instead of cutting between them ("và đó là lý do…", "chỗ này mới lạ…").

VOICE:
- Address the viewer the same way from the first sentence to the last.
- Plain words. A term the audience may not know gets explained in half a sentence, the first time it appears.
- Curiosity, not hype: no piled-up superlatives, no exclamation marks, no two rhetorical questions in a row.
- Concrete beats abstract — a number, an object, a moment the viewer can picture.

NEVER:
- Like/subscribe/comment asks, sponsor reads, or "trong video hôm nay".
- Reading out list scaffolding ("thứ nhất… thứ hai…") unless the brief asks for a list.
- Starting two sentences in a row the same way.
- A sentence that only announces what comes next without saying anything itself.`;

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

/** Tổng footage `planSceneChunks` THỰC SỰ đặt hàng cho một cảnh dài `desiredSeconds`. */
export function plannedClipSeconds(
  modelId: string,
  family: string,
  desiredSeconds: number
): number {
  return planSceneChunks(modelId, family, desiredSeconds).chunks.reduce((sum, d) => sum + d, 0);
}

/** Lệch dưới mức này coi như bằng nhau (sai số dấu phẩy động, không phải hụt hình). */
const SCENE_DURATION_EPSILON = 0.01;

/**
 * Những độ dài cảnh mà model trả về ĐÚNG BẰNG số đặt hàng.
 *
 * Model chỉ nhận vài mốc rời rạc (Veo: 4/6/8s) và `clampDuration` làm tròn về mốc
 * GẦN NHẤT, nên cảnh 9,05s chỉ nhận được 8s footage. `planSceneChunks` còn một
 * nhánh tắt nữa: cảnh dài hơn max một ít (9–12s với Veo) chỉ gen 1 shot 8s. Cả hai
 * chỗ đều âm thầm hụt hình so với lời đọc.
 *
 * Danh sách dưới đây là các "điểm bất động": đặt bao nhiêu thì nhận đúng bấy nhiêu.
 * Kiểm bằng chính `planSceneChunks` nên không bao giờ lệch khỏi luật đặt hàng thật.
 *
 * `singleShot`: chỉ lấy những mốc gen được TRONG MỘT LẦN (Veo: 4/6/8s), bỏ hết mốc
 * ghép nhiều shot (16/24/32s). Xem `maxSceneBeatSec` để biết vì sao cảnh dài hơn
 * một lần gen là một sự đánh đổi tồi.
 */
export function achievableSceneDurations(
  modelId: string,
  family: string,
  maxSeconds: number,
  options?: { singleShot?: boolean }
): number[] {
  const model = getModelById(modelId);
  const allowed = model?.durations?.length ? [...model.durations] : [maxSingleShotDuration(modelId)];
  const max = Math.max(1, Math.max(...allowed));
  const limit = Math.max(max, Math.min(maxSeconds, MAX_SCENE_DURATION_SEC));

  const candidates = new Set<number>();
  if (options?.singleShot) {
    for (const d of allowed) candidates.add(d);
  } else {
    for (let k = 0; k * max <= limit; k++) {
      if (k > 0) candidates.add(k * max);
      for (const d of allowed) candidates.add(k * max + d);
    }
  }

  const ceiling = options?.singleShot ? max : limit + max;
  return [...candidates]
    .filter((sec) => sec > 0 && sec <= ceiling)
    .filter(
      (sec) => Math.abs(plannedClipSeconds(modelId, family, sec) - sec) < SCENE_DURATION_EPSILON
    )
    .sort((a, b) => a - b);
}

/**
 * Trần độ dài của MỘT cảnh.
 *
 * Video: đúng bằng một lần gen của model (Veo 8s). Dài hơn thế thì `planSceneChunks`
 * phải đặt nhiều shot cho CÙNG MỘT visual prompt — Veo tính tiền theo từng clip nên
 * không rẻ hơn đồng nào, đổi lại 32s gần như lặp đi lặp lại một khuôn hình. Cùng số
 * credit ấy, chia thành 4 cảnh 8s với 4 visual prompt khác nhau thì hình mới thay đổi.
 *
 * Ảnh tĩnh không có ràng buộc đó: một ảnh nằm trên trục bao lâu cũng được.
 */
export function maxSceneBeatSec(modelId: string, mediaKind?: MediaKind): number {
  if (mediaKind === 'image') return MAX_SCENE_DURATION_SEC;
  return Math.max(MIN_SCENE_BEAT_SEC, maxSingleShotDuration(modelId));
}

/**
 * Kéo độ dài một cảnh về mốc model làm được — footage khớp lời đọc, không phải
 * vá bằng frame đứng hình lúc ghép.
 *
 * `atLeast` (cảnh cuối): chỉ chọn mốc ĐỦ DÀI, thà dư vài giây rồi cắt còn hơn
 * cụt mất câu chốt. `tolerance` nới luật đó: hụt trong ngần này giây thì cứ lấy mốc
 * ngắn hơn, bước ghép vá nốt bằng frame cuối. Không có nó, model bước 25s (Sora Pro)
 * phải gen thêm nguyên một clip 25s để bù 3s cuối — vừa tốn credit vừa để lại 22s
 * video không có tiếng.
 */
export function snapSceneDurationToModel(
  modelId: string,
  family: string,
  desiredSeconds: number,
  options?: { atLeast?: boolean; tolerance?: number; singleShot?: boolean }
): number {
  const desired = Math.max(0.5, Number(desiredSeconds) || 0);
  const list = achievableSceneDurations(modelId, family, desired * 2 + 8, {
    singleShot: options?.singleShot,
  });
  if (!list.length) return desired;

  if (options?.atLeast) {
    const tolerance = Math.max(0, options.tolerance ?? 0);
    const under = [...list].reverse().find((sec) => sec <= desired + SCENE_DURATION_EPSILON);
    if (under != null && desired - under <= tolerance) return under;
    const over = list.find((sec) => sec >= desired - SCENE_DURATION_EPSILON);
    if (over != null) return over;
  }

  // Hoà thì lấy mốc DÀI hơn (7s → 8s chứ không phải 6s).
  //
  // Model video tính tiền mỗi clip, không theo giây: clip 8s và clip 6s cùng giá.
  // Cảnh ngắn đi nghĩa là cần thêm cảnh nữa mới phủ hết lời đọc — tức là thêm một
  // lượt gen phải trả tiền. Phần dư dồn sang cảnh sau (bước chia cảnh bám mốc gốc
  // nên không cộng dồn).
  return list.reduce((best, sec) =>
    Math.abs(sec - desired) <= Math.abs(best - desired) ? sec : best
  );
}

/*
 * ĐÃ XOÁ: `withStylePrompt` (nối `". Style: <style prompt>"` vào đuôi visual_prompt).
 *
 * Style giờ do bước viết kịch bản tả thẳng vào từng phân cảnh theo «Mô tả video» +
 * «Visual style», nên nối thêm ở đây là dán một khối chữ giống hệt nhau vào đuôi
 * mọi scene — thừa, và lấn át phần tả riêng của cảnh.
 */

/**
 * GHI CHÚ: các hàm bối cảnh văn hoá theo ngôn ngữ (`resolveVisualLocaleHint`,
 * `resolveCultureRule`, `resolveVisualLanguageLock`) đã bị xoá cùng ô Language.
 * Ngôn ngữ giờ tự nhận diện từ lời bình (`detect-language.ts`) và chỉ dùng cho
 * TTS + cách đếm ngân sách lời, không còn can thiệp vào prompt hình.
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

/**
 * Độ dài tối đa phần mô tả hình (ký tự).
 *
 * Bước viết kịch bản đặt hàng 55–90 từ, và KIỂU RENDER nằm ở CUỐI prompt — nên cắt
 * ngắn là rụng đúng phần mang Visual style. 90 từ mô tả (photorealistic,
 * cinematography, chiaroscuro… ~8 ký tự/từ) chạm ~720 ký tự, nên mức 700 vẫn cắt
 * những prompt dài nhất; 900 để phần đuôi luôn sống sót. Mức cũ 260 thì chặt mất
 * hơn nửa prompt.
 *
 * Đây là mức chặn AN TOÀN, không phải mục tiêu: prompt dài lê thê, nhiều mệnh lệnh
 * mâu thuẫn vẫn là nguyên nhân chính làm Veo Fast render hỏng.
 */
const MAX_VISUAL_PROMPT_CHARS = 900;

// ---------------------------------------------------------------------------
// Visual prompt có cấu trúc: khối cảnh riêng + ba khối cố định dùng chung
// ---------------------------------------------------------------------------

/**
 * «Style bible» rút ra MỘT LẦN từ «Visual style», rồi ghép nguyên văn vào prompt
 * của mọi cảnh — đúng cách người ta viết wrapper prompt cho Veo bằng tay.
 *
 * Bắt model tự diễn đạt lại phong cách ở từng cảnh (bản cũ) thì mỗi cảnh lệch đi
 * một ít, xem cả video thấy màu và chất liệu trôi dần. Khối cố định thì không.
 */
export interface VisualStyleBible {
  /** Chất liệu / kiểu render / độ thực / máy quay - ống kính. */
  style: string;
  /** Bảng màu, độ bão hoà, tương phản, mức đen, grade. */
  color: string;
  /** Cách mọi thứ chuyển động — chỉ dùng cho video. */
  motion?: string;
  /** Danh sách cấm, phân tách bằng dấu phẩy. */
  negative: string;
  /**
   * Một dòng tả thế giới + nhân vật/vật thể lặp lại.
   * KHÔNG ghép vào prompt — chỉ dùng làm ngữ cảnh khi viết phần tả cảnh.
   */
  seriesCast?: string;
}

export function hasVisualStyleBible(bible?: VisualStyleBible | null): boolean {
  return Boolean(bible?.style?.trim() && bible?.color?.trim() && bible?.negative?.trim());
}

/**
 * Prompt hoàn chỉnh của một cảnh: đoạn tả cảnh + STYLE + COLOR + MOTION + NEGATIVE.
 *
 * Nhãn viết hoa đầu dòng vừa để model đọc ra từng phần, vừa là dấu nhận biết cho
 * `isStructuredVisualPrompt` — prompt dạng này đã đầy đủ nên bước gen KHÔNG được
 * đem đi rút gọn hay nối thêm gì nữa.
 */
export function buildStructuredVisualPrompt(
  sceneText: string,
  bible: VisualStyleBible
): string {
  const scene = String(sceneText || '').trim();
  if (!scene || !hasVisualStyleBible(bible)) return scene;

  const blocks = [scene, `STYLE: ${bible.style.trim()}`, `COLOR: ${bible.color.trim()}`];
  if (bible.motion?.trim()) blocks.push(`MOTION: ${bible.motion.trim()}`);
  blocks.push(`NEGATIVE: ${bible.negative.trim()}`);
  return blocks.join('\n\n');
}

/** Prompt đã có đủ khối cố định → dùng nguyên văn, không compact, không nối đuôi. */
export function isStructuredVisualPrompt(text?: string | null): boolean {
  const value = String(text || '');
  return /^STYLE:/m.test(value) && /^NEGATIVE:/m.test(value);
}

/**
 * Chữ của các hệ không phải Latin — kana/Hán/Hangul, Thái, Cyrillic, Ả Rập,
 * Devanagari, Hebrew, Hy Lạp. Prompt hình luôn tiếng Anh, nên những ký tự này
 * trong prompt chỉ có thể là narration lọt vào.
 */
const NON_LATIN_RANGES =
  '\\u0370-\\u03FF\\u0400-\\u04FF\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F' +
  '\\u0E00-\\u0E7F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF' +
  '\\uFF66-\\uFF9F\\uAC00-\\uD7AF';
const NON_LATIN_SCRIPT_CHAR = new RegExp(`[${NON_LATIN_RANGES}]`, 'g');

/**
 * Cùng dải chữ trên, kèm dấu câu CJK — dùng để CẮT ĐÚNG ĐOẠN lời thoại lọt
 * vào và giữ lại phần tiếng Anh quanh nó. Bỏ cả mệnh đề thì prompt
 * "mascot showing <câu tiếng Nhật>. sunny hill…" mất luôn chủ thể.
 */
const NON_LATIN_RUN = new RegExp(
  `[${NON_LATIN_RANGES}][${NON_LATIN_RANGES}\\u3000-\\u303F\\uFF01-\\uFF60\\s]*`,
  'g'
);

/**
 * Lời thoại lọt vào prompt là lý do model VẼ chữ lên màn hình. Bản cũ chỉ soi
 * dấu tiếng Việt → narration tiếng Nhật/Trung/Hàn/Nga… đi qua tự do.
 *
 * Export để chỗ DỰNG prompt cũng dùng được: nhét vào một mệnh đề mà wrapper
 * chắc chắn cắt bỏ chỉ để lại câu prompt què ("... mascot showing.").
 */
export function looksLikeLeakedNarration(clause: string): boolean {
  if (
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(clause) &&
    clause.split(/\s+/).length > 4
  ) {
    return true;
  }
  // Chữ ngoài hệ Latin (CJK, Hàn, Thái, Cyrillic…): 4 ký tự đã là một mệnh đề
  // narration — prompt hình luôn viết bằng tiếng Anh.
  return (clause.match(NON_LATIN_SCRIPT_CHAR) || []).length >= 4;
}

/**
 * Dọn prompt tả hình: bỏ mệnh lệnh, bỏ ngoặc kép, bỏ lời thoại lọt vào, cắt theo
 * ranh giới câu khi vượt `maxChars`.
 *
 * Lọc MỆNH LỆNH chứ không phải lọc độ dài: phần tả hình (chất liệu, ánh sáng, kiểu
 * render) giữ nguyên bao nhiêu cũng được, chỉ những mệnh đề kiểu "must / never /
 * avoid" mới bị bỏ — model vẽ không làm theo được, chỉ tổ nhiễu.
 */
export function compactVisualPrompt(
  visualPrompt: string,
  maxChars = MAX_VISUAL_PROMPT_CHARS
): string {
  // Rác model (đề bài bị echo, "? ># ? >#" lặp vô hạn) lọt vào visual_prompt vì
  // prompt hình được dựng từ narration — cắt trước khi xét mệnh đề.
  let out = collapseLlmRepeats(stripInlineMarkupJunk(String(visualPrompt || '')));
  // Lời thoại không-Latin lọt vào: cắt đúng đoạn đó, giữ phần tả hình quanh nó.
  out = out.replace(NON_LATIN_RUN, ' ');
  for (const re of PROMPT_DIRECTIVE_PATTERNS) out = out.replace(re, ' ');

  // Bỏ mệnh lệnh (không phải tả hình) và lời thoại lọt vào. Cắt theo MỆNH ĐỀ
  // (câu + dấu ;) để câu "a fox mascot; big eyes; pose must act out…" vẫn giữ
  // được chủ thể, chỉ rụng đúng mệnh đề mệnh lệnh.
  const isDirective = (s: string) =>
    /\b(must|do not|don'?t|never|avoid|strictly|no readable|no on-screen)\b/i.test(s);
  const isLeakedNarration = looksLikeLeakedNarration;

  out = out
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      const kept = sentence
        .split(';')
        .map((clause) => clause.trim())
        .filter(
          (clause) =>
            clause &&
            !isDirective(clause) &&
            !isLeakedNarration(clause) &&
            !looksLikeLlmInstruction(clause)
        );
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

// ---------------------------------------------------------------------------
// Luật "hoạt hình hoá mọi thứ + cực đơn giản" — CHỈ cho hoạt hình nhạc thiếu nhi
//
// Trước đây cả hai wrapper dùng chung khối này, nên dự án thường bị ép thành
// hoạt hình: "cinematic" bị đổi thành "bright cheerful", "realistic" thành
// "cartoon", và mọi prompt bị nối thêm luật cartoon/nhún nhảy.
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
 * Chuyển động cho dự án THƯỜNG: một hành động rõ ràng, máy quay ổn định.
 * Trung tính về thể loại — chỉ chặn thứ Veo Fast hay làm hỏng (hành động dồn dập,
 * nhiều cú máy trong một shot), không quy định phong cách.
 */
export const STEADY_MOTION_RULE =
  'one clear continuous action, steady camera, no fast cuts';

/**
 * Prompt gửi Snapgen cho dự án THƯỜNG: mô tả hình + "no text".
 * Không gắn narration — lời thoại chỉ dùng cho TTS/subtitle.
 *
 * KHÔNG nối style prompt nữa. Style đã được đưa vào `visual_prompt` ngay từ bước
 * viết kịch bản: AI đọc «Mô tả video» + «Visual style» rồi tả thẳng chất liệu, ánh
 * sáng và kiểu render vào từng phân cảnh. Nối lại lần nữa ở đây là dán nguyên văn
 * một khối style giống hệt nhau vào đuôi mọi prompt — thừa, và khi style viết dạng
 * đoạn văn dài thì nó lấn át đúng phần tả riêng của scene.
 *
 * TRUNG TÍNH về thể loại: không nối luật cartoon, không đơn giản hoá cảnh, không
 * đổi từ khoá phong cách. Kiểu hình do brief + style prompt người dùng quyết định.
 * Bản trước chạy `simplifyBusyScene` và nối `CARTOON_WORLD_RULE` /
 * `SIMPLE_STAGING_RULE` — tức mọi dự án thường đều bị biến thành hoạt hình thiếu nhi.
 *
 * Cố tình KHÔNG dùng `resolveVisualLanguageLock`: câu đó liệt kê hàng loạt thứ
 * cấm ("signs, labels, screens, books, posters…") nên chính nó gợi model vẽ ra.
 *
 * Cũng KHÔNG còn mệnh đề bối cảnh văn hoá theo ngôn ngữ: ngôn ngữ giờ tự nhận
 * diện từ lời bình, không phải lựa chọn của người dùng nữa — lấy nó suy ra bối
 * cảnh hình là đoán mò (cảnh vũ trụ, cảnh sản phẩm không có "bối cảnh Việt Nam").
 * Muốn bối cảnh nào thì viết vào brief hoặc style prompt.
 */
export function buildSceneImagePrompt(options: {
  visualPrompt: string;
  /** 'video' → gắn thêm luật một hành động / máy quay ổn định. */
  mediaKind?: string | null;
}): string {
  const visual = compactVisualPrompt(options.visualPrompt || '');
  const parts = [visual.replace(/\.*$/, '')];

  if (options.mediaKind === 'video') parts.push(STEADY_MOTION_RULE);
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
 * KHÔNG nối «Visual style» vào đuôi prompt: bước viết kịch bản MV đã yêu cầu AI
 * tả kiểu hình vào TỪNG visual_prompt ("Style (same in every visual_prompt)"),
 * nên nối lại ở đây là dán nguyên văn một khối giống hệt nhau vào mọi scene —
 * thừa, và style viết dạng đoạn dài thì lấn át phần tả riêng của scene. Prompt
 * gửi Snapgen giờ chỉ dựng từ visual_prompt (+ cast lock và vài luật ngắn).
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

  // KHÔNG nối «Visual style» nữa — xem chú thích ở đầu hàm.

  // Không còn mệnh đề bối cảnh văn hoá theo ngôn ngữ — xem chú thích ở
  // `buildSceneImagePrompt`. Với mascot hoạt hình thì câu đó vốn cũng chỉ là nhiễu.
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
 * Bản trung tính cho dự án THƯỜNG: vẫn chặn đúng thứ Google chặn (trẻ em, người
 * thật, nhân vật bản quyền) nhưng KHÔNG ép chủ thể thành mascot hoạt hình —
 * dự án thường có thể là tài liệu, review, kể chuyện với nhân vật người lớn.
 */
export const GENERAL_SAFE_SUBJECT_RULE =
  'SAFETY: all characters are original fictional adults. No children, babies or ' +
  'toddlers. No real people, celebrities or public figures. No copyrighted, branded ' +
  'or third-party characters, no brand logos.';

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

/**
 * Bản trung tính cho dự án thường: trẻ em → người lớn, KHÔNG ép thành mascot.
 * Đổi "a little girl reading" thành "a friendly cartoon mascot reading" trong một
 * video tài liệu là hỏng cảnh, dù prompt có qua được kiểm duyệt.
 */
const GENERAL_CHILD_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [new RegExp(`\\b(?:a|an|the)\\s+${CHILD_QUALIFIERS}(?:${CHILD_NOUNS})\\b`, 'gi'), 'an adult'],
  [new RegExp(`\\b${CHILD_QUALIFIERS}(?:${CHILD_NOUNS})\\b`, 'gi'), 'adults'],
  [/\b(kindergarten|nursery|playschool|elementary school|primary school|school bus)\b/gi,
    'town setting'],
  [/\b(childlike|childish|youthful innocence)\b/gi, 'lighthearted'],
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
  [/\b(adults?)\s+\1\b/gi, '$1'],
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
 *  level 1 — xóa mốc tuổi, đổi từ chỉ trẻ em, bỏ tên thương hiệu / nhân vật
 *            bản quyền, gắn luật SAFETY.
 *  level 2 — phương án cuối: hoạt hình nhạc ép mọi chủ thể thành mascot động vật;
 *            dự án thường chỉ ép thành nhân vật hư cấu người lớn (giữ đúng thể loại).
 */
export function sanitizeUnsafePrompt(
  prompt: string,
  level: number,
  options?: {
    /** true (mặc định) = luật thiếu nhi: mọi chủ thể thành mascot hoạt hình. */
    cartoonSubjects?: boolean;
  }
): string {
  const src = String(prompt || '').trim();
  if (!src || level <= 0) return src;
  const cartoon = options?.cartoonSubjects !== false;

  let out = src;
  for (const re of AGE_PATTERNS) out = out.replace(re, ' ');
  out = applyReplacements(
    out,
    cartoon ? CHILD_TERM_REPLACEMENTS : GENERAL_CHILD_TERM_REPLACEMENTS
  );
  out = applyReplacements(out, LIKENESS_TERM_REPLACEMENTS);

  if (level >= 2) {
    if (cartoon) {
      out = applyReplacements(out, [
        [/\b(men|women|people|humans|persons|characters)\b/gi, 'animal mascots'],
        [/\b(man|woman|person|human|character)\b/gi, 'animal mascot'],
      ]);
      out = `${out} All subjects are non-human friendly animal mascots in a simple cartoon world.`;
    } else {
      // Không đổi danh từ chỉ người: dự án thường thường CẦN người trong khung.
      // Chỉ nói rõ đây là nhân vật hư cấu do mình dựng, không giống ai có thật.
      out = `${out} All people are original fictional adult characters, not resembling any real person.`;
    }
  }

  out = applyReplacements(out, CLEANUP_REPLACEMENTS);
  if (!out.toUpperCase().includes('SAFETY:')) {
    out = `${out} ${cartoon ? SAFE_SUBJECT_RULE : GENERAL_SAFE_SUBJECT_RULE}`;
  }
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

/**
 * Id của scene giữ TOÀN BỘ lời đọc khi kịch bản chưa phân cảnh.
 *
 * Bước 1 chỉ viết lời; phân cảnh đợi tới khi đo được độ dài audio thật (bước 3).
 * Giữ lời trong một scene thay vì mảng rỗng để mọi đường TTS/lưu draft/hiển thị
 * hiện có chạy nguyên như cũ, không phải rắc null-check khắp nơi.
 */
export const NARRATION_ONLY_SCENE_ID = 'narration-01';

/** Kịch bản mới: đã có lời đọc nhưng chưa scene nào có visual_prompt. */
export function isNarrationOnlyScript(
  script: { scenes?: Array<{ visual_prompt?: string }> } | null | undefined
): boolean {
  const scenes = script?.scenes;
  if (!scenes?.length) return true;
  return scenes.every((scene) => !(scene.visual_prompt || '').trim());
}

/** Toàn bộ lời đọc của kịch bản, dù đã phân cảnh hay chưa. */
export function narrationTextOfScript(
  script: { narration?: string; scenes?: Array<{ narration_segment?: string }> } | null | undefined
): string {
  const fromScenes = (script?.scenes || [])
    .map((scene) => (scene.narration_segment || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return fromScenes || (script?.narration || '').trim();
}

/** Gói lời đọc thành kịch bản CHƯA phân cảnh (một scene duy nhất, chưa có prompt hình). */
export function buildNarrationOnlyScript(options: {
  title: string;
  narration: string;
  targetDurationSec?: number;
}): ScriptDraft {
  const narration = options.narration.trim();
  return {
    title: options.title.trim() || 'Untitled Video',
    narration,
    scenes: [
      {
        id: NARRATION_ONLY_SCENE_ID,
        visual_prompt: '',
        narration_segment: narration,
        duration_hint: Math.max(
          MIN_SCENE_BEAT_SEC,
          Math.round(options.targetDurationSec || estimateSpokenSeconds(narration, MIN_SCENE_BEAT_SEC))
        ),
      },
    ],
  };
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
/**
 * Nhịp đọc MẶC ĐỊNH — chỉ dùng khi chưa đo được giọng thật.
 *
 * Nhịp thật phụ thuộc giọng + ngôn ngữ + tốc độ TTS và lệch rất xa con số này
 * (tiếng Nhật flash_v2_5 đọc nhanh hơn 5 ký tự/s khá nhiều), mà toàn bộ ngân sách
 * lời đọc lại tính từ đây → video ra ngắn hơn thời lượng đặt. Vì vậy `speech-rate.ts`
 * bên main đo lại tỉ lệ (ký tự | từ) / giây từ chính file audio TTS vừa tạo rồi nạp
 * vào đây bằng `setSpeechRateProfile()`.
 */
export const DEFAULT_WORDS_PER_SECOND = 2.5;
/** Nhịp đọc tiếng Nhật/Trung/Hàn ≈ ký tự/giây (không dựa vào khoảng trắng). */
export const DEFAULT_CJK_CHARS_PER_SECOND = 5;

/**
 * Biên an toàn cho nhịp đọc: một lần đo hỏng (audio hụt, text lệch) không được
 * phép kéo ngân sách lời đi quá xa. Biên rộng để vẫn ôm được giọng đọc nhanh.
 */
export const MIN_WORDS_PER_SECOND = 1.2;
export const MAX_WORDS_PER_SECOND = 6;
export const MIN_CJK_CHARS_PER_SECOND = 2.5;
export const MAX_CJK_CHARS_PER_SECOND = 14;

export interface SpeechRateProfile {
  /** Latin: từ/giây. */
  wordsPerSec: number;
  /** CJK: ký tự/giây. */
  cjkCharsPerSec: number;
}

/** Nhịp đọc đang áp dụng + xuất xứ của nó, để hiện trong UI. */
export interface SpeechRateInfo extends SpeechRateProfile {
  /** Ngôn ngữ đang xét thuộc nhóm nào. */
  kind: 'cjk' | 'latin';
  /** Nhịp đọc áp dụng cho nhóm đó (ký tự/s hoặc từ/s). */
  perSec: number;
  unitLabel: 'ký tự' | 'từ';
  /** manual = ô Settings, measured = đo từ audio thật, default = chưa đo lần nào. */
  source: 'manual' | 'measured' | 'default';
  /** Số lần đo đã gộp vào con số đang dùng. */
  samples: number;
  languageKey: string;
  lastUnits?: number;
  lastSeconds?: number;
  updatedAt?: string;
  defaultPerSec: number;
}

export function clampWordsPerSec(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WORDS_PER_SECOND;
  return Math.min(MAX_WORDS_PER_SECOND, Math.max(MIN_WORDS_PER_SECOND, n));
}

export function clampCjkCharsPerSec(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CJK_CHARS_PER_SECOND;
  return Math.min(MAX_CJK_CHARS_PER_SECOND, Math.max(MIN_CJK_CHARS_PER_SECOND, n));
}

/**
 * Nhịp đọc đang hiệu lực của TIẾN TRÌNH này. Main và renderer chạy hai process
 * khác nhau nên mỗi bên giữ một bản: main nạp từ số đo thật trước mỗi lần viết
 * lời / chia cảnh, renderer nạp qua IPC để mấy dòng ước lượng "~X phút" khớp.
 */
let activeSpeechRate: SpeechRateProfile = {
  wordsPerSec: DEFAULT_WORDS_PER_SECOND,
  cjkCharsPerSec: DEFAULT_CJK_CHARS_PER_SECOND,
};

export function getSpeechRateProfile(): SpeechRateProfile {
  return { ...activeSpeechRate };
}

export function setSpeechRateProfile(
  next: Partial<SpeechRateProfile> | null | undefined
): SpeechRateProfile {
  activeSpeechRate = {
    wordsPerSec:
      next?.wordsPerSec == null
        ? activeSpeechRate.wordsPerSec
        : clampWordsPerSec(next.wordsPerSec),
    cjkCharsPerSec:
      next?.cjkCharsPerSec == null
        ? activeSpeechRate.cjkCharsPerSec
        : clampCjkCharsPerSec(next.cjkCharsPerSec),
  };
  return { ...activeSpeechRate };
}

export function resetSpeechRateProfile(): SpeechRateProfile {
  activeSpeechRate = {
    wordsPerSec: DEFAULT_WORDS_PER_SECOND,
    cjkCharsPerSec: DEFAULT_CJK_CHARS_PER_SECOND,
  };
  return { ...activeSpeechRate };
}
/** Narration phải đạt tối thiểu tỉ lệ này so với target trước TTS. */
export const MIN_NARRATION_COVERAGE = 0.85;
/**
 * Per-scene: nới hơn tổng coverage.
 * `duration_hint` thường đã scale theo target (dài hơn lời) → so 85% sẽ false-positive hàng loạt.
 */
export const MIN_SCENE_NARRATION_FILL = 0.6;
/** Bỏ qua lệch nhỏ (giây) — làm tròn / scale hint. */
export const MIN_SCENE_NARRATION_GAP_SEC = 2;

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
  /** Tổng số từ cần đọc ≈ target × nhịp đọc đang hiệu lực. */
  targetWordCount: number;
}

export type PlanScenesOptions = {
  /** Số ảnh/video mong muốn (ưu tiên hơn beatSec). */
  targetSceneCount?: number;
  /** Độ dài beat trung bình khi không chỉ định count. */
  typicalBeatSec?: number;
  mediaKind?: MediaKind;
  /**
   * Trần độ dài một cảnh (`maxSceneBeatSec`). Mật độ thưa hơn trần này sẽ bị chia
   * nhỏ lại: một cảnh dài hơn một lần gen chỉ là cùng một hình lặp lại.
   */
  beatCapSec?: number;
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

  // Trần một cảnh: mặc định không ràng buộc, người gọi biết model thì truyền
  // `maxSceneBeatSec` vào — mật độ "Tiết kiệm 30s" trên Veo (8s/lần gen) không
  // tiết kiệm gì cả, chỉ đổi 4 cảnh khác hình lấy 1 cảnh lặp lại 4 lần.
  const beatCap = Math.max(
    MIN_SCENE_BEAT_SEC,
    Number(options.beatCapSec) > 0 ? Number(options.beatCapSec) : MAX_SCENE_DURATION_SEC
  );
  const sceneCountMin = Math.max(3, Math.ceil(target / Math.min(beatCap, MAX_SCENE_DURATION_SEC)));
  const sceneCountMax = Math.max(sceneCountMin, Math.floor(target / MIN_SCENE_BEAT_SEC));

  let sceneCountHint: number;
  let typicalBeatSec: number;

  if (options.targetSceneCount != null && Number(options.targetSceneCount) > 0) {
    sceneCountHint = clampTargetSceneCount(target, options.targetSceneCount);
  } else {
    const beat = Math.min(
      beatCap,
      Math.max(
        MIN_SCENE_BEAT_SEC,
        Number(options.typicalBeatSec) > 0 ? Number(options.typicalBeatSec) : IDEAL_SCENE_BEAT_SEC
      )
    );
    sceneCountHint = clampTargetSceneCount(target, Math.round(target / beat));
  }
  // Số cảnh do người dùng nhập cũng phải nằm trong trần: ít hơn thì cảnh dài hơn
  // một lần gen.
  sceneCountHint = Math.min(sceneCountMax, Math.max(sceneCountMin, sceneCountHint));
  typicalBeatSec = Math.round((target / sceneCountHint) * 10) / 10;

  // Trước đây nới trần lên 1,35× beat → narration 10,8s nhưng Veo chỉ gen được 8s,
  // clip hụt so với lời đọc. Giữ trần bằng đúng beat để hình và tiếng khớp nhau.
  const maxBeatSec = Math.min(
    beatCap,
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
    targetWordCount: Math.round(target * activeSpeechRate.wordsPerSec),
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

/** Token phải có ít nhất một chữ/số mới là "từ" đọc được. */
const SPOKEN_TOKEN_RE = /[\p{L}\p{N}]/u;

/**
 * Số từ Latin trong câu, BỎ token chỉ có dấu câu.
 *
 * Quan trọng với tiếng Nhật/Trung: bỏ ký tự CJK ra rồi tách khoảng trắng thì mỗi
 * dấu 。、「」 thành một "từ". Một trang tiếng Nhật có hàng trăm dấu như vậy →
 * ước lượng thời lượng đọc phồng lên cả phút, và vòng viết bù ở bước 1 dừng sớm
 * vì tưởng đã đủ dài.
 */
function countLatinWords(text: string): number {
  return text
    .replace(CJK_CHAR_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => SPOKEN_TOKEN_RE.test(token)).length;
}

export function countSpokenWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Tiếng Nhật/Trung/Hàn thường không cách từ — đếm ký tự CJK.
  const cjk = countCjkChars(trimmed);
  const latin = countLatinWords(trimmed);
  if (cjk >= 8 && cjk >= latin * 2) return cjk;
  if (cjk > 0 && latin === 0) return cjk;
  // Hỗn hợp: quy đổi CJK → “từ tương đương” để so sánh ngân sách từ Latin.
  if (cjk > 0) {
    return (
      latin +
      Math.round(cjk * (activeSpeechRate.wordsPerSec / activeSpeechRate.cjkCharsPerSec))
    );
  }
  return latin;
}

/** Nhịp đọc thật của giọng đang dùng (mặc định Latin 2.5 từ/s, CJK 5 ký tự/s). */
export function estimateSpokenSeconds(text: string, fallback = 6): number {
  const trimmed = text.trim();
  if (!trimmed) return fallback;

  const cjk = countCjkChars(trimmed);
  const latin = countLatinWords(trimmed);

  let seconds = 0;
  if (cjk) seconds += cjk / activeSpeechRate.cjkCharsPerSec;
  if (latin) seconds += latin / activeSpeechRate.wordsPerSec;
  if (!seconds) return fallback;
  return Math.max(2, seconds);
}

export function wordsForDurationSec(seconds: number): number {
  return Math.max(4, Math.round(Math.max(0, seconds) * activeSpeechRate.wordsPerSec));
}

/** Ngân sách lời thoại theo ngôn ngữ (từ hoặc ký tự CJK). */
export function spokenBudgetForDurationSec(
  seconds: number,
  language?: string | null
): { amount: number; unitLabel: string; perSec: number } {
  if (isCjkLanguage(language)) {
    const perSec = activeSpeechRate.cjkCharsPerSec;
    const amount = Math.max(8, Math.round(Math.max(0, seconds) * perSec));
    return { amount, unitLabel: 'ký tự', perSec };
  }
  return {
    amount: wordsForDurationSec(seconds),
    unitLabel: 'từ',
    perSec: activeSpeechRate.wordsPerSec,
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
