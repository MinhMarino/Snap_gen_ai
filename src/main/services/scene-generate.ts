import fs from 'node:fs';
import path from 'node:path';
import { buildSceneImagePrompt, planSceneChunks } from '../../shared/models';
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
  generateImage,
  generateVideo,
  getImageUrl,
  waitForMedia,
} from './snapgen';
import { withRetries } from './worker-pool';

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
  imagesDir: string;
  clipsDir: string;
  workDir: string;
  maxAttempts?: number;
  /** true → hủy poll/retry (Stop). Pause không abort scene đang chạy. */
  shouldAbort?: () => boolean;
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

function normalizeSnapgenPercent(raw?: number): number {
  if (raw == null || Number.isNaN(raw)) return 0;
  if (raw > 0 && raw <= 1) return Math.round(raw * 100);
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * Generate + poll + download MỘT scene (image hoặc video).
 * Chunk extend trong scene vẫn tuần tự (phụ thuộc refHistory).
 */
export async function generateOneSceneMedia(
  ctx: SceneGenerateContext,
  scene: SceneDraft,
  sceneIndex: number,
  onProgress?: (update: SceneProgressUpdate) => void
): Promise<string> {
  const prompt = buildSceneImagePrompt({
    visualPrompt: scene.visual_prompt,
    language: ctx.language,
    stylePrompt: ctx.stylePrompt,
  });
  const label = `Scene ${sceneIndex + 1}`;
  const maxAttempts = ctx.maxAttempts ?? 3;

  return withRetries(
    label,
    async (attempt) => {
      if (ctx.shouldAbort?.()) {
        throw new Error('Đã dừng bởi người dùng');
      }
      if (attempt > 1) {
        onProgress?.({ state: 'retrying', attempt, detailPercent: 0, local01: 0 });
      }

      if (ctx.mediaKind === 'image') {
        onProgress?.({ state: 'generating', attempt, detailPercent: 0, local01: 0 });
        const job = await generateImage({
          apiKey: ctx.apiKey,
          family: ctx.family as ImageFamily,
          model: ctx.model,
          prompt,
          aspectRatio: ctx.aspectRatio,
          resolution: ctx.resolution,
          mode: ctx.mode,
        });

        onProgress?.({ state: 'polling', attempt, detailPercent: 0, local01: 0 });
        const hist = await waitForMedia(
          ctx.apiKey,
          job.uuid,
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
        await downloadFile(url, imagePath);
        if (isNanoBananaModel(ctx.model)) {
          await stripNanoBananaWatermark(imagePath);
        }
        onProgress?.({ state: 'completed', attempt, detailPercent: 100, local01: 1 });
        return imagePath;
      }

      // Video: hard cut giữa scenes; extend chỉ trong scene dài.
      const desired = Math.max(1, scene.duration_hint);
      const plan = planSceneChunks(ctx.model, String(ctx.family), desired);
      const segmentDir = path.join(ctx.workDir, `scene-${safeSceneKey(scene.id)}`);
      fs.mkdirSync(segmentDir, { recursive: true });
      const segmentPaths: string[] = [];
      let refHistory: string | null = null;

      for (let c = 0; c < plan.chunks.length; c++) {
        if (ctx.shouldAbort?.()) {
          throw new Error('Đã dừng bởi người dùng');
        }
        const chunkDur = plan.chunks[c];
        const isFirst = c === 0;
        const chunkPrompt = isFirst
          ? prompt
          : plan.mode === 'extend'
            ? `Continue the same shot seamlessly, no cut, natural motion continuation. ${prompt}`
            : `New beat of the same scene, hard cut ok, keep visual continuity. ${prompt}`;

        const chunkBase = c / plan.chunks.length;
        onProgress?.({
          state: 'generating',
          attempt,
          chunkIndex: c,
          chunkTotal: plan.chunks.length,
          detailPercent: 0,
          local01: chunkBase,
        });

        let histUuid: string;
        if (plan.mode === 'extend' && !isFirst && refHistory) {
          const job = await extendVideo({
            apiKey: ctx.apiKey,
            family: ctx.family as VideoFamily,
            prompt: chunkPrompt,
            refHistory,
            duration: chunkDur,
            resolution: ctx.resolution,
            mode: ctx.mode,
          });
          histUuid = job.uuid;
        } else {
          const job = await generateVideo({
            apiKey: ctx.apiKey,
            family: ctx.family as VideoFamily,
            model: ctx.model,
            prompt: chunkPrompt,
            duration: chunkDur,
            aspectRatio: ctx.aspectRatio,
            resolution: ctx.resolution,
            mode: ctx.mode,
          });
          histUuid = job.uuid;
        }

        onProgress?.({
          state: 'polling',
          attempt,
          chunkIndex: c,
          chunkTotal: plan.chunks.length,
          detailPercent: 0,
          local01: chunkBase,
        });

        const hist = await waitForMedia(
          ctx.apiKey,
          histUuid,
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

        const url = hist.generated_video?.[0]?.video_url;
        if (!url) throw new Error(`Thiếu video_url cho ${label} đoạn ${c + 1}`);
        const segPath = path.join(segmentDir, `part-${c + 1}.mp4`);
        await downloadFile(url, segPath);
        segmentPaths.push(segPath);
        refHistory = hist.uuid;
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
      return clipPath;
    },
    {
      maxAttempts,
      shouldAbort: ctx.shouldAbort,
      onRetry: (attempt, err, delayMs) => {
        const msg = err instanceof Error ? err.message : String(err);
        onProgress?.({
          state: 'retrying',
          attempt,
          error: `${msg} — thử lại sau ${Math.round(delayMs / 1000)}s`,
          detailPercent: 0,
          local01: 0,
        });
      },
    }
  );
}
