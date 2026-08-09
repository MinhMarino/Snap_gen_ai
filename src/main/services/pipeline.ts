import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc';
import {
  assertNarrationCoversTarget,
  AUDIO_DURATION_TOLERANCE,
  estimateScriptSpokenSeconds,
  findScenesWithShortNarration,
  formatDurationLabel,
  MAX_TTS_FIT_ATTEMPTS,
  normalizeSceneDurations,
} from '../../shared/models';
import type {
  GenerateJobInput,
  GenerateJobResult,
  JobProgress,
  MediaKind,
  QwenDashScopeRegion,
  SceneJobProgress,
  ScriptDraft,
  TtsProvider,
} from '../../shared/types';
import { DEFAULT_QWEN_TTS_MODEL } from '../../shared/types';
import { getKeys, getSettings } from '../store';
import {
  getActiveJob,
  isJobPaused,
  isJobStopRequested,
  setActiveJobProgress,
  updateActiveJobMeta,
} from '../job-state';
import {
  buildIrodoriInstruct,
  resolveProjectChatModel,
  resolveProjectVoice,
} from '../../shared/voice';
import { rewriteNarrationToMatchDuration } from './openai';
import { generateOneSceneMedia } from './scene-generate';
import { runPool } from './worker-pool';
import {
  buildContinuousNarrationText,
  computeSceneTimings,
  synthesizeContinuousNarration,
  transcribeWithWords,
  type SceneTiming,
} from './openai-audio';
import { synthesizeWithElevenLabs, resolveElevenLabsLanguageCode, resolveElevenLabsModelForLanguage } from './elevenlabs-tts';
import { synthesizeContinuousNarrationWithQwen, type QwenTtsProgress } from './qwen-tts';
import {
  DEFAULT_GENMAX_MODEL_ID,
  DEFAULT_GENMAX_VOICE_ID,
  synthesizeContinuousNarrationWithGenmax,
  type GenmaxTtsProgress,
} from './genmax-tts';
import type { GenmaxBackend } from '../../shared/types';
import { resolveProjectKind } from '../../shared/types';
import { getElevenLabsSessionStatus, hasElevenLabsApiAccess } from './elevenlabs-auth';
import {
  assembleFinalVideo,
  assembleSlideshowFromImages,
  buildNarrationTrack,
  convertAudioToMp3,
  getDurationSafe,
  isNanoBananaModel,
  type NarrationTrackItem,
} from './ffmpeg';
import {
  ensureProject,
  getProject,
  getProjectDir,
  saveProjectDraft,
  updateProjectStatus,
} from './projects';
import {
  adoptSceneMedia,
  collectSceneMediaPaths,
  resolveSceneMedia,
} from './scene-media';

const DEFAULT_MAX_CONCURRENT_SCENES = 5;
const MAX_SCENE_GENERATE_ATTEMPTS = 3;

const RAW_NARRATION_FILE = 'narration-raw.mp3';
const TIMING_FILE = 'narration-timing.json';

type NarrationCache = {
  hash: string;
  audioDuration: number;
  timings: SceneTiming[];
};

type NarrationBundle = {
  audioPath: string;
  srtPath: string;
  script: ScriptDraft;
  durations: number[];
  /** Độ dài file TTS thô (trước khi đệm im lặng), giây. */
  rawAudioDuration: number;
};

function emit(progress: JobProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.jobProgress, progress);
  }
}

/** Keep overall % monotonic within one job so the bar never jumps backward. */
let lastOverallPercent = 0;

function resetJobProgress(): void {
  lastOverallPercent = 0;
}

function emitProgress(progress: JobProgress): void {
  const raw = progress.percent ?? lastOverallPercent;
  const percent = Math.min(100, Math.max(lastOverallPercent, Math.round(raw)));
  lastOverallPercent = percent;
  const next = { ...progress, percent };
  setActiveJobProgress(next);
  // Emit snapshot sau khi apply pause/stop message.
  emit(getActiveJob().progress || next);
}

/** Media generation spans 12% → 90% of the overall bar (theo số scene hoàn tất + local). */
function mediaOverallPercentFromPool(
  completedUnits: number,
  sceneTotal: number
): number {
  const n = Math.max(sceneTotal, 1);
  const units = Math.min(n, Math.max(0, completedUnits));
  return 12 + Math.round((units / n) * 78);
}

function clampConcurrentScenes(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT_SCENES;
  return Math.max(1, Math.min(12, Math.round(n)));
}

function collectSceneMedia(
  projectDir: string,
  script: ScriptDraft,
  mediaKind: MediaKind
): string[] {
  adoptSceneMedia(projectDir, script, mediaKind);
  return collectSceneMediaPaths(projectDir, script, mediaKind);
}

function narrationHash(text: string, voice: string, model: string): string {
  return createHash('sha256').update(`${voice}|${model}|${text}`).digest('hex');
}

