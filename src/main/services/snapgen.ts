import fs from 'node:fs';
import path from 'node:path';
import type { ImageFamily, VideoFamily } from '../../shared/types';
import { isSameResolution, normalizeVideoRequest, resolveModelId } from '../../shared/models';
import { canonicalAspectRatio } from '../../shared/output-format';

const BASE = 'https://api.snapgen.ai';

export interface SnapgenHistory {
  id?: number;
  uuid: string;
  status: number;
  status_percentage?: number;
  status_desc?: string | null;
  error_code?: string;
  error_message?: string;
  input_text?: string | null;
  model_name?: string | null;
  type?: string | null;
  created_at?: string | null;
  /** Credit Snapgen báo cho chính request này — có ngay trong response POST. */
  estimated_credit?: number | null;
  used_credit?: number | null;
  /** Hạn sống của media; quá hạn thì URL 404 nên không tái sử dụng được. */
  expired_at?: string | null;
  /** Frame cuối của video — làm keyframe mở đầu cho scene kế tiếp. */
  last_frame_url?: string | null;
  generated_video?: Array<{
    video_url?: string | null;
    duration?: number | null;
    aspect_ratio?: string | null;
    resolution?: string | null;
  }>;
  generated_image?: Array<{
    image_url?: string | null;
    file_download_url?: string | null;
    aspect_ratio?: string | null;
    resolution?: string | null;
  }>;
  /** Ảnh/video tham chiếu đã dùng khi gen — để biết clip có keyframe hay không. */
  reference_item?: Array<{
    media_type?: string | null;
    thumbnail_url?: string | null;
  }>;
}

/** Đổi thông báo lỗi Snapgen/Google sang tiếng Việt (giữ mã lỗi nếu có). */
export function localizeSnapgenError(
  message?: string | null,
  errorCode?: string | null,
  kind: 'video' | 'image' | 'request' = 'request'
): string {
  const raw = (message || '').trim();
  const code = (errorCode || '').trim();
  const blob = `${code} ${raw}`.toUpperCase();

  const withCode = (vi: string) => (code ? `${vi} (mã: ${code})` : vi);

  if (
    blob.includes('UNSAFE_GENERATION') ||
    blob.includes('DESCRIBE CHILDREN') ||
    blob.includes("GOOGLE'S POLICIES") ||
    blob.includes('CELEBRITY') ||
    blob.includes('THIRD-PARTY CONTENT') ||
    blob.includes('SPECIFIC CHARACTER')
  ) {
    return withCode(
      'Prompt bị Google chặn vì có nội dung không an toàn (trẻ em, người nổi tiếng, nhân vật bản quyền / bên thứ ba). Hãy sửa mô tả cảnh rồi thử lại.'
    );
  }

  if (blob.includes('NOT_ENOUGH_CREDIT') || blob.includes('INSUFFICIENT CREDIT')) {
    return withCode('Không đủ credit Snapgen. Nạp thêm credit rồi thử lại.');
  }

  if (blob.includes('NOT_ENOUGH_AND_LOCK_CREDIT') || blob.includes('LOCKED CREDIT')) {
    return withCode(
      'Credit không đủ hoặc đang bị khóa (job khác đang chạy). Đợi job xong hoặc nạp thêm credit.'
    );
  }

  if (blob.includes('INVALID_MODEL') || blob.includes('INVALID MODEL')) {
    return withCode('Model không hợp lệ. Chọn model khác trong Studio rồi thử lại.');
  }

  if (blob.includes('RATE') && blob.includes('LIMIT')) {
    return withCode('Đã vượt giới hạn số lần gọi API. Đợi một lát rồi thử lại.');
  }

  if (blob.includes('UNAUTHORIZED') || blob.includes('INVALID API') || blob.includes('401')) {
    return withCode('Snapgen API key không hợp lệ hoặc hết hạn. Kiểm tra lại trong Settings.');
  }

  if (blob.includes('TIMEOUT') || blob.includes('TIMED OUT')) {
    return withCode(
      kind === 'image'
        ? 'Hết thời gian chờ render ảnh Snapgen.'
        : kind === 'video'
          ? 'Hết thời gian chờ render video Snapgen.'
          : 'Hết thời gian chờ phản hồi Snapgen.'
    );
  }

  if (!raw) {
    return withCode(
      kind === 'image'
        ? 'Tạo ảnh thất bại.'
        : kind === 'video'
          ? 'Tạo video thất bại.'
          : 'Yêu cầu Snapgen thất bại.'
    );
  }

  // Giữ nguyên nếu đã tiếng Việt; còn lại gắn prefix rõ nguồn.
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(raw)) {
    return code ? `${raw} (mã: ${code})` : raw;
  }

  return withCode(`Lỗi Snapgen: ${raw}`);
}

