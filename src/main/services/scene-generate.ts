import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMusicSceneImagePrompt,
  buildSceneImagePrompt,
  familySupportsExtend,
  MAX_PROMPT_SAFETY_LEVEL,
  planSceneChunks,
  sanitizeUnsafePrompt,
} from '../../shared/models';
import type {
  ImageFamily,
  MediaKind,
  SceneDraft,
  SceneJobProgress,
  VideoFamily,
} from '../../shared/types';
import {
  concatClipFiles,
  isNanoBananaModel,
  stripNanoBananaWatermark,
} from './ffmpeg';
import { safeSceneKey, sceneMediaTarget } from './scene-media';
import {
  downloadFile,
  extendVideo,
  findReusableHistoryByPrompt,
  generateImage,
  generateVideo,
  getHistory,
  getImageUrl,
  getLastFrameUrl,
  isSafetyBlockedError,
  snapgenPromptsMatch,
  waitForMedia,
  type ReusableExpectation,
  type SnapgenHistory,
} from './snapgen';
import { isRetryableMediaError, withRetries } from './worker-pool';

export interface SceneGenerateContext {
  apiKey: string;
  mediaKind: MediaKind;
  family: string;
  model: string;
  aspectRatio: string;
  resolution: string;
  mode?: string;
  stylePrompt?: string;
  /** Ngôn ngữ kịch bản — gắn locale vào prompt ảnh. */
  language?: string;
  /** 'music-animation' → dùng prompt wrapper riêng cho MV. */
  projectKind?: string;
  /** music-animation: cast/style bible lặp vào mọi scene (chống drift nhân vật). */
  castLock?: string;
  /** music-animation + ảnh: khung đứng yên (không Ken Burns) → prompt bố cục 1 khung. */
  stillFrame?: boolean;
  imagesDir: string;
  clipsDir: string;
  workDir: string;
  maxAttempts?: number;
  /** true → hủy poll/retry (Stop). Pause không abort scene đang chạy. */
  shouldAbort?: () => boolean;
  /**
   * UUID history của scene/clip trước để nối liền mạch:
   * family hỗ trợ extend → video-extend `ref_history`;
   * còn lại → lấy `last_frame_url` của history đó làm keyframe mở đầu.
   */
  chainFromHistory?: string | null;
}

export type SceneProgressUpdate = Partial<
  Pick<
    SceneJobProgress,
    'state' | 'detailPercent' | 'chunkIndex' | 'chunkTotal' | 'attempt' | 'error'
  >
> & {
  /** 0–1 tiến độ trong scene (kể cả multi-chunk). */
  local01?: number;
};

export interface SceneGenerateResult {
  mediaPath: string;
  /** UUID Snapgen history cuối cùng của scene — dùng chain scene kế tiếp. */
  historyUuid?: string;
  /** Credit Snapgen báo cho các job MỚI tạo trong lượt này (job tái dùng = 0). */
  estimatedCredit?: number;
}

interface ChunkJobCheckpoint {
  promptKey: string;
  prompt: string;
  uuid: string;
  kind: 'video' | 'image';
  mode: 'generate' | 'extend' | 'reuse';
  updatedAt: string;
  /** Credit Snapgen báo khi tạo job này. */
  estimatedCredit?: number;
}

function normalizeSnapgenPercent(raw?: number): number {
  if (raw == null || Number.isNaN(raw)) return 0;
  if (raw > 0 && raw <= 1) return Math.round(raw * 100);
  return Math.min(100, Math.max(0, Math.round(raw)));
}