function readNarrationCache(projectDir: string): NarrationCache | null {
  const p = path.join(projectDir, TIMING_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as NarrationCache;
    return raw?.timings?.length ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Voiceover là MỘT mạch đọc duy nhất. Whisper/ElevenLabs timestamps
 * cho biết mỗi narration_segment chiếm đoạn nào.
 * @param syncToSpeech khi true (vòng fit duration): duration = đoạn nói thật, không đệm silence.
 */
async function prepareNarration(options: {
  projectDir: string;
  workDir: string;
  script: ScriptDraft;
  apiKey: string;
  voice: string;
  ttsModel: string;
  language?: string;
  refresh: boolean;
  ttsProvider: TtsProvider;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  elevenLabsPublicOwnerId?: string;
  elevenLabsOriginalVoiceId?: string;
  elevenLabsVoiceName?: string;
  dashscopeApiKey?: string;
  runpodApiKey?: string;
  runpodEndpointId?: string;
  qwenTtsVoice?: string;
  qwenTtsModel?: string;
  qwenLanguageType?: string;
  qwenRegion?: QwenDashScopeRegion;
  qwenSpeedPreset?: string;
  qwenInstruct?: string;
  genmaxApiKey?: string;
  genmaxBackend?: GenmaxBackend;
  genmaxVoiceId?: string;
  genmaxModelId?: string;
  genmaxSpeed?: number;
  /** Khớp video theo độ dài speech thật (sau khi audio đã đạt ±3% mục tiêu). */
  syncToSpeech?: boolean;
  /** Tiến độ TTS (Irodori chunk) — map % theo bước audio-only hoặc full job. */
  onTtsProgress?: (info: QwenTtsProgress) => void;
  onGenmaxProgress?: (info: GenmaxTtsProgress) => void;
}): Promise<NarrationBundle> {
  const { projectDir, workDir, apiKey, voice, ttsModel } = options;
  const syncToSpeech = Boolean(options.syncToSpeech);
  const scenes = options.script.scenes;
  const text = buildContinuousNarrationText(scenes);
  if (!text) throw new Error('Kịch bản chưa có lời thoại (narration_segment) để tạo voiceover.');

  const languageCode = resolveElevenLabsLanguageCode(options.language);
  const resolvedElModel =
    options.ttsProvider === 'elevenlabs'
      ? resolveElevenLabsModelForLanguage(options.elevenLabsModelId, languageCode)
      : '';
  const irodoriInstruct = buildIrodoriInstruct(options.qwenSpeedPreset, options.qwenInstruct);
  const voiceKey =
    options.ttsProvider === 'elevenlabs'
      ? `elevenlabs:${options.elevenLabsVoiceId || ''}:${resolvedElModel}:${languageCode || ''}`
      : options.ttsProvider === 'qwen'
        ? `qwen:${options.qwenTtsVoice || ''}:${options.qwenLanguageType || ''}:${irodoriInstruct}`
        : options.ttsProvider === 'genmax'
          ? `genmax:${options.genmaxBackend || 'elevenlabs'}:${options.genmaxVoiceId || ''}:${options.genmaxModelId || ''}:${options.genmaxSpeed ?? 1}`
          : `openai:${voice}:${ttsModel}`;
  const hash = narrationHash(text, voiceKey, options.ttsProvider);
  const rawPath = path.join(projectDir, RAW_NARRATION_FILE);
  const audioPath = path.join(projectDir, 'narration.mp3');
  const srtPath = path.join(projectDir, 'subs.srt');

  const cache = readNarrationCache(projectDir);
  const hasRaw =
    fs.existsSync(rawPath) && fs.statSync(rawPath).size > 0;
  const hasBuilt =
    fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;
  // Khi refresh=false: ưu tiên file narration đã có — không TTS lại chỉ vì hash
  // lệch (voice setting resolve khác sau khi mở lại dự án).
  const canReuse =
    !options.refresh &&
    cache != null &&
    cache.timings.length === scenes.length &&
    (hasRaw || hasBuilt);

  let timings: SceneTiming[];
  let rawAudioDuration = 0;
  if (canReuse && cache) {
    timings = cache.timings;
    const reuseSource = hasRaw ? rawPath : audioPath;
    rawAudioDuration = cache.audioDuration || (await getDurationSafe(reuseSource, 0));
    if (!fs.existsSync(srtPath)) fs.writeFileSync(srtPath, '', 'utf8');
    if (!hasRaw && hasBuilt) {
      // Chỉ có narration.mp3 — dùng luôn, bỏ bước rebuild track.
      const durations = scenes.map((scene, index) => {
        const timing = timings[index];
        const spoken = timing?.hasSpeech ? timing.end - timing.start : 0;
        const planned = Math.max(1, scene.duration_hint);
        if (syncToSpeech) {
          return Math.max(1, Math.round((spoken > 0 ? spoken : planned) * 1000) / 1000);
        }
        return Math.max(1, Math.round(Math.max(planned, spoken > 0 ? spoken : 0) * 1000) / 1000);
      });
      return {
        audioPath,
        srtPath,
        script: {
          ...options.script,
          narration: text,
          scenes: scenes.map((scene, index) => ({
            ...scene,
            duration_hint: durations[index],
          })),
        },
        durations,
        rawAudioDuration,
      };
    }
  } else if (!options.refresh && (hasBuilt || hasRaw)) {
    // Có file narration nhưng thiếu/không khớp timing cache → giữ audio, không TTS lại.
    const source = hasBuilt ? audioPath : rawPath;
    if (!hasBuilt && hasRaw) fs.copyFileSync(rawPath, audioPath);
    if (!fs.existsSync(srtPath)) fs.writeFileSync(srtPath, '', 'utf8');
    const durations = scenes.map((scene) => Math.max(1, scene.duration_hint));
    const dur = await getDurationSafe(source, 0);
    return {
      audioPath,
      srtPath,
      script: { ...options.script, narration: text },
      durations,
      rawAudioDuration: dur,
    };
  } else if (options.ttsProvider === 'elevenlabs') {
    const synthesized = await synthesizeWithElevenLabs({
      text,
      voiceId: options.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM',
      modelId: options.elevenLabsModelId || 'eleven_multilingual_v2',
      language: options.language,
      outDir: projectDir,
      fileName: RAW_NARRATION_FILE,
      publicOwnerId: options.elevenLabsPublicOwnerId,
      originalVoiceId: options.elevenLabsOriginalVoiceId,
      voiceName: options.elevenLabsVoiceName,
    });
    if (synthesized.srtPath !== srtPath && fs.existsSync(synthesized.srtPath)) {
      fs.copyFileSync(synthesized.srtPath, srtPath);
    }
    rawAudioDuration = await getDurationSafe(synthesized.audioPath, 0);
    timings = computeSceneTimings({ scenes, words: synthesized.words, audioDuration: rawAudioDuration });
    fs.writeFileSync(
      path.join(projectDir, TIMING_FILE),
      JSON.stringify({ hash, audioDuration: rawAudioDuration, timings } satisfies NarrationCache, null, 2),
      'utf8'
    );
  } else if (options.ttsProvider === 'qwen') {
    const runpodKey = options.runpodApiKey?.trim() || options.dashscopeApiKey?.trim();
    if (!runpodKey) {
      throw new Error('Thiếu RunPod API key. Vào Settings để cấu hình Irodori TTS.');
    }
    const synthesized = await synthesizeContinuousNarrationWithQwen({
      runpodApiKey: runpodKey,
      scenes,
      voice: options.qwenTtsVoice || 'Ryan',
      model: DEFAULT_QWEN_TTS_MODEL,
      languageType: options.qwenLanguageType,
      endpointId: options.runpodEndpointId,
      instruct: irodoriInstruct || undefined,
      language: options.language,
      outDir: projectDir,
      fileName: RAW_NARRATION_FILE,
      // Bỏ Whisper — timing theo tỉ lệ ký tự, tiết kiệm 20–60s+.
      useWhisper: false,
      onProgress: options.onTtsProgress,
    });
    if (synthesized.srtPath !== srtPath && fs.existsSync(synthesized.srtPath)) {
      fs.copyFileSync(synthesized.srtPath, srtPath);
    }
    rawAudioDuration = await getDurationSafe(synthesized.audioPath, 0);
    timings = computeSceneTimings({ scenes, words: synthesized.words, audioDuration: rawAudioDuration });
    fs.writeFileSync(
      path.join(projectDir, TIMING_FILE),
      JSON.stringify({ hash, audioDuration: rawAudioDuration, timings } satisfies NarrationCache, null, 2),
      'utf8'
    );
  } else if (options.ttsProvider === 'genmax') {
    const genmaxKey = options.genmaxApiKey?.trim();
    if (!genmaxKey) {
      throw new Error('Thiếu GenMax API key. Vào Settings để cấu hình.');
    }
    const synthesized = await synthesizeContinuousNarrationWithGenmax({
      apiKey: genmaxKey,
      scenes,
      voiceId: options.genmaxVoiceId || DEFAULT_GENMAX_VOICE_ID,
      backend: options.genmaxBackend || 'elevenlabs',
      modelId: options.genmaxModelId || DEFAULT_GENMAX_MODEL_ID,
      language: options.language,
      speed: options.genmaxSpeed,
      outDir: projectDir,
      fileName: RAW_NARRATION_FILE,
      onProgress: options.onGenmaxProgress,
    });
    if (synthesized.srtPath !== srtPath && fs.existsSync(synthesized.srtPath)) {
      fs.copyFileSync(synthesized.srtPath, srtPath);
    }
    rawAudioDuration = synthesized.rawAudioDuration;
    timings = synthesized.timings;
    fs.writeFileSync(
      path.join(projectDir, TIMING_FILE),
      JSON.stringify({ hash, audioDuration: rawAudioDuration, timings } satisfies NarrationCache, null, 2),
      'utf8'
    );
  } else {
    const synthesized = await synthesizeContinuousNarration({
      apiKey,
      scenes,
      voice,
      ttsModel,
      language: options.language,
      outDir: projectDir,
      fileName: RAW_NARRATION_FILE,
    });
    rawAudioDuration = await getDurationSafe(synthesized.audioPath, 0);
    timings = computeSceneTimings({ scenes, words: synthesized.words, audioDuration: rawAudioDuration });
    fs.writeFileSync(
      path.join(projectDir, TIMING_FILE),
      JSON.stringify({ hash, audioDuration: rawAudioDuration, timings } satisfies NarrationCache, null, 2),
      'utf8'
    );
  }

  const durations = scenes.map((scene, index) => {
    const timing = timings[index];
    const spoken = timing?.hasSpeech ? timing.end - timing.start : 0;
    const planned = Math.max(1, scene.duration_hint);
    if (syncToSpeech) {
      // Audio đã đạt mục tiêu → video theo speech thật, không đệm silence dài.
      return Math.max(1, Math.round((spoken > 0 ? spoken : planned) * 1000) / 1000);
    }
    const seconds = Math.max(planned, spoken > 0 ? spoken : 0);
    return Math.max(1, Math.round(seconds * 1000) / 1000);
  });

  if (syncToSpeech) {
    fs.copyFileSync(rawPath, audioPath);
  } else {
    const items: NarrationTrackItem[] = [];
    let needsRebuild = false;
    for (let index = 0; index < timings.length; index++) {
      const timing = timings[index];
      const planned = durations[index];
      const spoken = timing.hasSpeech ? Math.max(0, timing.end - timing.start) : 0;
      if (timing.hasSpeech) {
        items.push({ kind: 'slice', start: timing.start, end: timing.end });
        const pad = planned - spoken;
        if (pad > 0.12) {
          items.push({ kind: 'silence', duration: pad });
          needsRebuild = true;
        }
      } else {
        items.push({ kind: 'silence', duration: planned });
        needsRebuild = true;
      }
    }

    const everySceneSpeaks = timings.every((t) => t.hasSpeech);
    if (everySceneSpeaks && !needsRebuild) {
      fs.copyFileSync(rawPath, audioPath);
    } else {
      await buildNarrationTrack({
        sourcePath: rawPath,
        items,
        outputPath: audioPath,
        workDir: path.join(workDir, 'narration'),
      });
    }
  }

  const script: ScriptDraft = {
    ...options.script,
    narration: text,
    scenes: scenes.map((scene, index) => ({ ...scene, duration_hint: durations[index] })),
  };

  return { audioPath, srtPath, script, durations, rawAudioDuration };
}

/**
 * GPT estimate → TTS → đo audio → lệch >3% → AI rewrite → TTS lại
 * → chỉ khi đạt mới trả bundle để render video.
 */
async function prepareNarrationFittingTarget(options: {
  projectDir: string;
  workDir: string;
  script: ScriptDraft;
  apiKey: string;
  openaiModel: string;
  voice: string;
  ttsModel: string;
  language?: string;
  ttsProvider: TtsProvider;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  elevenLabsPublicOwnerId?: string;
  elevenLabsOriginalVoiceId?: string;
  elevenLabsVoiceName?: string;
  dashscopeApiKey?: string;
  runpodApiKey?: string;
  runpodEndpointId?: string;
  qwenTtsVoice?: string;
  qwenTtsModel?: string;
  qwenLanguageType?: string;
  qwenRegion?: QwenDashScopeRegion;
  qwenSpeedPreset?: string;
  qwenInstruct?: string;
  genmaxApiKey?: string;
  genmaxBackend?: GenmaxBackend;
  genmaxVoiceId?: string;
  genmaxModelId?: string;
  genmaxSpeed?: number;
  targetDurationSec: number;
  /** Bước chỉ tạo voice: % TTS dùng thang 0–100, không nhét vào 3–12% của full job. */
  audioOnlyStep?: boolean;
}): Promise<NarrationBundle> {
  const target = Math.max(1, options.targetDurationSec);
  const audioOnly = Boolean(options.audioOnlyStep);
  let script = options.script;
  let lastRaw = 0;
  let lastErr = 1;

  const emitTtsChunkProgress = (info: QwenTtsProgress) => {
    const total = Math.max(1, info.chunksTotal);
    const done = Math.min(total, Math.max(0, info.chunksDone));
    const detailPercent = Math.round((done / total) * 100);
    // Audio-only: 8→90 theo chunk, concat 92. Full job: giữ band TTS 3→11.
    const percent =
      info.phase === 'concat'
        ? audioOnly
          ? 92
          : 11
        : audioOnly
          ? 8 + Math.round((done / total) * 82)
          : 3 + Math.round((done / total) * 8);
    emitProgress({
      phase: 'tts',
      message:
        info.phase === 'concat'
          ? `Ghép ${total} đoạn audio…`
          : `Irodori TTS: ${done}/${total} đoạn` +
            (info.concurrency > 1 ? ` · ${info.concurrency} worker` : ''),
      percent,
      detailPercent,
      chunkIndex: Math.max(0, done - 1),
      chunkTotal: total,
    });
  };

  const emitGenmaxProgress = (info: GenmaxTtsProgress) => {
    const total = Math.max(1, info.chunksTotal);
    const done = Math.min(total, Math.max(0, info.chunksDone));
    const detailPercent =
      info.phase === 'concat' ? 100 : Math.round(((done + (info.phase === 'poll' ? 0.4 : 0)) / total) * 100);
    const percent =
      info.phase === 'concat'
        ? audioOnly
          ? 92
          : 11
        : audioOnly
          ? 8 + Math.round((done / total) * 82)
          : 3 + Math.round((done / total) * 8);
    emitProgress({
      phase: 'tts',
      message: info.message || `GenMax TTS: ${done}/${total} đoạn`,
      percent,
      detailPercent: Math.min(100, detailPercent),
      chunkIndex: Math.max(0, done - (info.phase === 'download' ? 0 : 1)),
      chunkTotal: total,
    });
  };

  const ttsOpts = {
    ttsProvider: options.ttsProvider,
    elevenLabsVoiceId: options.elevenLabsVoiceId,
    elevenLabsModelId: options.elevenLabsModelId,
    elevenLabsPublicOwnerId: options.elevenLabsPublicOwnerId,
    elevenLabsOriginalVoiceId: options.elevenLabsOriginalVoiceId,
    elevenLabsVoiceName: options.elevenLabsVoiceName,
    dashscopeApiKey: options.dashscopeApiKey,
    runpodApiKey: options.runpodApiKey,
    runpodEndpointId: options.runpodEndpointId,
    qwenTtsVoice: options.qwenTtsVoice,
    qwenTtsModel: options.qwenTtsModel,
    qwenLanguageType: options.qwenLanguageType,
    qwenRegion: options.qwenRegion,
    qwenSpeedPreset: options.qwenSpeedPreset,
    qwenInstruct: options.qwenInstruct,
    genmaxApiKey: options.genmaxApiKey,
    genmaxBackend: options.genmaxBackend,
    genmaxVoiceId: options.genmaxVoiceId,
    genmaxModelId: options.genmaxModelId,
    genmaxSpeed: options.genmaxSpeed,
  };

  // Irodori/GenMax async chậm — TTS 1 lần rồi sync video theo speech.
  const maxAttempts =
    options.ttsProvider === 'qwen' || options.ttsProvider === 'genmax' ? 1 : MAX_TTS_FIT_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const est = estimateScriptSpokenSeconds(script.scenes);
    const ttsLabel =
      options.ttsProvider === 'elevenlabs'
        ? 'ElevenLabs'
        : options.ttsProvider === 'qwen'
          ? 'Irodori TTS'
          : options.ttsProvider === 'genmax'
            ? 'GenMax TTS'
            : 'OpenAI TTS';

    emitProgress({
      phase: 'tts',
      message:
        options.ttsProvider === 'qwen' || options.ttsProvider === 'genmax'
          ? `${ttsLabel} (1 lần): ~${formatDurationLabel(est)} → mục tiêu ${formatDurationLabel(target)}...`
          : `TTS lần ${attempt}/${maxAttempts} (${ttsLabel}): ước lượng ~${formatDurationLabel(est)} → mục tiêu ${formatDurationLabel(target)}...`,
      percent: audioOnly ? 5 : Math.min(10, 3 + attempt),
      detailPercent: 0,
    });

    // Giữ duration_hint mục tiêu trên script khi TTS (đừng syncToSpeech giữa vòng — cần đo raw).
    const forTts: ScriptDraft = {
      ...script,
      scenes: script.scenes.map((s) => ({ ...s })),
    };

    const bundle = await prepareNarration({
      projectDir: options.projectDir,
      workDir: options.workDir,
      script: forTts,
      apiKey: options.apiKey,
      voice: options.voice,
      ttsModel: options.ttsModel,
      language: options.language,
      refresh: true,
      ...ttsOpts,
      syncToSpeech: false,
      onTtsProgress: options.ttsProvider === 'qwen' ? emitTtsChunkProgress : undefined,
      onGenmaxProgress: options.ttsProvider === 'genmax' ? emitGenmaxProgress : undefined,
    });

    const raw = bundle.rawAudioDuration;
    lastRaw = raw;
    const relErr = Math.abs(raw - target) / target;
    lastErr = relErr;

    emitProgress({
      phase: 'tts',
      message: `Đã đo audio: ${formatDurationLabel(raw)} · mục tiêu ${formatDurationLabel(target)} · lệch ${(relErr * 100).toFixed(1)}%`,
      percent: audioOnly ? 94 : Math.min(11, 4 + attempt),
      detailPercent: 100,
    });

    const acceptNow =
      relErr <= AUDIO_DURATION_TOLERANCE ||
      options.ttsProvider === 'qwen' ||
      options.ttsProvider === 'genmax';

    if (acceptNow) {
      // Đạt mục tiêu (hoặc Irodori 1-pass) → gắn duration theo speech thật.
      const fitted = await prepareNarration({
        projectDir: options.projectDir,
        workDir: options.workDir,
        script: {
          ...script,
          // Giữ lời vừa TTS; duration_hint sẽ lấy từ speech trong syncToSpeech.
          scenes: script.scenes.map((s, i) => ({
            ...s,
            narration_segment: forTts.scenes[i]?.narration_segment ?? s.narration_segment,
          })),
        },
        apiKey: options.apiKey,
        voice: options.voice,
        ttsModel: options.ttsModel,
        language: options.language,
        refresh: false, // reuse raw vừa tạo
        ...ttsOpts,
        syncToSpeech: true,
      });
      emitProgress({
        phase: 'whisper',
        message:
          options.ttsProvider === 'qwen'
            ? `Irodori TTS xong (${formatDurationLabel(raw)}) — sync video theo speech.`
            : options.ttsProvider === 'genmax'
              ? `GenMax TTS xong (${formatDurationLabel(raw)}) — sync video theo speech.`
              : `Voiceover đạt mục tiêu (±${(AUDIO_DURATION_TOLERANCE * 100).toFixed(0)}%) sau ${attempt} lần TTS — bắt đầu render video.`,
        percent: audioOnly ? 98 : 12,
        detailPercent: 100,
      });
      return fitted;
    }

    if (attempt >= maxAttempts) break;

    emitProgress({
      phase: 'tts',
      message: `Lệch >${(AUDIO_DURATION_TOLERANCE * 100).toFixed(0)}% — AI đang rewrite narration rồi TTS lại...`,
      percent: Math.min(11, 5 + attempt),
    });

    script = await rewriteNarrationToMatchDuration({
      apiKey: options.apiKey,
      openaiModel: options.openaiModel,
      script,
      language: options.language || 'Tiếng Việt',
      targetDurationSec: target,
      actualAudioSec: raw,
    });
  }

  throw new Error(
    `Voiceover chưa khớp mục tiêu sau ${maxAttempts} lần TTS ` +
      `(audio ~${formatDurationLabel(lastRaw)}, mục tiêu ${formatDurationLabel(target)}, lệch ${(lastErr * 100).toFixed(1)}%). ` +
      `Hãy Generate script lại hoặc chỉnh brief.`
  );
}

function persistScript(projectId: string, script: ScriptDraft): void {
  const detail = getProject(projectId);
  if (!detail.draft) return;
  const totalSec = script.scenes.reduce((sum, scene) => sum + scene.duration_hint, 0);
  saveProjectDraft(projectId, {
    ...detail.draft,
    script,
    sceneCount: script.scenes.length,
    targetDurationSec: totalSec || detail.draft.targetDurationSec,
  });
}

export async function remuxProject(projectId: string): Promise<GenerateJobResult> {
  const detail = getProject(projectId);
  const draft = detail.draft;
  if (!draft?.script?.scenes.length) {
    throw new Error('Dự án chưa có kịch bản để ghép lại.');
  }

  resetJobProgress();

  const projectDir = detail.projectDir;
  const workDir = path.join(projectDir, 'work');
  const outputPath = path.join(projectDir, 'final.mp4');
  const settings = getSettings();
  const keys = getKeys();
  const mediaKind = draft.mediaKind || 'video';
  const voice = resolveProjectVoice(draft, settings);
  // Khóa giọng suốt remux — failover API key không được đổi voiceId.
  const lockedElevenLabsVoiceId = voice.elevenLabsVoiceId;

  emitProgress({ phase: 'merge', message: 'Đang ghép lại theo timeline đã chỉnh...', percent: 80 });
  updateProjectStatus(projectId, 'generating');

  try {
    let script = draft.script;
    let audioPath = path.join(projectDir, 'narration.mp3');
    let srtPath = path.join(projectDir, 'subs.srt');
    let durations = script.scenes.map((s) => Math.max(1, s.duration_hint));

    const remuxKind = resolveProjectKind(draft.projectKind ?? detail.meta.projectKind);
    if (remuxKind === 'audio-only') {
      throw new Error('Dự án chỉ audio — không ghép video. Mở file narration.mp3 trong thư mục dự án.');
    }
    const isMusicRemux = remuxKind === 'music-animation';
    const hasRawNarration =
      !isMusicRemux && fs.existsSync(path.join(projectDir, RAW_NARRATION_FILE));
    if (hasRawNarration) {
      emitProgress({
        phase: 'tts',
        message: 'Đang khớp lại voiceover liền mạch với từng scene...',
        percent: 82,
      });
      const rebuilt = await prepareNarration({
        projectDir,
        workDir,
        script,
        apiKey: keys.openaiApiKey,
        voice: voice.openaiTtsVoice,
        ttsModel: voice.openaiTtsModel,
        language: draft.language,
        refresh: false,
        ttsProvider: voice.ttsProvider,
        elevenLabsVoiceId: lockedElevenLabsVoiceId,
        elevenLabsModelId: voice.elevenLabsModelId,
        elevenLabsPublicOwnerId: voice.elevenLabsPublicOwnerId,
        elevenLabsOriginalVoiceId: voice.elevenLabsOriginalVoiceId,
        elevenLabsVoiceName: voice.elevenLabsVoiceName,
        dashscopeApiKey: keys.runpodApiKey,
        runpodApiKey: keys.runpodApiKey,
        runpodEndpointId: settings.runpodEndpointId,
        qwenTtsVoice: voice.qwenTtsVoice,
        qwenTtsModel: voice.qwenTtsModel,
        qwenLanguageType: voice.qwenLanguageType,
        qwenRegion: voice.qwenRegion,
        qwenSpeedPreset: voice.qwenSpeedPreset,
        qwenInstruct: voice.qwenInstruct,
        genmaxApiKey: keys.genmaxApiKey,
        genmaxBackend: voice.genmaxBackend,
        genmaxVoiceId: voice.genmaxVoiceId,
        genmaxModelId: voice.genmaxModelId,
        genmaxSpeed: voice.genmaxSpeed,
      });
      audioPath = rebuilt.audioPath;
      srtPath = rebuilt.srtPath;
      script = rebuilt.script;
      durations = rebuilt.durations;
      persistScript(projectId, script);
    } else if (!fs.existsSync(audioPath)) {
      throw new Error(
        isMusicRemux
          ? 'Chưa có file nhạc. Tải audio bài hát ở bước Input trước.'
          : 'Chưa có file narration. Hãy Generate trước.'
      );
    }
    if (!fs.existsSync(srtPath)) {
      fs.writeFileSync(srtPath, '', 'utf8');
    }

    const mediaPaths = collectSceneMedia(projectDir, script, mediaKind);
    if (mediaKind === 'image') {
      await assembleSlideshowFromImages({
        imagePaths: mediaPaths,
        audioPath,
        srtPath,
        outputPath,
        burnSubtitles: settings.burnSubtitles,
        workDir,
        durations,
        stripCornerLogo: isNanoBananaModel(draft.model || detail.meta.model || ''),
      });
    } else {
      await assembleFinalVideo({
        clipPaths: mediaPaths,
        audioPath,
        srtPath,
        outputPath,
        burnSubtitles: settings.burnSubtitles,
        workDir,
        estimatedTotalSeconds: durations.reduce((sum, d) => sum + d, 0),
        clipDurations: durations,
      });
    }

    updateProjectStatus(projectId, 'ready', { hasVideo: true, lastError: '' });
    emitProgress({ phase: 'done', message: 'Đã áp dụng timeline!', percent: 100 });

    return {
      projectId,
      projectName: detail.meta.name,
      projectDir,
      videoPath: outputPath,
      srtPath,
      audioPath,
      title: script.title,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failed remux must not hide a final.mp4 that is still on disk.
    const stillHasVideo = fs.existsSync(outputPath);
    updateProjectStatus(projectId, stillHasVideo ? 'ready' : 'error', {
      hasVideo: stillHasVideo,
      lastError: message,
    });
    throw err;
  }
}

export async function runGenerateJob(input: GenerateJobInput): Promise<GenerateJobResult> {
  const keys = getKeys();
  const settings = getSettings();
  const mediaKind = input.mediaKind || 'video';
  const voice = resolveProjectVoice(input, settings);
  // Khóa giọng từ lúc bắt đầu job → hết token chỉ đổi API key, không đổi giọng đến khi xong.
  const lockedElevenLabsVoiceId = voice.elevenLabsVoiceId;

  if (!keys.snapgenApiKey) throw new Error('Thiếu Snapgen API key. Vào Settings để cấu hình.');

  resetJobProgress();

  const meta = ensureProject({
    projectId: input.projectId || undefined,
    projectName: input.projectName,
    brief: input.brief,
    language: input.language,
    family: input.family,
    model: input.model,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    mode: input.mode,
    script: input.script,
    mediaKind,
    stylePrompt: input.stylePrompt,
  });
  updateActiveJobMeta({ projectId: meta.id, projectName: meta.name });

  // Ghi voice theo dự án (GenerateJobInput ưu tiên).
  {
    const detail = getProject(meta.id);
    if (detail.draft) {
      saveProjectDraft(meta.id, {
        ...detail.draft,
        ...voice,
        script: input.script,
      });
    }
  }

  const projectKind = resolveProjectKind(
    getProject(meta.id).draft?.projectKind ?? getProject(meta.id).meta.projectKind
  );
  const isMusicAnimation = projectKind === 'music-animation';
  const isAudioOnlyProject = projectKind === 'audio-only';

  if (!isMusicAnimation) {
    if (voice.ttsProvider === 'openai' && !keys.openaiApiKey) {
      throw new Error('Thiếu OpenAI API key. Vào Settings để cấu hình.');
    }
    if (voice.ttsProvider === 'qwen' && !keys.runpodApiKey?.trim()) {
      throw new Error('Thiếu RunPod API key. Vào Settings để cấu hình Irodori TTS.');
    }
    if (voice.ttsProvider === 'genmax' && !keys.genmaxApiKey?.trim()) {
      throw new Error('Thiếu GenMax API key. Vào Settings để cấu hình GenMax TTS.');
    }
    if (voice.ttsProvider === 'elevenlabs') {
      if (!hasElevenLabsApiAccess()) {
        const el = await getElevenLabsSessionStatus();
        if (!el.hasApiCredential) {
          throw new Error(
            'Chưa có API key ElevenLabs. Vào Settings → Add API Key (sk_…/xi_…). Không cần đăng nhập web.'
          );
        }
      }
    }
  }

  const projectDir = getProjectDir(meta.id);
  const clipsDir = path.join(projectDir, 'clips');
  const imagesDir = path.join(projectDir, 'images');
  const workDir = path.join(projectDir, 'work');
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, 'job-input.json'),
    JSON.stringify({ ...input, projectId: meta.id, projectName: meta.name }, null, 2),
    'utf8'
  );

  try {
    const refreshNarration = input.refreshNarration !== false;
    /** Bước Voice trong Studio: skipMerge + không gen scene → % TTS phải là 0–100. */
    const audioOnlyStep =
      isAudioOnlyProject ||
      (Boolean(input.skipMerge) &&
        refreshNarration &&
        Array.isArray(input.regenerateSceneIds) &&
        input.regenerateSceneIds.length === 0);
    const draftTarget = getProject(meta.id).draft?.targetDurationSec;
    const hintSum = input.script.scenes.reduce(
      (sum, s) => sum + Math.max(0, s.duration_hint || 0),
      0
    );
    const spokenEst = estimateScriptSpokenSeconds(input.script.scenes);
    const targetRuntimeSec = Math.max(
      1,
      Math.round(draftTarget || hintSum || spokenEst)
    );

    let audioPath: string;
    let srtPath: string;
    let script = input.script;
    let durations: number[];
    let rawAudioDuration = 0;

    if (isMusicAnimation) {
      // Music-animation: nhạc đã import → narration.mp3; không TTS.
      audioPath = path.join(projectDir, 'narration.mp3');
      srtPath = path.join(projectDir, 'subs.srt');
      if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 100) {
        throw new Error('Chưa có file nhạc. Bước 1: tải audio bài hát lên trước.');
      }
      const musicDur = await getDurationSafe(audioPath, targetRuntimeSec);
      rawAudioDuration = musicDur;
      script = {
        ...input.script,
        scenes: normalizeSceneDurations(input.script.scenes, Math.round(musicDur || targetRuntimeSec)),
      };
      durations = script.scenes.map((s) => Math.max(1, s.duration_hint));
      if (!fs.existsSync(srtPath)) {
        const body = script.scenes
          .map((s, i) => `${i + 1}\n00:00:00,000 --> 00:00:02,000\n${(s.narration_segment || '').slice(0, 80)}\n`)
          .join('\n');
        fs.writeFileSync(srtPath, body || '', 'utf8');
      }
      emitProgress({
        phase: 'tts',
        message: `Dùng nhạc gốc (${formatDurationLabel(musicDur)}) — bỏ qua TTS.`,
        percent: audioOnlyStep ? 20 : 8,
      });
      persistScript(meta.id, script);
    } else {
      // Tổng narration đủ target thì cho TTS; lệch nhẹ từng scene (do duration_hint scale) không chặn.
      if (refreshNarration) {
        assertNarrationCoversTarget(input.script.scenes, targetRuntimeSec);
        input.script = {
          ...input.script,
          scenes: normalizeSceneDurations(input.script.scenes, targetRuntimeSec),
        };
        const shortScenes = findScenesWithShortNarration(input.script.scenes);
        if (shortScenes.length) {
          emitProgress({
            phase: 'tts',
            message: `${shortScenes.length} scene hơi ngắn so với hint — tiếp tục TTS, căn timing theo giọng đọc.`,
            percent: audioOnlyStep ? 3 : 2,
          });
        }
      }

      const ttsLabel =
        voice.ttsProvider === 'elevenlabs'
          ? 'ElevenLabs'
          : voice.ttsProvider === 'qwen'
            ? 'Irodori TTS'
            : voice.ttsProvider === 'genmax'
              ? 'GenMax TTS'
              : 'OpenAI TTS';
      emitProgress({
        phase: 'tts',
        message: refreshNarration
          ? `Bắt đầu vòng TTS fit duration (${ttsLabel}): ước lượng ~${formatDurationLabel(spokenEst)} → mục tiêu ${formatDurationLabel(targetRuntimeSec)}`
          : 'Giữ voiceover hiện có — không gọi TTS lại.',
        percent: audioOnlyStep ? 4 : 3,
      });

      const narration = refreshNarration
        ? await prepareNarrationFittingTarget({
            projectDir,
            workDir,
            script: input.script,
            apiKey: keys.openaiApiKey,
            openaiModel: resolveProjectChatModel(
              getProject(meta.id).draft?.openaiChatModel,
              settings.openaiModel
            ),
            voice: voice.openaiTtsVoice,
            ttsModel: voice.openaiTtsModel,
            language: input.language,
            ttsProvider: voice.ttsProvider,
            elevenLabsVoiceId: lockedElevenLabsVoiceId,
            elevenLabsModelId: voice.elevenLabsModelId,
            elevenLabsPublicOwnerId: voice.elevenLabsPublicOwnerId,
            elevenLabsOriginalVoiceId: voice.elevenLabsOriginalVoiceId,
            elevenLabsVoiceName: voice.elevenLabsVoiceName,
            dashscopeApiKey: keys.runpodApiKey,
            runpodApiKey: keys.runpodApiKey,
            runpodEndpointId: settings.runpodEndpointId,
            qwenTtsVoice: voice.qwenTtsVoice,
            qwenTtsModel: voice.qwenTtsModel,
            qwenLanguageType: voice.qwenLanguageType,
            qwenRegion: voice.qwenRegion,
            qwenSpeedPreset: voice.qwenSpeedPreset,
            qwenInstruct: voice.qwenInstruct,
            genmaxApiKey: keys.genmaxApiKey,
            genmaxBackend: voice.genmaxBackend,
            genmaxVoiceId: voice.genmaxVoiceId,
            genmaxModelId: voice.genmaxModelId,
            genmaxSpeed: voice.genmaxSpeed,
            targetDurationSec: targetRuntimeSec,
            audioOnlyStep,
          })
        : await prepareNarration({
            projectDir,
            workDir,
            script: input.script,
            apiKey: keys.openaiApiKey,
            voice: voice.openaiTtsVoice,
            ttsModel: voice.openaiTtsModel,
            language: input.language,
            refresh: false,
            ttsProvider: voice.ttsProvider,
            elevenLabsVoiceId: lockedElevenLabsVoiceId,
            elevenLabsModelId: voice.elevenLabsModelId,
            elevenLabsPublicOwnerId: voice.elevenLabsPublicOwnerId,
            elevenLabsOriginalVoiceId: voice.elevenLabsOriginalVoiceId,
            elevenLabsVoiceName: voice.elevenLabsVoiceName,
            dashscopeApiKey: keys.runpodApiKey,
            runpodApiKey: keys.runpodApiKey,
            runpodEndpointId: settings.runpodEndpointId,
            genmaxApiKey: keys.genmaxApiKey,
            genmaxBackend: voice.genmaxBackend,
            genmaxVoiceId: voice.genmaxVoiceId,
            genmaxModelId: voice.genmaxModelId,
            genmaxSpeed: voice.genmaxSpeed,
            qwenTtsVoice: voice.qwenTtsVoice,
            qwenTtsModel: voice.qwenTtsModel,
            qwenLanguageType: voice.qwenLanguageType,
            qwenRegion: voice.qwenRegion,
            qwenSpeedPreset: voice.qwenSpeedPreset,
            qwenInstruct: voice.qwenInstruct,
          });
      audioPath = narration.audioPath;
      srtPath = narration.srtPath;
      script = narration.script;
      durations = narration.durations;
      rawAudioDuration = narration.rawAudioDuration;
      persistScript(meta.id, script);
    }

    if (isJobStopRequested()) {
      updateProjectStatus(meta.id, 'draft', { hasVideo: false, lastError: '' });
      emitProgress({
        phase: 'done',
        message: 'Đã dừng trước khi render scene.',
        percent: audioOnlyStep ? Math.max(lastOverallPercent, 4) : 12,
        control: 'stop',
      });
      return {
        projectId: meta.id,
        projectName: meta.name,
        projectDir,
        videoPath: '',
        srtPath,
        audioPath,
        title: script.title,
        stopped: true,
        scenesCompleted: 0,
        scenesTotal: script.scenes.length,
      };
    }

    // Bước Voice / dự án audio-only: xong TTS là xong — không đi media pool.
    if (audioOnlyStep) {
      updateProjectStatus(meta.id, 'ready', { hasVideo: false, lastError: '' });
      emitProgress({
        phase: 'done',
        message: isAudioOnlyProject
          ? `Đã tạo audio ${formatDurationLabel(rawAudioDuration)} (dự án chỉ voice — không gen ảnh/video).`
          : `Đã tạo voiceover ${formatDurationLabel(rawAudioDuration)} — sang bước Media khi sẵn sàng.`,
        percent: 100,
        detailPercent: 100,
      });
      return {
        projectId: meta.id,
        projectName: meta.name,
        projectDir,
        videoPath: '',
        srtPath,
        audioPath,
        title: script.title,
        scenesCompleted: 0,
        scenesTotal: script.scenes.length,
      };
    }

    emitProgress({
      phase: 'whisper',
      message: isMusicAnimation
        ? `Nhạc ${formatDurationLabel(rawAudioDuration)} — tạo ${script.scenes.length} scene Snapgen theo beat.`
        : `Voiceover ${formatDurationLabel(rawAudioDuration)} (mục tiêu ${formatDurationLabel(targetRuntimeSec)}) — ` +
          (voice.ttsProvider === 'elevenlabs'
            ? `khớp ${script.scenes.length} scene theo timestamp ElevenLabs.`
            : voice.ttsProvider === 'qwen'
              ? `khớp ${script.scenes.length} scene theo timestamp Qwen/Whisper.`
              : voice.ttsProvider === 'genmax'
                ? `khớp ${script.scenes.length} scene theo GenMax TTS.`
                : `khớp ${script.scenes.length} scene theo timestamp Whisper.`),
      percent: 12,
    });

    const scenes = script.scenes;
    const mediaPaths: string[] = new Array(scenes.length);
    // Give legacy filenames their canonical name first so the cache below hits.
    adoptSceneMedia(projectDir, script, mediaKind);
    const cachedPaths = resolveSceneMedia(projectDir, script, mediaKind);
    // undefined = gen mọi scene thiếu (legacy).
    // array (kể cả []) = CHỈ gen đúng id được chọn — không tự kéo scene thiếu khác vào
    // (tránh loop gen hàng loạt khi remux / regen 1 scene).
    const explicitSelection = Array.isArray(input.regenerateSceneIds);
    const selectedIds = explicitSelection ? new Set(input.regenerateSceneIds) : null;

    const phase = mediaKind === 'image' ? 'image' : 'video';
    const label = mediaKind === 'image' ? 'ảnh' : 'video';
    const maxConcurrent = clampConcurrentScenes(
      input.maxConcurrentScenes ?? settings.maxConcurrentScenes ?? DEFAULT_MAX_CONCURRENT_SCENES
    );

    const sceneStatuses: SceneJobProgress[] = scenes.map((scene, index) => ({
      sceneIndex: index,
      sceneId: scene.id,
      state: 'queued',
      detailPercent: 0,
    }));
    const localProgress = new Array(scenes.length).fill(0);

    const emitPoolProgress = (focusIndex?: number) => {
      const completed = sceneStatuses.filter(
        (s) => s.state === 'completed' || s.state === 'cached'
      ).length;
      const failed = sceneStatuses.filter((s) => s.state === 'failed').length;
      const active = sceneStatuses.find(
        (s) =>
          s.state === 'generating' ||
          s.state === 'polling' ||
          s.state === 'retrying'
      );
      const units =
        completed +
        localProgress.reduce((sum, v, idx) => {
          const st = sceneStatuses[idx]?.state;
          if (st === 'generating' || st === 'polling' || st === 'retrying') {
            return sum + Math.min(1, Math.max(0, v));
          }
          return sum;
        }, 0);

      const focus = focusIndex != null ? sceneStatuses[focusIndex] : active;
      emitProgress({
        phase,
        message: `Worker pool (${maxConcurrent}): ${completed}/${scenes.length} ${label} xong${
          failed ? ` · ${failed} lỗi` : ''
        }${
          focus
            ? ` · Scene ${focus.sceneIndex + 1} ${focus.state}`
            : completed >= scenes.length
              ? ''
              : ' · đang xếp hàng'
        }`,
        sceneIndex: focus?.sceneIndex,
        sceneTotal: scenes.length,
        detailPercent: focus?.detailPercent,
        chunkIndex: focus?.chunkIndex,
        chunkTotal: focus?.chunkTotal,
        percent: mediaOverallPercentFromPool(units, scenes.length),
        scenesCompleted: completed,
        scenesFailed: failed,
        maxConcurrent,
        sceneStatuses: sceneStatuses.map((s) => ({ ...s })),
      });
    };

    const workIndexes: number[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const cachedPath = cachedPaths[i];
      const selected =
        Boolean(input.forceRegenerate) ||
        (selectedIds != null && selectedIds.has(scene.id));
      if (cachedPath && !selected) {
        mediaPaths[i] = cachedPath;
        localProgress[i] = 1;
        sceneStatuses[i] = {
          ...sceneStatuses[i],
          state: 'cached',
          detailPercent: 100,
        };
        continue;
      }
      if (selected || !explicitSelection) {
        // Được chọn, hoặc chế độ legacy (không truyền regenerateSceneIds).
        workIndexes.push(i);
        continue;
      }
      // Explicit selection: scene không chọn và chưa có clip → bỏ qua, không tự gen.
      sceneStatuses[i] = {
        ...sceneStatuses[i],
        state: 'skipped',
        detailPercent: 0,
        error: 'Bỏ qua — không nằm trong danh sách gen',
      };
    }
    emitPoolProgress();

    if (workIndexes.length) {
      const settled = await runPool(
        workIndexes.map((i) => async () => {
          if (isJobStopRequested()) {
            throw new Error('SKIPPED');
          }
          const scene = scenes[i];
          sceneStatuses[i] = {
            ...sceneStatuses[i],
            state: 'generating',
            detailPercent: 0,
            error: undefined,
          };
          localProgress[i] = 0;
          emitPoolProgress(i);

          const mediaPath = await generateOneSceneMedia(
            {
              apiKey: keys.snapgenApiKey,
              mediaKind,
              family: String(input.family),
              model: input.model,
              aspectRatio: input.aspectRatio,
              resolution: input.resolution,
              mode: input.mode,
              stylePrompt: input.stylePrompt,
              language: input.language,
              imagesDir,
              clipsDir,
              workDir,
              maxAttempts: MAX_SCENE_GENERATE_ATTEMPTS,
              shouldAbort: () => isJobStopRequested(),
            },
            scene,
            i,
            (update) => {
              sceneStatuses[i] = {
                ...sceneStatuses[i],
                ...update,
              };
              if (update.local01 != null) localProgress[i] = update.local01;
              emitPoolProgress(i);
            }
          );
          mediaPaths[i] = mediaPath;
          localProgress[i] = 1;
          sceneStatuses[i] = {
            ...sceneStatuses[i],
            state: 'completed',
            detailPercent: 100,
            error: undefined,
          };
          emitPoolProgress(i);
          return mediaPath;
        }),
        {
          concurrency: Math.min(maxConcurrent, workIndexes.length),
          isPaused: () => isJobPaused(),
          shouldStop: () => isJobStopRequested(),
          onSkip: (taskIdx) => {
            const sceneIndex = workIndexes[taskIdx];
            sceneStatuses[sceneIndex] = {
              ...sceneStatuses[sceneIndex],
              state: 'skipped',
              detailPercent: 0,
              error: 'Đã dừng — bỏ scene để tiết kiệm token',
            };
            emitPoolProgress();
          },
        }
      );

      const failures: string[] = [];
      let skippedCount = 0;
      settled.forEach((result, taskIdx) => {
        const sceneIndex = workIndexes[taskIdx];
        if (result.status === 'fulfilled') return;
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        if (/SKIPPED|đã dừng bởi người dùng/i.test(reason) || isJobStopRequested()) {
          skippedCount += 1;
          sceneStatuses[sceneIndex] = {
            ...sceneStatuses[sceneIndex],
            state: 'skipped',
            error: 'Đã dừng — bỏ scene để tiết kiệm token',
            detailPercent: 0,
          };
          return;
        }
        sceneStatuses[sceneIndex] = {
          ...sceneStatuses[sceneIndex],
          state: 'failed',
          error: reason,
          detailPercent: 0,
        };
        localProgress[sceneIndex] = 0;
        failures.push(`Scene ${sceneIndex + 1}: ${reason}`);
      });
      emitPoolProgress();

      if (isJobStopRequested() || skippedCount > 0) {
        const done = sceneStatuses.filter(
          (s) => s.state === 'completed' || s.state === 'cached'
        ).length;
        // Lưu manifest partial — không merge nếu thiếu scene.
        const partialManifest = scenes.map((scene, index) => ({
          sceneId: scene.id,
          sceneIndex: index,
          prompt: scene.visual_prompt,
          duration: scene.duration_hint,
          mediaPath: mediaPaths[index] || null,
          mediaKind,
          state: sceneStatuses[index]?.state,
        }));
        fs.writeFileSync(
          path.join(projectDir, 'scene-manifest.json'),
          JSON.stringify(partialManifest, null, 2),
          'utf8'
        );

        const existingFinal = path.join(projectDir, 'final.mp4');
        const hasFinal = fs.existsSync(existingFinal);
        updateProjectStatus(meta.id, hasFinal || done > 0 ? 'ready' : 'draft', {
          hasVideo: hasFinal,
          lastError: '',
        });
        emitProgress({
          phase: 'done',
          message: `Đã dừng. Xong ${done}/${scenes.length} scene — Generate lại scene còn thiếu khi sẵn sàng.`,
          percent: Math.max(lastOverallPercent, mediaOverallPercentFromPool(done, scenes.length)),
          scenesCompleted: done,
          scenesFailed: failures.length,
          sceneTotal: scenes.length,
          sceneStatuses: sceneStatuses.map((s) => ({ ...s })),
          control: 'stop',
        });
        return {
          projectId: meta.id,
          projectName: meta.name,
          projectDir,
          videoPath: hasFinal ? existingFinal : '',
          srtPath,
          audioPath,
          title: script.title,
          stopped: true,
          scenesCompleted: done,
          scenesTotal: scenes.length,
        };
      }

      if (failures.length) {
        throw new Error(
          `${failures.length}/${workIndexes.length} scene thất bại (các scene khác vẫn chạy xong):\n` +
            failures.slice(0, 8).join('\n') +
            (failures.length > 8 ? `\n… và ${failures.length - 8} lỗi khác` : '')
        );
      }
    }

    const missingIndexes = scenes
      .map((_, index) => index)
      .filter((index) => !mediaPaths[index]);

    fs.writeFileSync(
      path.join(projectDir, 'scene-manifest.json'),
      JSON.stringify(
        scenes.map((scene, index) => ({
          sceneId: scene.id,
          sceneIndex: index,
          prompt: scene.visual_prompt,
          duration: scene.duration_hint,
          mediaPath: mediaPaths[index] || null,
          mediaKind,
          state: sceneStatuses[index]?.state,
        })),
        null,
        2
      ),
      'utf8'
    );

    if (missingIndexes.length) {
      const done = sceneStatuses.filter(
        (s) => s.state === 'completed' || s.state === 'cached'
      ).length;
      const existingFinal = path.join(projectDir, 'final.mp4');
      const hasFinal = fs.existsSync(existingFinal);
      const sample = missingIndexes
        .slice(0, 5)
        .map((index) => `scene ${index + 1}`)
        .join(', ');
      updateProjectStatus(meta.id, hasFinal || done > 0 ? 'ready' : 'draft', {
        hasVideo: hasFinal,
        lastError: '',
      });
      emitProgress({
        phase: 'done',
        message:
          `Đã xong ${done}/${scenes.length} scene. Còn thiếu ${missingIndexes.length} clip (${sample}` +
          `${missingIndexes.length > 5 ? '…' : ''}) — chọn đúng scene thiếu để Generate, không tự gen lại toàn bộ.`,
        percent: Math.max(lastOverallPercent, mediaOverallPercentFromPool(done, scenes.length)),
        scenesCompleted: done,
        sceneTotal: scenes.length,
        sceneStatuses: sceneStatuses.map((s) => ({ ...s })),
      });
      return {
        projectId: meta.id,
        projectName: meta.name,
        projectDir,
        videoPath: hasFinal ? existingFinal : '',
        srtPath,
        audioPath,
        title: script.title,
        stopped: true,
        scenesCompleted: done,
        scenesTotal: scenes.length,
      };
    }

    if (input.skipMerge) {
      const done = sceneStatuses.filter(
        (s) => s.state === 'completed' || s.state === 'cached'
      ).length;
      const existingFinal = path.join(projectDir, 'final.mp4');
      const hasFinal = fs.existsSync(existingFinal);
      updateProjectStatus(meta.id, hasFinal || done > 0 || Boolean(audioPath) ? 'ready' : 'draft', {
        hasVideo: hasFinal,
        lastError: '',
      });
      emitProgress({
        phase: 'done',
        message: refreshNarration
          ? 'Đã xong audio (bỏ qua ghép Final — dùng bước 3 khi sẵn sàng).'
          : `Đã xong ${done}/${scenes.length} scene (bỏ qua ghép Final — dùng bước 3 khi sẵn sàng).`,
        percent: Math.max(lastOverallPercent, 96),
        scenesCompleted: done,
        sceneTotal: scenes.length,
        sceneStatuses: sceneStatuses.map((s) => ({ ...s })),
      });
      return {
        projectId: meta.id,
        projectName: meta.name,
        projectDir,
        videoPath: hasFinal ? existingFinal : '',
        srtPath,
        audioPath,
        title: script.title,
        scenesCompleted: done,
        scenesTotal: scenes.length,
      };
    }

    emitProgress({
      phase: 'merge',
      message:
        mediaKind === 'image'
          ? 'Đang ghép slideshow ảnh + audio + subtitle...'
          : 'Đang ghép các cảnh (fade chuyển cảnh) + audio + subtitle...',
      percent: 92,
    });

    const outputPath = path.join(projectDir, 'final.mp4');
    if (mediaKind === 'image') {
      await assembleSlideshowFromImages({
        imagePaths: mediaPaths,
        audioPath,
        srtPath,
        outputPath,
        burnSubtitles: input.burnSubtitles ?? settings.burnSubtitles,
        workDir,
        durations,
        stripCornerLogo: isNanoBananaModel(input.model),
      });
    } else {
      await assembleFinalVideo({
        clipPaths: mediaPaths,
        audioPath,
        srtPath,
        outputPath,
        burnSubtitles: input.burnSubtitles ?? settings.burnSubtitles,
        workDir,
        estimatedTotalSeconds: durations.reduce((sum, d) => sum + d, 0),
        clipDurations: durations,
      });
    }

    updateProjectStatus(meta.id, 'ready', { hasVideo: true, lastError: '' });
    emitProgress({ phase: 'done', message: 'Hoàn tất!', percent: 100 });

    return {
      projectId: meta.id,
      projectName: meta.name,
      projectDir,
      videoPath: outputPath,
      srtPath,
      audioPath,
      title: script.title,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stillHasVideo = fs.existsSync(path.join(projectDir, 'final.mp4'));
    updateProjectStatus(meta.id, stillHasVideo ? 'ready' : 'error', {
      hasVideo: stillHasVideo,
      lastError: stillHasVideo ? '' : message,
    });
    throw err;
  }
}