export interface GenerateVideoParams {
  apiKey: string;
  family: VideoFamily;
  model: string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  mode?: string;
  /**
   * URL ảnh tham chiếu công khai (thường là `last_frame_url` của scene trước)
   * → dùng làm keyframe mở đầu để nối cảnh không cắt cứng.
   */
  refImageUrls?: string[];
}

export interface GenerateImageParams {
  apiKey: string;
  family: ImageFamily;
  model: string;
  prompt: string;
  aspectRatio: string;
  resolution: string;
  mode?: string;
}

function videoEndpoint(family: VideoFamily): string {
  const map: Record<VideoFamily, string> = {
    veo: `${BASE}/uapi/v1/video-gen/veo`,
    sora: `${BASE}/uapi/v1/video-gen/sora`,
    grok: `${BASE}/uapi/v1/video-gen/grok`,
    seedance: `${BASE}/uapi/v1/video-gen/seedance`,
    kling: `${BASE}/uapi/v1/video-gen/kling`,
    meta: `${BASE}/uapi/v1/video-gen/meta`,
  };
  return map[family];
}

/**
 * Field nhận URL ảnh tham chiếu, theo openapi.json:
 * - veo/seedance/kling: `ref_images` (nhận cả file lẫn URL)
 * - grok: `ref_images` chỉ nhận UUID ảnh của chính mình → URL phải đi qua `file_urls`
 * - sora/meta: chỉ có `files`/`file_urls`
 */
function refImageField(family: VideoFamily): 'ref_images' | 'file_urls' {
  return family === 'veo' || family === 'seedance' || family === 'kling'
    ? 'ref_images'
    : 'file_urls';
}

/** Số ảnh tham chiếu tối đa mỗi request (docs từng họ model). */
const MAX_REF_IMAGES: Record<VideoFamily, number> = {
  veo: 2, // frame mode: ảnh 1 = frame đầu, ảnh 2 = frame cuối
  seedance: 4,
  kling: 4,
  grok: 2,
  sora: 1, // docs: "API currently only accepts a single image"
  meta: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SnapgenErrorDetail {
  error_code?: string;
  message?: string;
  error_message?: string;
}

/**
 * Đọc lỗi Snapgen. Docs bọc trong `detail` ({error_code, message|error_message}),
 * vài endpoint trả phẳng, proxy hỏng thì trả HTML — nên nhận cả 3 dạng.
 * Trước đây chỉ đọc `data.message` ở tầng gốc nên MỌI mã lỗi đều bị mất.
 */
function readSnapgenError(
  body: unknown,
  rawText: string
): { code?: string; message?: string } {
  const root = (body ?? {}) as SnapgenErrorDetail & { detail?: unknown };
  const detail = root.detail;
  const nested: SnapgenErrorDetail =
    detail && typeof detail === 'object' ? (detail as SnapgenErrorDetail) : {};
  const code = nested.error_code || root.error_code;
  const message =
    nested.message ||
    nested.error_message ||
    (typeof detail === 'string' ? detail : undefined) ||
    root.message ||
    root.error_message ||
    // 422 của FastAPI có `detail` là ARRAY validation error — không field nào khớp ở trên,
    // nên giữ nguyên body để còn đọc được tham số nào bị từ chối.
    rawText.slice(0, 200);
  return { code: code?.trim() || undefined, message: message?.trim() || undefined };
}

/**
 * POST multipart tới Snapgen rồi trả history.
 * Giữ HTTP status trong message: scene-generate dò `/404|not found/` trên message
 * để fallback extend → generate, nên mất status là mất luôn fallback.
 */
async function postSnapgen(
  url: string,
  apiKey: string,
  form: FormData,
  kind: 'video' | 'image',
  label: string
): Promise<SnapgenHistory> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form,
  });
  const text = await res.text();
  let data: SnapgenHistory | null = null;
  try {
    data = JSON.parse(text) as SnapgenHistory;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const { code, message } = readSnapgenError(data, text);
    throw new Error(`${localizeSnapgenError(message, code, kind)} [HTTP ${res.status}]`);
  }
  if (!data?.uuid) {
    throw new Error(`${label} thiếu uuid: ${text.slice(0, 300)}`);
  }
  return data;
}