function promptKey(parts: Record<string, string | number | undefined | null>): string {
  const payload = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k] ?? ''}`)
    .join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function chunkJobPath(segmentDir: string, chunkIndex: number): string {
  return path.join(segmentDir, `chunk-${chunkIndex + 1}.job.json`);
}

function readChunkJob(segmentDir: string, chunkIndex: number): ChunkJobCheckpoint | null {
  const p = chunkJobPath(segmentDir, chunkIndex);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as ChunkJobCheckpoint;
    if (!raw?.uuid || !raw?.promptKey) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeChunkJob(segmentDir: string, chunkIndex: number, job: ChunkJobCheckpoint): void {
  fs.mkdirSync(segmentDir, { recursive: true });
  fs.writeFileSync(chunkJobPath(segmentDir, chunkIndex), JSON.stringify(job, null, 2), 'utf8');
}

function clearChunkJob(segmentDir: string, chunkIndex: number): void {
  const p = chunkJobPath(segmentDir, chunkIndex);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

async function downloadWithRetries(
  url: string,
  destPath: string,
  label: string,
  shouldAbort?: () => boolean
): Promise<void> {
  await withRetries(
    `${label} download`,
    async () => {
      if (shouldAbort?.()) throw new Error('Đã dừng bởi người dùng');
      await downloadFile(url, destPath);
      if (!fs.existsSync(destPath) || fs.statSync(destPath).size <= 0) {
        throw new Error('File tải về rỗng hoặc thiếu');
      }
    },
    { maxAttempts: 4, baseDelayMs: 1500, shouldAbort }
  );
}

/**
 * Lấy UUID đã có (checkpoint / Snapgen history) hoặc tạo job mới — không tạo trùng khi đã có.
 */
async function resolveMediaJobUuid(options: {
  apiKey: string;
  kind: 'video' | 'image';
  prompt: string;
  key: string;
  segmentDir: string;
  chunkIndex: number;
  create: () => Promise<SnapgenHistory>;
  shouldAbort?: () => boolean;
  /** Chặn tái dùng history trùng prompt nhưng khác model/tỉ lệ/độ phân giải/thời lượng. */
  expect?: ReusableExpectation;
}): Promise<{ uuid: string; reused: boolean; estimatedCredit?: number }> {
  const existing = readChunkJob(options.segmentDir, options.chunkIndex);
  if (existing && existing.promptKey === options.key && existing.uuid) {
    // Checkpoint mode 'reuse' từng được ghi bởi matcher lỏng (khớp theo tiền tố)
    // nên có thể trỏ sang job của scene khác. Đối chiếu prompt thật trên Snapgen
    // rồi mới dùng; không xác thực được thì cứ dùng như trước.
    if (existing.mode === 'reuse') {
      try {
        const hist = await getHistory(options.apiKey, existing.uuid);
        if (!snapgenPromptsMatch(options.prompt, String(hist.input_text || ''))) {
          clearChunkJob(options.segmentDir, options.chunkIndex);
        } else {
          return { uuid: existing.uuid, reused: true };
        }
      } catch {
        return { uuid: existing.uuid, reused: true };
      }
    } else {
      return { uuid: existing.uuid, reused: true };
    }
  } else if (existing && existing.promptKey !== options.key) {
    // Checkpoint cũ khác prompt → bỏ, tránh gắn nhầm clip.
    clearChunkJob(options.segmentDir, options.chunkIndex);
  }

  if (options.shouldAbort?.()) {
    throw new Error('Đã dừng bởi người dùng');
  }

  // Tìm trên Snapgen history theo prompt (job đã xong / đang chạy nhưng app chưa tải).
  try {
    const found = await findReusableHistoryByPrompt(options.apiKey, options.prompt, options.kind, {
      expect: options.expect,
    });
    if (found?.uuid) {
      writeChunkJob(options.segmentDir, options.chunkIndex, {
        promptKey: options.key,
        prompt: options.prompt.slice(0, 2000),
        uuid: found.uuid,
        kind: options.kind,
        mode: 'reuse',
        updatedAt: new Date().toISOString(),
      });
      return { uuid: found.uuid, reused: true };
    }
  } catch {
    /* history lookup optional — tiếp tục create */
  }

  if (options.shouldAbort?.()) {
    throw new Error('Đã dừng bởi người dùng');
  }

  const job = await options.create();
  if (!job.uuid) throw new Error('Snapgen không trả uuid');
  const estimatedCredit =
    typeof job.estimated_credit === 'number' && job.estimated_credit >= 0
      ? job.estimated_credit
      : undefined;
  writeChunkJob(options.segmentDir, options.chunkIndex, {
    promptKey: options.key,
    prompt: options.prompt.slice(0, 2000),
    uuid: job.uuid,
    kind: options.kind,
    mode: 'generate',
    updatedAt: new Date().toISOString(),
    estimatedCredit,
  });
  return { uuid: job.uuid, reused: false, estimatedCredit };
}

/**
 * Generate + poll + download MỘT scene (image hoặc video).
 * Checkpoint UUID theo chunk + match history theo prompt → tránh gen lại tốn credit.
 */
export async function generateOneSceneMedia(
  ctx: SceneGenerateContext,
  scene: SceneDraft,
  sceneIndex: number,
  onProgress?: (update: SceneProgressUpdate) => void
): Promise<SceneGenerateResult> {
  const isMusicAnimation = ctx.projectKind === 'music-animation';
  const basePrompt = isMusicAnimation
    ? buildMusicSceneImagePrompt({
        visualPrompt: scene.visual_prompt,
        stylePrompt: ctx.stylePrompt,
        castLock: ctx.castLock,
        sceneIndex,
        section: scene.section,
        stillFrame: ctx.stillFrame,
        mediaKind: ctx.mediaKind,
      })
    : buildSceneImagePrompt({
        visualPrompt: scene.visual_prompt,
        stylePrompt: ctx.stylePrompt,
        mediaKind: ctx.mediaKind,
      });
  const label = `Scene ${sceneIndex + 1}`;
  const maxAttempts = ctx.maxAttempts ?? 3;
  const segmentDir = path.join(ctx.workDir, `scene-${safeSceneKey(scene.id)}`);
  fs.mkdirSync(segmentDir, { recursive: true });

  /**
   * Bị Google chặn thì thử lại y nguyên prompt là vô nghĩa — phải viết lại mô tả.
   * Mỗi lần bị chặn nâng 1 mức làm sạch rồi mới cho retry.
   */
  let safetyLevel = 0;
  let justEscalated = false;

  return withRetries(
    label,
    async (attempt) => {
      if (ctx.shouldAbort?.()) {
        throw new Error('Đã dừng bởi người dùng');
      }
      if (attempt > 1) {
        onProgress?.({ state: 'retrying', attempt, detailPercent: 0, local01: 0 });
      }
      // Dự án thường: làm sạch theo hướng trung tính (không ép chủ thể thành mascot
      // hoạt hình) — nếu không, một lần bị RAI chặn là cả video đổi sang thể loại khác.
      const prompt =
        safetyLevel > 0
          ? sanitizeUnsafePrompt(basePrompt, safetyLevel, {
              cartoonSubjects: isMusicAnimation,
            })
          : basePrompt;
      try {

      if (ctx.mediaKind === 'image') {
        const key = promptKey({
          kind: 'image',
          family: ctx.family,
          model: ctx.model,
          prompt,
          aspect: ctx.aspectRatio,
          resolution: ctx.resolution,
          mode: ctx.mode,
        });

        onProgress?.({
          state: attempt > 1 ? 'retrying' : 'generating',
          attempt,
          detailPercent: 0,
          local01: 0,
        });

        const { uuid, reused, estimatedCredit } = await resolveMediaJobUuid({
          apiKey: ctx.apiKey,
          kind: 'image',
          prompt,
          key,
          segmentDir,
          chunkIndex: 0,
          shouldAbort: ctx.shouldAbort,
          expect: {
            modelId: ctx.model,
            resolution: ctx.resolution,
            aspectRatio: ctx.aspectRatio,
          },
          create: () =>
            generateImage({
              apiKey: ctx.apiKey,
              family: ctx.family as ImageFamily,
              model: ctx.model,
              prompt,
              aspectRatio: ctx.aspectRatio,
              resolution: ctx.resolution,
              mode: ctx.mode,
            }),
        });

        if (reused) {
          onProgress?.({
            state: 'polling',
            attempt,
            detailPercent: 5,
            local01: 0.05,
            error: 'Tái sử dụng job Snapgen đã có — đang tải…',
          });
        }

        onProgress?.({ state: 'polling', attempt, detailPercent: 0, local01: 0 });
        const hist = await waitForMedia(
          ctx.apiKey,
          uuid,
          'image',
          (pct) => {
            const shot = normalizeSnapgenPercent(pct);
            onProgress?.({
              state: 'polling',
              attempt,
              detailPercent: shot,
              local01: shot / 100,
            });
          },
          30 * 60 * 1000,
          ctx.shouldAbort
        );

        const url = getImageUrl(hist);
        if (!url) throw new Error(`Thiếu image_url cho ${label}`);

        const imagePath = sceneMediaTarget(ctx.imagesDir, scene.id, 'png');
        await downloadWithRetries(url, imagePath, label, ctx.shouldAbort);
        if (isNanoBananaModel(ctx.model)) {
          await stripNanoBananaWatermark(imagePath);
        }
        onProgress?.({ state: 'completed', attempt, detailPercent: 100, local01: 1 });
        return { mediaPath: imagePath, historyUuid: hist.uuid || uuid, estimatedCredit };
      }

      // Video: extend trong scene dài; có thể chain từ scene trước qua ref_history
      // (family hỗ trợ extend) hoặc qua keyframe last_frame_url (mọi family).
      const desired = Math.max(1, scene.duration_hint);
      const plan = planSceneChunks(ctx.model, String(ctx.family), desired);
      const canExtend = familySupportsExtend(String(ctx.family));
      const chainFrom = ctx.chainFromHistory?.trim() || null;
      const segmentPaths: string[] = [];
      let refHistory: string | null = chainFrom;
      let creditSpent = 0;

      for (let c = 0; c < plan.chunks.length; c++) {
        if (ctx.shouldAbort?.()) {
          throw new Error('Đã dừng bởi người dùng');
        }
        const chunkDur = plan.chunks[c];
        const isFirst = c === 0;
        const chainingIntoScene = Boolean(isFirst && chainFrom);

        const useExtend = Boolean(
          canExtend && refHistory && (chainingIntoScene || (!isFirst && plan.mode === 'extend'))
        );

        // Không extend được mà vẫn có clip trước → nối bằng keyframe (frame cuối clip trước).
        // Đây là đường duy nhất để Sora/Meta liền mạch, và cũng vá chỗ cắt cứng của multi-cut.
        const useKeyframe = Boolean(refHistory) && !useExtend;

        /*
         * Luật nối cảnh đứng CUỐI và viết thật ngắn.
         *
         * Bản trước đặt nó lên ĐẦU, dài 158 ký tự ("Continue seamlessly from the
         * previous shot with no hard cut. Keep the same characters, style, palette,
         * and camera language. Natural motion continuation into: "). Vì chain bật
         * mặc định cho video, mọi scene từ #2 trở đi mở đầu bằng đúng câu đó — hai
         * scene liền nhau giống nhau 164 ký tự đầu. Model đọc phần đầu nặng nhất,
         * nên thứ nó nhận được rõ nhất là "giữ nguyên như cảnh trước", còn mô tả
         * riêng của scene bị đẩy vào giữa → video ra na ná nhau.
         *
         * Tính liên tục thật ra do ref_history / keyframe lo, prompt chỉ cần nhắc.
         */
        const continuityRule = chainingIntoScene
          ? 'Continues from the previous shot, no hard cut.'
          : isFirst
            ? ''
            : useExtend
              ? 'Same continuous shot, no cut.'
              : useKeyframe
                ? 'Continues from the given first frame, no hard cut.'
                : 'Next beat of the same scene.';
        const chunkPrompt = continuityRule ? `${prompt} ${continuityRule}` : prompt;

        const key = promptKey({
          kind: 'video',
          family: ctx.family,
          model: ctx.model,
          prompt: chunkPrompt,
          duration: chunkDur,
          aspect: ctx.aspectRatio,
          resolution: ctx.resolution,
          mode: ctx.mode,
          extend: useExtend ? '1' : '0',
          keyframe: useKeyframe ? '1' : '0',
          ref: useExtend || useKeyframe ? refHistory : '',
        });

        const chunkBase = c / plan.chunks.length;
        onProgress?.({
          state: 'generating',
          attempt,
          chunkIndex: c,
          chunkTotal: plan.chunks.length,
          detailPercent: 0,
          local01: chunkBase,
        });

        const { uuid, reused, estimatedCredit } = await resolveMediaJobUuid({
          apiKey: ctx.apiKey,
          kind: 'video',
          prompt: chunkPrompt,
          key,
          segmentDir,
          chunkIndex: c,
          shouldAbort: ctx.shouldAbort,
          expect: {
            modelId: ctx.model,
            resolution: ctx.resolution,
            aspectRatio: ctx.aspectRatio,
            duration: chunkDur,
            withReference: useExtend || useKeyframe ? undefined : false,
          },
          create: async () => {
            if (useExtend && refHistory) {
              try {
                const job = await extendVideo({
                  apiKey: ctx.apiKey,
                  family: ctx.family as VideoFamily,
                  prompt: chunkPrompt,
                  refHistory,
                  duration: chunkDur,
                  resolution: ctx.resolution,
                  mode: ctx.mode,
                });
                return job;
              } catch (extendErr) {
                const msg = extendErr instanceof Error ? extendErr.message : String(extendErr);
                if (
                  !/not found|RECORD_NOT_FOUND|404|invalid|expired/i.test(msg) &&
                  !chainingIntoScene
                ) {
                  throw extendErr;
                }
              }
            }
            // Extend không dùng được (không hỗ trợ / vừa fail) → lấy frame cuối clip trước
            // làm keyframe. Thiếu last_frame_url thì vẫn gen, chỉ mất liền mạch.
            const keyframeUrl = refHistory
              ? await getLastFrameUrl(ctx.apiKey, refHistory)
              : null;
            return generateVideo({
              apiKey: ctx.apiKey,
              family: ctx.family as VideoFamily,
              model: ctx.model,
              prompt: useExtend && chainingIntoScene ? prompt : chunkPrompt,
              duration: chunkDur,
              aspectRatio: ctx.aspectRatio,
              resolution: ctx.resolution,
              mode: ctx.mode,
              refImageUrls: keyframeUrl ? [keyframeUrl] : undefined,
            });
          },
        });
        creditSpent += estimatedCredit ?? 0;

        if (reused) {
          onProgress?.({
            state: 'polling',
            attempt,
            chunkIndex: c,
            chunkTotal: plan.chunks.length,
            detailPercent: 5,
            local01: chunkBase + 0.05 / plan.chunks.length,
            error: 'Tái sử dụng job Snapgen đã có — đang tải…',
          });
        }

        onProgress?.({
          state: 'polling',
          attempt,
          chunkIndex: c,
          chunkTotal: plan.chunks.length,
          detailPercent: 0,
          local01: chunkBase,
        });

        let hist: SnapgenHistory;
        try {
          hist = await waitForMedia(
            ctx.apiKey,
            uuid,
            'video',
            (pct) => {
              const shot = normalizeSnapgenPercent(pct);
              const withinScene = (c + shot / 100) / plan.chunks.length;
              onProgress?.({
                state: 'polling',
                attempt,
                chunkIndex: c,
                chunkTotal: plan.chunks.length,
                detailPercent: shot,
                local01: withinScene,
              });
            },
            30 * 60 * 1000,
            ctx.shouldAbort
          );
        } catch (waitErr) {
          // Job lỗi / UUID chết → xóa checkpoint để lần retry được create mới (không loop UUID hỏng).
          const msg = waitErr instanceof Error ? waitErr.message : String(waitErr);
          if (/status === 3|thất bại|failed|RECORD_NOT_FOUND|404|không lấy được lịch sử/i.test(msg)) {
            clearChunkJob(segmentDir, c);
          }
          throw waitErr;
        }

        const url = hist.generated_video?.[0]?.video_url;
        if (!url) {
          // Có thể list nói completed nhưng detail chưa có URL — thử getHistory lại 1 lần.
          const again = await getHistory(ctx.apiKey, uuid);
          const url2 = again.generated_video?.[0]?.video_url;
          if (!url2) throw new Error(`Thiếu video_url cho ${label} đoạn ${c + 1}`);
          const segPath = path.join(segmentDir, `part-${c + 1}.mp4`);
          await downloadWithRetries(url2, segPath, `${label} phần ${c + 1}`, ctx.shouldAbort);
          segmentPaths.push(segPath);
          refHistory = again.uuid || uuid;
          continue;
        }

        const segPath = path.join(segmentDir, `part-${c + 1}.mp4`);
        await downloadWithRetries(url, segPath, `${label} phần ${c + 1}`, ctx.shouldAbort);
        segmentPaths.push(segPath);
        refHistory = hist.uuid || uuid;
      }

      const clipPath = sceneMediaTarget(ctx.clipsDir, scene.id, 'mp4');
      if (segmentPaths.length === 1) {
        fs.copyFileSync(segmentPaths[0], clipPath);
      } else {
        onProgress?.({
          state: 'generating',
          attempt,
          chunkIndex: plan.chunks.length - 1,
          chunkTotal: plan.chunks.length,
          detailPercent: 92,
          local01: 0.92,
        });
        await concatClipFiles(segmentPaths, clipPath, path.join(segmentDir, 'merge'));
      }
      onProgress?.({
        state: 'completed',
        attempt,
        detailPercent: 100,
        local01: 1,
        chunkIndex: plan.chunks.length - 1,
        chunkTotal: plan.chunks.length,
      });
      return {
        mediaPath: clipPath,
        historyUuid: refHistory || undefined,
        estimatedCredit: creditSpent || undefined,
      };
      } catch (err) {
        // Bị chặn nội dung → nâng mức làm sạch prompt rồi cho phép retry.
        if (isSafetyBlockedError(err) && safetyLevel < MAX_PROMPT_SAFETY_LEVEL) {
          safetyLevel += 1;
          justEscalated = true;
        } else {
          justEscalated = false;
        }
        throw err;
      }
    },
    {
      maxAttempts,
      shouldAbort: ctx.shouldAbort,
      // Lỗi mạng/tạm thời retry như cũ; lỗi bị chặn chỉ retry khi prompt ĐÃ đổi.
      isRetryable: (err) => isRetryableMediaError(err) || justEscalated,
      onRetry: (attempt, err, delayMs) => {
        const msg = err instanceof Error ? err.message : String(err);
        onProgress?.({
          state: 'retrying',
          attempt,
          error: justEscalated
            ? `${msg} — tự viết lại prompt an toàn hơn (mức ${safetyLevel}/${MAX_PROMPT_SAFETY_LEVEL}) rồi thử lại sau ${Math.round(delayMs / 1000)}s`
            : `${msg} — thử lại sau ${Math.round(delayMs / 1000)}s (ưu tiên tải job đã có)`,
          detailPercent: 0,
          local01: 0,
        });
      },
    }
  );
}