export type ImportNarrationResult = {
  audioPath: string;
  script: ScriptDraft;
  alignedWithWhisper: boolean;
  durationSec: number;
};

/** Xóa narration + subtitle + timing cache trên disk (để tạo lại qua TTS API). */
export function clearProjectNarration(projectId: string): {
  projectId: string;
  removed: string[];
} {
  const detail = getProject(projectId);
  const projectDir = detail.projectDir;
  const targets = [
    RAW_NARRATION_FILE,
    'narration.mp3',
    'subs.srt',
    TIMING_FILE,
  ];
  const removed: string[] = [];
  for (const name of targets) {
    const full = path.join(projectDir, name);
    if (!fs.existsSync(full)) continue;
    try {
      fs.unlinkSync(full);
      removed.push(name);
    } catch {
      /* ignore */
    }
  }
  updateProjectStatus(projectId, detail.meta.status === 'ready' ? 'draft' : detail.meta.status, {
    lastError: '',
  });
  return { projectId, removed };
}

/**
 * Nhận file audio user tự tạo ngoài app → lưu narration-raw/narration.mp3,
 * căn timeline scene (Whisper nếu có OpenAI key, không thì chia theo tỉ lệ ký tự).
 */
export async function importExternalNarration(options: {
  projectId: string;
  sourcePath: string;
}): Promise<ImportNarrationResult> {
  const detail = getProject(options.projectId);
  const draft = detail.draft;
  const script = draft?.script;
  if (!script?.scenes.length) {
    throw new Error('Dự án chưa có kịch bản để gắn narration.');
  }

  const sourcePath = String(options.sourcePath || '').trim();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('Không tìm thấy file audio đã chọn.');
  }

  const projectDir = detail.projectDir;
  const workDir = path.join(projectDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  const rawPath = path.join(projectDir, RAW_NARRATION_FILE);
  const audioPath = path.join(projectDir, 'narration.mp3');
  const srtPath = path.join(projectDir, 'subs.srt');
  const tmpMp3 = path.join(workDir, `import-narration-${Date.now()}.mp3`);

  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.mp3') {
    fs.copyFileSync(sourcePath, tmpMp3);
  } else {
    await convertAudioToMp3(sourcePath, tmpMp3);
  }
  fs.copyFileSync(tmpMp3, rawPath);
  fs.copyFileSync(tmpMp3, audioPath);
  try {
    fs.unlinkSync(tmpMp3);
  } catch {
    /* ignore */
  }

  const text = buildContinuousNarrationText(script.scenes);
  if (!text) {
    throw new Error('Kịch bản chưa có narration_segment để căn timeline.');
  }

  const durationSec = await getDurationSafe(audioPath, 0);
  if (durationSec < 0.5) {
    throw new Error('File audio quá ngắn hoặc không đọc được thời lượng.');
  }

  const keys = getKeys();
  let words: Awaited<ReturnType<typeof transcribeWithWords>>['words'] = [];
  let alignedWithWhisper = false;

  if (keys.openaiApiKey?.trim()) {
    const transcribed = await transcribeWithWords({
      apiKey: keys.openaiApiKey.trim(),
      audioPath,
      language: draft?.language,
      outDir: projectDir,
    });
    words = transcribed.words;
    alignedWithWhisper = words.length > 0;
    if (transcribed.srtPath !== srtPath && fs.existsSync(transcribed.srtPath)) {
      fs.copyFileSync(transcribed.srtPath, srtPath);
    }
  } else if (!fs.existsSync(srtPath)) {
    fs.writeFileSync(srtPath, '', 'utf8');
  }

  const timings = computeSceneTimings({
    scenes: script.scenes,
    words,
    audioDuration: durationSec,
  });
  const durations = timings.map((timing) => {
    const spoken = timing.hasSpeech ? timing.end - timing.start : 0;
    return Math.max(1, Math.round((spoken > 0 ? spoken : 1) * 1000) / 1000);
  });

  const hash = narrationHash(text, `external:${path.basename(sourcePath)}`, 'import');
  fs.writeFileSync(
    path.join(projectDir, TIMING_FILE),
    JSON.stringify({ hash, audioDuration: durationSec, timings } satisfies NarrationCache, null, 2),
    'utf8'
  );

  const nextScript: ScriptDraft = {
    ...script,
    narration: text,
    scenes: script.scenes.map((scene, index) => ({
      ...scene,
      duration_hint: durations[index],
    })),
  };
  persistScript(options.projectId, nextScript);
  updateProjectStatus(options.projectId, 'ready', { lastError: '' });

  return {
    audioPath,
    script: nextScript,
    alignedWithWhisper,
    durationSec,
  };
}