export async function testAccount(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${BASE}/uapi/v1/account`, {
      headers: { 'x-api-key': apiKey },
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    let creditHint = '';
    try {
      const data = JSON.parse(text) as {
        user_credit?: { available_credit?: number; locked_credit?: number };
      };
      const available = data.user_credit?.available_credit;
      if (typeof available === 'number') {
        creditHint = ` Credit còn lại: ${available.toLocaleString('vi-VN')}.`;
      }
    } catch {
      /* ignore */
    }
    return { ok: true, message: `Snapgen API key hợp lệ.${creditHint}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function generateVideo(params: GenerateVideoParams): Promise<SnapgenHistory> {
  const req = normalizeVideoRequest({
    modelId: params.model,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    mode: params.mode,
  });

  const form = new FormData();
  form.append('prompt', params.prompt);
  form.append('model', req.model);
  form.append('duration', String(req.duration));

  // Field theo openapi.json — mỗi endpoint nhận một bộ khác nhau, gửi sai thì bị bỏ im lặng.
  if (params.family === 'meta') {
    // video-gen/meta: `orientation` (landscape/portrait/square), không có aspect_ratio/resolution.
    form.append('orientation', req.aspectRatio);
  } else {
    form.append('aspect_ratio', req.aspectRatio);

    if (params.family === 'kling') {
      // Kling KHÔNG có param resolution: 1080p = mode `professional`
      // (normalizeVideoRequest đã nâng mode khi user chọn 1080p).
      form.append('mode', req.mode || 'standard');
    } else {
      form.append('resolution', req.resolution);

      if (params.family === 'grok') {
        form.append('mode', req.mode || 'custom');
        // Narration do TTS của app lo — bỏ audio Grok tự sinh.
        form.append('skip_audio', 'true');
      } else if (params.family === 'seedance') {
        form.append('mode', req.mode || 'pro');
      }
    }
  }

  // Keyframe nối cảnh: ảnh đầu tiên = frame mở đầu của clip mới.
  const refUrls = (params.refImageUrls ?? [])
    .filter((url) => /^https?:\/\//i.test(String(url || '').trim()))
    .slice(0, MAX_REF_IMAGES[params.family]);
  if (refUrls.length) {
    const field = refImageField(params.family);
    for (const url of refUrls) form.append(field, url);
    // Veo: `frame` = ảnh đóng vai frame đầu/cuối (mặc định của endpoint là ingredient-style).
    if (params.family === 'veo') form.append('mode_image', 'frame');
  }

  return postSnapgen(
    videoEndpoint(params.family),
    params.apiKey,
    form,
    'video',
    `Snapgen ${params.family}`
  );
}

export async function generateImage(params: GenerateImageParams): Promise<SnapgenHistory> {
  const form = new FormData();
  form.append('prompt', params.prompt);

  let url: string;
  if (params.family === 'gpt-image') {
    url = `${BASE}/uapi/v1/imagen/gpt-image-2`;
    form.append('aspect_ratio', params.aspectRatio);
    form.append('mode', params.mode || 'low');
    form.append('resolution', params.resolution);
  } else if (params.family === 'grok-image') {
    url = `${BASE}/uapi/v1/imagen/grok`;
    form.append('orientation', params.aspectRatio);
    form.append('num_result', '1');
    if (params.mode) form.append('mode', params.mode);
  } else {
    url = `${BASE}/uapi/v1/generate_image`;
    form.append('model', resolveModelId(params.model));
    form.append('aspect_ratio', params.aspectRatio);
    form.append('resolution', params.resolution);
    form.append('number_of_images', '1');
    form.append('output_format', 'png');
  }

  return postSnapgen(url, params.apiKey, form, 'image', 'Snapgen image');
}

export interface ExtendVideoParams {
  apiKey: string;
  family: VideoFamily;
  prompt: string;
  refHistory: string;
  /** Chỉ để log/ước tính — API extend luôn dùng duration của video gốc. */
  duration?: number;
  /** Chỉ để log — API extend luôn dùng resolution của video gốc. */
  resolution?: string;
  /** Chỉ endpoint video-extend/kling còn nhận mode. */
  mode?: string;
}

function extendEndpoint(family: VideoFamily): string | null {
  const map: Partial<Record<VideoFamily, string>> = {
    veo: `${BASE}/uapi/v1/video-extend/veo`,
    grok: `${BASE}/uapi/v1/video-extend/grok`,
    seedance: `${BASE}/uapi/v1/video-extend/seedance`,
    kling: `${BASE}/uapi/v1/video-extend/kling`,
  };
  return map[family] ?? null;
}

export async function extendVideo(params: ExtendVideoParams): Promise<SnapgenHistory> {
  const url = extendEndpoint(params.family);
  if (!url) {
    throw new Error(`Model family ${params.family} không hỗ trợ video extend.`);
  }

  const form = new FormData();
  form.append('prompt', params.prompt);
  form.append('ref_history', params.refHistory);

  // Extend tự lấy model/mode/duration/aspect/resolution từ video gốc (docs veo & seedance:
  // "cannot be modified"). Chỉ endpoint kling còn nhận `mode` theo openapi.json.
  if (params.family === 'kling' && params.mode) {
    form.append('mode', params.mode);
  }

  return postSnapgen(url, params.apiKey, form, 'video', 'Snapgen extend');
}

export async function getHistory(apiKey: string, uuid: string): Promise<SnapgenHistory> {
  const res = await fetch(`${BASE}/uapi/v1/history/${uuid}`, {
    headers: { 'x-api-key': apiKey },
  });
  const data = (await res.json()) as SnapgenHistory;
  if (!res.ok) {
    throw new Error(`Không lấy được lịch sử Snapgen: HTTP ${res.status}`);
  }
  return data;
}

/**
 * Google chặn prompt vì chính sách nội dung (RAI).
 * Thử lại y nguyên prompt là vô ích — phải sửa mô tả rồi mới gọi lại.
 */
export function isSafetyBlockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /GEMINI_RAI|RAI_MEDIA_FILTERED|UNSAFE_GENERATION|SAFETY|bị Google chặn|describe children|celebrity|third-party content/i.test(
    msg
  );
}

export function normalizeSnapgenPrompt(prompt: string): string {
  return String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Tỉ lệ tối thiểu giữa prompt ngắn/dài để coi là "cùng một prompt bị cắt đuôi".
 * Cao vì hai scene khác nhau vẫn có thể chung tiền tố rất dài.
 */
const PROMPT_TRUNCATION_MIN_RATIO = 0.9;

/**
 * So khớp prompt gửi Snapgen với input_text trên history.
 *
 * CHỈ chấp nhận: giống hệt, hoặc cái ngắn là TIỀN TỐ của cái dài và giữ được
 * ≥90% độ dài (Snapgen cắt đuôi input_text).
 *
 * KHÔNG được so theo N ký tự đầu. Prompt nối cảnh từng mở đầu bằng câu dài 158 ký
 * tự, nên so 160 ký tự đầu làm MỌI scene nối cảnh khớp lẫn nhau → 28 scene tải về
 * cùng một video cũ thay vì gen mới. Câu đó giờ đã chuyển xuống cuối prompt và rút
 * ngắn (xem `scene-generate.ts`), nhưng style prompt dùng chung vẫn có thể dài
 * hàng nghìn ký tự giống hệt nhau — so tiền tố cố định vẫn sai như cũ.
 */
export function snapgenPromptsMatch(a: string, b: string): boolean {
  const na = normalizeSnapgenPrompt(a);
  const nb = normalizeSnapgenPrompt(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length < 48) return false;
  if (!longer.startsWith(shorter)) return false;
  return shorter.length / longer.length >= PROMPT_TRUNCATION_MIN_RATIO;
}

export interface ListHistoriesOptions {
  filterBy?: string;
  page?: number;
  itemsPerPage?: number;
}

export async function listHistories(
  apiKey: string,
  options: ListHistoriesOptions = {}
): Promise<{ total: number | null; result: SnapgenHistory[] }> {
  const url = new URL(`${BASE}/uapi/v1/histories`);
  url.searchParams.set('filter_by', options.filterBy || 'all');
  url.searchParams.set('page', String(options.page ?? 1));
  url.searchParams.set('items_per_page', String(options.itemsPerPage ?? 20));
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  const text = await res.text();
  let data: {
    success?: boolean;
    total?: number | null;
    result?: SnapgenHistory[];
    detail?: unknown;
  } = {};
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(`Không lấy được danh sách history Snapgen: HTTP ${res.status}`);
  }
  return {
    total: typeof data.total === 'number' ? data.total : null,
    result: Array.isArray(data.result) ? data.result : [],
  };
}

/** URL frame cuối của một history, nếu Snapgen có cung cấp. */
export function lastFrameUrlOf(hist: SnapgenHistory): string | null {
  const url = String(hist.last_frame_url || '').trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Frame cuối của history video — keyframe mở đầu cho clip kế tiếp.
 * Không có / lỗi mạng → null (nối cảnh degrade về prompt-only, không làm fail scene).
 */
export async function getLastFrameUrl(apiKey: string, uuid: string): Promise<string | null> {
  try {
    return lastFrameUrlOf(await getHistory(apiKey, uuid));
  } catch {
    return null;
  }
}

export type ReusableHistoryKind = 'video' | 'image';

/**
 * Điều kiện một history cũ được coi là "đúng cái mình đang cần".
 * Trùng prompt là KHÔNG đủ: đổi model / 720p→1080p / đổi tỉ lệ mà prompt giữ nguyên
 * thì trước đây vẫn tải lại clip cũ, sai hẳn thông số người dùng vừa chọn.
 */
export interface ReusableExpectation {
  modelId?: string;
  resolution?: string;
  aspectRatio?: string;
  duration?: number;
  /**
   * false = job phải KHÔNG dùng ảnh tham chiếu.
   * Cố tình một chiều: khi đang cần keyframe mà history không khai reference_item,
   * ta vẫn nhận — thà nối cảnh yếu hơn là gen lại tốn credit.
   */
  withReference?: boolean;
}

/** Media Snapgen có hạn (~30 ngày) — hết hạn thì URL 404, đừng tái sử dụng. */
function isExpiredHistory(hist: SnapgenHistory): boolean {
  const raw = String(hist.expired_at || '').trim();
  if (!raw) return false;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at <= Date.now();
}

/** So khớp ở tầng list (chưa tốn thêm request chi tiết). */
function matchesHistoryRow(row: SnapgenHistory, expect?: ReusableExpectation): boolean {
  if (isExpiredHistory(row)) return false;
  const wantModel = expect?.modelId?.trim().toLowerCase();
  const gotModel = String(row.model_name || '').trim().toLowerCase();
  if (wantModel && gotModel && wantModel !== gotModel) return false;
  return true;
}

/** So khớp media đã render (chỉ gọi khi history đã COMPLETED). */
function matchesHistoryMedia(
  hist: SnapgenHistory,
  kind: ReusableHistoryKind,
  expect?: ReusableExpectation
): boolean {
  if (!expect) return true;
  if (expect.withReference === false && (hist.reference_item?.length ?? 0) > 0) return false;

  const media = kind === 'video' ? hist.generated_video?.[0] : hist.generated_image?.[0];
  if (!media) return true;

  if (!isSameResolution(expect.resolution, media.resolution)) return false;

  const gotAspect = String(media.aspect_ratio || '').trim();
  if (expect.aspectRatio && gotAspect) {
    if (canonicalAspectRatio(expect.aspectRatio) !== canonicalAspectRatio(gotAspect)) return false;
  }

  if (kind === 'video' && expect.duration != null) {
    const gotDuration = hist.generated_video?.[0]?.duration;
    // Snapgen làm tròn thời lượng thật (8s → 8.0/7.9) nên nới 1.5s.
    if (gotDuration != null && Math.abs(gotDuration - expect.duration) > 1.5) return false;
  }

  return true;
}

/**
 * Tìm history Snapgen trùng prompt để tái sử dụng (đã xong hoặc đang chạy).
 * Ưu tiên COMPLETED (status=2), rồi PROCESSING — tránh gọi generate lại tốn credit.
 */
export async function findReusableHistoryByPrompt(
  apiKey: string,
  prompt: string,
  kind: ReusableHistoryKind,
  options?: {
    maxPages?: number;
    pageSize?: number;
    expect?: ReusableExpectation;
    /** Job đã làm footage cho chunk khác — bỏ qua, không hai chunk chung một clip. */
    excludeUuids?: Set<string>;
  }
): Promise<SnapgenHistory | null> {
  const maxPages = options?.maxPages ?? 3;
  const pageSize = options?.pageSize ?? 25;
  const filterBy = kind === 'image' ? 'image' : 'video';
  let bestProcessing: SnapgenHistory | null = null;

  for (let page = 1; page <= maxPages; page++) {
    let rows: SnapgenHistory[] = [];
    try {
      const listed = await listHistories(apiKey, { filterBy, page, itemsPerPage: pageSize });
      rows = listed.result;
      if (!rows.length) break;
    } catch {
      break;
    }

    for (const row of rows) {
      if (!row?.uuid) continue;
      if (options?.excludeUuids?.has(row.uuid)) continue;
      const input = String(row.input_text || '');
      if (!snapgenPromptsMatch(prompt, input)) continue;
      if (row.status === 3) continue;
      if (!matchesHistoryRow(row, options?.expect)) continue;
      if (row.status === 2) {
        // List endpoint thường thiếu nested media — lấy chi tiết khi cần.
        try {
          const detail = await getHistory(apiKey, row.uuid);
          if (detail.status === 2) {
            if (!matchesHistoryMedia(detail, kind, options?.expect)) continue;
            return detail;
          }
          if (detail.status === 0 || detail.status === 1) {
            // Chưa render xong → chưa có media để so, chấp nhận theo prompt + model.
            bestProcessing = bestProcessing || detail;
          }
        } catch {
          return row;
        }
      } else if (row.status === 0 || row.status === 1) {
        bestProcessing = bestProcessing || row;
      }
    }

    if (rows.length < pageSize) break;
  }

  return bestProcessing;
}

function extractErrorCode(message?: string | null, explicit?: string | null): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const m = message?.match(/Error code:\s*([A-Z0-9_]+)/i);
  return m?.[1];
}

function extractMediaUrl(hist: SnapgenHistory, kind: 'video' | 'image'): string | null {
  if (kind === 'video') {
    return hist.generated_video?.[0]?.video_url ?? null;
  }
  const img = hist.generated_image?.[0];
  return img?.image_url || img?.file_download_url || null;
}

export async function waitForMedia(
  apiKey: string,
  uuid: string,
  kind: 'video' | 'image',
  onProgress?: (percent: number, status: number) => void,
  timeoutMs = 30 * 60 * 1000,
  shouldAbort?: () => boolean
): Promise<SnapgenHistory> {
  const started = Date.now();
  let delay = 4000;
  let completedWithoutUrlSince: number | null = null;

  while (Date.now() - started < timeoutMs) {
    if (shouldAbort?.()) {
      throw new Error('Đã dừng bởi người dùng (bỏ chờ Snapgen).');
    }
    const hist = await getHistory(apiKey, uuid);
    let pct = hist.status_percentage ?? 0;
    // Some Snapgen responses use 0–1 instead of 0–100.
    if (pct > 0 && pct <= 1) pct = Math.round(pct * 100);
    else pct = Math.min(100, Math.max(0, Math.round(pct)));
    onProgress?.(pct, hist.status);

    if (hist.status === 2) {
      const url = extractMediaUrl(hist, kind);
      if (url) return hist;
      // Status completed nhưng URL chưa sẵn — đợi thêm một lúc rồi mới fail.
      if (completedWithoutUrlSince == null) completedWithoutUrlSince = Date.now();
      if (Date.now() - completedWithoutUrlSince > 90_000) {
        throw new Error(
          kind === 'video'
            ? 'Video đã xong nhưng thiếu video_url trong lịch sử Snapgen.'
            : 'Ảnh đã xong nhưng thiếu image_url trong lịch sử Snapgen.'
        );
      }
      onProgress?.(Math.max(pct, 95), hist.status);
    } else if (hist.status === 3) {
      throw new Error(
        localizeSnapgenError(
          hist.error_message,
          extractErrorCode(hist.error_message, hist.error_code),
          kind
        )
      );
    } else {
      completedWithoutUrlSince = null;
    }

    const until = Date.now() + delay;
    while (Date.now() < until) {
      if (shouldAbort?.()) {
        throw new Error('Đã dừng bởi người dùng (bỏ chờ Snapgen).');
      }
      await sleep(Math.min(400, until - Date.now()));
    }
    delay = Math.min(delay + 2000, 15000);
  }

  throw new Error(
    localizeSnapgenError(
      kind === 'image'
        ? 'Timed out waiting for Snapgen image.'
        : 'Timed out waiting for Snapgen video.',
      'TIMEOUT',
      kind
    )
  );
}

export async function waitForVideo(
  apiKey: string,
  uuid: string,
  onProgress?: (percent: number, status: number) => void,
  timeoutMs = 30 * 60 * 1000
): Promise<SnapgenHistory> {
  return waitForMedia(apiKey, uuid, 'video', onProgress, timeoutMs);
}

export function getImageUrl(hist: SnapgenHistory): string | null {
  return extractMediaUrl(hist, 'image');
}

export async function downloadFile(url: string, destPath: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tải file thất bại: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return destPath;
}
