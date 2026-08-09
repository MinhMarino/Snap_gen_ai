import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ffmpeg from 'fluent-ffmpeg';
import { removeGeminiWatermarkFromFile } from './gemini-watermark';

const require = createRequire(import.meta.url);

// Packaged builds run from inside app.asar, where binaries are not executable.
function unpacked(binPath: string): string {
  return binPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function resolveFfmpegPath(): string {
  try {
    const p = require('ffmpeg-static') as string | null;
    if (p) {
      const resolved = unpacked(p);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    /* use PATH */
  }
  return 'ffmpeg';
}

function resolveFfprobePath(): string {
  try {
    const mod = require('ffprobe-static') as { path?: string } | string | null;
    const p = typeof mod === 'string' ? mod : mod?.path;
    if (p) {
      const resolved = unpacked(p);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    /* use PATH */
  }
  return 'ffprobe';
}

ffmpeg.setFfmpegPath(resolveFfmpegPath());
ffmpeg.setFfprobePath(resolveFfprobePath());

const DEFAULT_FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Stage / progress reporting (mục 9)
// ---------------------------------------------------------------------------

export type MergeStage =
  | 'VALIDATING'
  | 'NORMALIZING'
  | 'CONCATENATING'
  | 'MIXING_AUDIO'
  | 'FINALIZING'
  | 'COMPLETED';

export interface StageEvent {
  stage: MergeStage;
  message?: string;
  /** 0-100, optional — only set when we can estimate it (e.g. per-scene normalize). */
  progress?: number;
  reencoding?: boolean;
  reason?: string;
  encoder?: string;
}

export type StageReporter = (event: StageEvent) => void;

function report(reporter: StageReporter | undefined, event: StageEvent): void {
  try {
    reporter?.(event);
  } catch {
    /* never let a logging callback break the pipeline */
  }
}

function run(
  cmd: ffmpeg.FfmpegCommand,
  options?: { timeoutMs?: number; label?: string }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  const label = options?.label || 'ffmpeg';
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    timer = setTimeout(() => {
      try {
        // fluent-ffmpeg exposes kill on the command instance.
        (cmd as unknown as { kill?: (sig?: string) => void }).kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(
        new Error(
          `${label} quá ${Math.round(timeoutMs / 1000)}s — đã dừng để tránh treo (thường do nối nhiều đoạn Veo).`
        )
      );
    }, timeoutMs);

    cmd
      .on('stderr', (line: string) => {
        if (lines.length < 60) lines.push(line);
      })
      .on('end', () => finish())
      .on('error', (err: Error) => {
        if (settled) return;
        const hint = lines.filter((l) => /error|invalid|failed|outside|unable/i.test(l)).slice(-6);
        finish(
          hint.length ? new Error(`${err.message}\n${hint.join('\n')}`) : err
        );
      })
      .run();
  });
}

/** nano-banana / Gemini thường gắn sparkle logo góc dưới-phải. */
export function isNanoBananaModel(modelId: string): boolean {
  return /nano-banana/i.test(modelId);
}

async function probeImageSize(imagePath: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(imagePath, (err, data) => {
      if (err) {
        resolve(null);
        return;
      }
      const stream = data.streams?.find((s) => s.width && s.height);
      if (!stream?.width || !stream?.height) {
        resolve(null);
        return;
      }
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

/**
 * Xóa watermark sparkle Gemini / nano-banana góc dưới-phải.
 * Ưu tiên @pilio/gemini-watermark-remover (reverse alpha blending).
 * Fallback FFmpeg delogo với tọa độ pixel cố định nếu engine bỏ qua / lỗi.
 */
export async function stripNanoBananaWatermark(imagePath: string): Promise<void> {
  if (!fs.existsSync(imagePath)) return;

  try {
    const applied = await removeGeminiWatermarkFromFile(imagePath);
    if (applied) return;
  } catch {
    // Fall through to delogo fallback.
  }

  const size = await probeImageSize(imagePath);
  if (!size) return;

  const logoW = Math.max(12, Math.floor(size.width * 0.085));
  const logoH = Math.max(12, Math.floor(size.height * 0.085));
  const x = Math.max(0, size.width - logoW - 2);
  const y = Math.max(0, size.height - logoH - 2);
  if (x + logoW > size.width || y + logoH > size.height) return;

  const ext = path.extname(imagePath) || '.png';
  const tmp = path.join(
    path.dirname(imagePath),
    `.wm-strip-${process.pid}-${Date.now()}${ext}`
  );
  try {
    await run(
      ffmpeg(imagePath)
        .inputOptions(['-loop', '1'])
        .videoFilters([`delogo=x=${x}:y=${y}:w=${logoW}:h=${logoH}:show=0`])
        .outputOptions(['-frames:v', '1', '-update', '1', '-y'])
        .output(tmp)
    );
    fs.renameSync(tmp, imagePath);
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export async function getDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(Number(data.format.duration) || 0);
    });
  });
}

// ffprobe can be missing on some setups; fall back to a caller-supplied estimate
// so a finished render is never thrown away over a duration lookup.
export async function getDurationSafe(filePath: string, fallback: number): Promise<number> {
  try {
    const duration = await getDurationSeconds(filePath);
    return duration > 0 ? duration : fallback;
  } catch {
    return fallback;
  }
}

/** Convert any ffmpeg-readable audio (wav/… ) → mp3 mono 44.1k. */
export async function convertAudioToMp3(inputPath: string, outputPath: string): Promise<string> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await run(
    ffmpeg()
      .input(inputPath)
      .outputOptions([
        '-c:a',
        'libmp3lame',
        '-q:a',
        '5',
        '-ar',
        '44100',
        '-ac',
        '1',
        '-threads',
        '0',
      ])
      .output(outputPath),
    { timeoutMs: 5 * 60 * 1000, label: 'convert-mp3' }
  );
  return outputPath;
}

async function makeSilenceMp3(outPath: string, durationSec: number): Promise<string> {
  const t = Math.max(0.04, durationSec);
  await run(
    ffmpeg()
      .input('anullsrc=r=44100:cl=mono')
      .inputOptions(['-f', 'lavfi'])
      .outputOptions(['-t', t.toFixed(3), '-c:a', 'libmp3lame', '-q:a', '4'])
      .output(outPath),
    { timeoutMs: 60_000, label: 'silence-mp3' }
  );
  return outPath;
}

/**
 * Nối nhiều file audio thành 1 mp3 (re-encode để tránh lệch codec).
 * `pauseAfterMs[i]` = im lặng chèn sau inputPaths[i] (bỏ qua phần tử cuối).
 */
export async function concatAudioFiles(
  inputPaths: string[],
  outputPath: string,
  workDir: string,
  options?: { pauseAfterMs?: number[] }
): Promise<string> {
  if (!inputPaths.length) throw new Error('No audio files to concat.');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  if (inputPaths.length === 1) {
    if (path.extname(inputPaths[0]).toLowerCase() === '.mp3') {
      fs.copyFileSync(inputPaths[0], outputPath);
      return outputPath;
    }
    return convertAudioToMp3(inputPaths[0], outputPath);
  }

  const pauseAfterMs = options?.pauseAfterMs || [];
  const sequence: string[] = [];
  for (let i = 0; i < inputPaths.length; i++) {
    sequence.push(inputPaths[i]);
    const pauseMs = i < inputPaths.length - 1 ? Math.max(0, pauseAfterMs[i] || 0) : 0;
    if (pauseMs >= 40) {
      const silencePath = path.join(workDir, `pause-${String(i).padStart(3, '0')}.mp3`);
      await makeSilenceMp3(silencePath, pauseMs / 1000);
      sequence.push(silencePath);
    }
  }

  const listFile = path.join(workDir, `audio-concat-${Date.now()}.txt`);
  fs.writeFileSync(
    listFile,
    sequence.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'),
    'utf8'
  );
  await run(
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c:a', 'libmp3lame', '-q:a', '4', '-ar', '44100', '-ac', '1'])
      .output(outputPath),
    { timeoutMs: 10 * 60 * 1000, label: 'concat-audio' }
  );
  return outputPath;
}

export type NarrationTrackItem =
  | { kind: 'slice'; start: number; end: number }
  | { kind: 'silence'; duration: number };

/**
 * Dựng narration.mp3 từ bản đọc liền mạch: giữ nguyên các lát nói,
 * chỉ chèn im lặng cho scene không có lời thoại.
 */
export async function buildNarrationTrack(options: {
  sourcePath: string;
  items: NarrationTrackItem[];
  outputPath: string;
  workDir: string;
}): Promise<string> {
  const { sourcePath, items, outputPath, workDir } = options;
  if (!items.length) throw new Error('No narration items to build.');

  fs.mkdirSync(workDir, { recursive: true });
  const parts: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const out = path.join(workDir, `narr-${i}.mp3`);

    if (item.kind === 'silence') {
      await run(
        ffmpeg()
          .input('anullsrc=r=44100:cl=mono')
          .inputOptions(['-f', 'lavfi'])
          .outputOptions([
            '-t',
            Math.max(0.1, item.duration).toFixed(3),
            '-c:a',
            'libmp3lame',
            '-q:a',
            '4',
          ])
          .output(out)
      );
    } else {
      const length = Math.max(0.05, item.end - item.start);
      await run(
        ffmpeg(sourcePath)
          .inputOptions(['-ss', item.start.toFixed(3)])
          .outputOptions([
            '-t',
            length.toFixed(3),
            '-c:a',
            'libmp3lame',
            '-q:a',
            '4',
            '-ar',
            '44100',
            '-ac',
            '1',
          ])
          .output(out)
      );
    }
    parts.push(out);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (parts.length === 1) {
    fs.copyFileSync(parts[0], outputPath);
    return outputPath;
  }

  const listFile = path.join(workDir, 'narr-concat.txt');
  fs.writeFileSync(
    listFile,
    parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'),
    'utf8'
  );
  await run(
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
  );
  return outputPath;
}

const TARGET_VIDEO = {
  width: 1920,
  height: 1080,
  fps: 60,
  codec: 'h264',
  pixFmt: 'yuv420p',
};

const TARGET_AUDIO = {
  codec: 'aac',
  sampleRate: 48000,
  channels: 2,
};

type VideoStreamInfo = {
  width?: number;
  height?: number;
  codec_name?: string;
  pix_fmt?: string;
  r_frame_rate?: string;
};

type AudioStreamInfo = {
  codec_name?: string;
  sample_rate?: number;
  channels?: number;
};

type SceneProbeInfo = {
  filePath: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixFmt: string;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  hasAudio: boolean;
};

function normalizeCodecName(value?: string): string {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseFrameRate(value?: string): number | null {
  if (!value) return null;
  const match = value.match(/(\d+)(?:\/(\d+))?/);
  if (!match) return null;
  const num = Number(match[1]);
  const den = match[2] ? Number(match[2]) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

async function probeSceneInfo(filePath: string): Promise<SceneProbeInfo | null> {
  try {
    const data = await new Promise<any>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, stats) => {
        if (err) reject(err);
        else resolve(stats);
      });
    });

    const video = data?.streams?.find((stream: VideoStreamInfo) => stream.width && stream.height) || null;
    const audio = data?.streams?.find((stream: AudioStreamInfo) => stream.codec_name) || null;
    if (!video) return null;

    const fps = parseFrameRate(video.r_frame_rate ?? data?.streams?.[0]?.r_frame_rate) ?? 0;
    return {
      filePath,
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      fps,
      codec: normalizeCodecName(video.codec_name),
      pixFmt: String(video.pix_fmt || '').toLowerCase(),
      audioCodec: normalizeCodecName(audio?.codec_name),
      audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
      audioChannels: audio?.channels ? Number(audio.channels) : undefined,
      hasAudio: Boolean(audio),
    };
  } catch {
    return null;
  }
}

function isSceneCompatible(info: SceneProbeInfo | null): boolean {
  if (!info) return false;
  if (info.width !== TARGET_VIDEO.width || info.height !== TARGET_VIDEO.height) return false;
  if (Math.abs(info.fps - TARGET_VIDEO.fps) > 0.5) return false;
  if (info.codec !== TARGET_VIDEO.codec) return false;
  if (info.pixFmt !== TARGET_VIDEO.pixFmt) return false;
  if (info.audioCodec && info.audioCodec !== TARGET_AUDIO.codec) return false;
  if (info.audioSampleRate && info.audioSampleRate !== TARGET_AUDIO.sampleRate) return false;
  if (info.audioChannels && info.audioChannels !== TARGET_AUDIO.channels) return false;
  return true;
}

/** True when the container has an audio stream already matching AAC/48k/stereo. */
function isAudioStreamAlreadyTarget(info: SceneProbeInfo | null): boolean {
  if (!info || !info.hasAudio) return false;
  return (
    info.audioCodec === TARGET_AUDIO.codec &&
    info.audioSampleRate === TARGET_AUDIO.sampleRate &&
    info.audioChannels === TARGET_AUDIO.channels
  );
}

export async function validateSceneCompatibility(
  scenePaths: string[],
  onProgress?: StageReporter
): Promise<{
  compatible: boolean;
  incompatible: string[];
  metadata: Record<string, SceneProbeInfo | null>;
}> {
  report(onProgress, { stage: 'VALIDATING', message: `Probing ${scenePaths.length} scene(s)` });

  const metadata: Record<string, SceneProbeInfo | null> = {};
  const incompatible: string[] = [];

  for (const scenePath of scenePaths) {
    const info = await probeSceneInfo(scenePath);
    metadata[scenePath] = info;
    if (!isSceneCompatible(info)) {
      incompatible.push(scenePath);
    }
  }

  return {
    compatible: incompatible.length === 0,
    incompatible,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Hardware encoder detection (mục 7) — probed once and cached for the process.
// ---------------------------------------------------------------------------

type EncoderChoice = { name: string; outputArgs: string[] };

let cachedEncoderChoice: Promise<EncoderChoice> | null = null;

function getAvailableEncoders(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    try {
      (ffmpeg as unknown as {
        getAvailableEncoders: (cb: (err: Error | null, data: Record<string, unknown>) => void) => void;
      }).getAvailableEncoders((err, data) => resolve(err ? null : data));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Chọn encoder video: ưu tiên h264_nvenc nếu máy có NVIDIA, fallback libx264.
 * Kết quả được cache lại — chỉ dò 1 lần cho cả tiến trình (mục 7).
 */
async function resolveVideoEncoder(): Promise<EncoderChoice> {
  if (!cachedEncoderChoice) {
    cachedEncoderChoice = (async () => {
      const encoders = await getAvailableEncoders();
      const hasNvenc = !!(encoders && Object.prototype.hasOwnProperty.call(encoders, 'h264_nvenc'));
      if (hasNvenc) {
        return {
          name: 'h264_nvenc',
          outputArgs: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
        };
      }
      return {
        name: 'libx264',
        outputArgs: ['-c:v', 'libx264', '-preset', 'faster', '-crf', '18'],
      };
    })();
  }
  return cachedEncoderChoice;
}

/**
 * Chỉ normalize những scene không đạt chuẩn — không probe lại (dùng metadata
 * đã có từ validateSceneCompatibility), không đụng vào scene đã compatible.
 */
export async function normalizeIncompatibleScenes(
  scenePaths: string[],
  workDir: string,
  onProgress?: StageReporter,
  precomputed?: { metadata: Record<string, SceneProbeInfo | null>; incompatible: string[] }
): Promise<string[]> {
  const { metadata, incompatible } =
    precomputed ?? (await validateSceneCompatibility(scenePaths, onProgress));

  if (!incompatible.length) {
    report(onProgress, {
      stage: 'CONCATENATING',
      message: 'Fast concat mode enabled',
      reencoding: false,
    });
    return [...scenePaths];
  }

  const encoder = await resolveVideoEncoder();
  report(onProgress, {
    stage: 'NORMALIZING',
    message: `${incompatible.length}/${scenePaths.length} scene(s) require normalization`,
    reencoding: true,
    reason: 'incompatible scene parameters',
    encoder: encoder.name,
  });

  const normalized: string[] = [];
  let done = 0;
  for (const scenePath of scenePaths) {
    const meta = metadata[scenePath] ?? null;
    if (meta && isSceneCompatible(meta)) {
      normalized.push(scenePath);
      continue;
    }

    const baseName = path.basename(scenePath, path.extname(scenePath));
    const out = path.join(workDir, 'normalized', `${baseName}-normalized.mp4`);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const filters = [
      'scale=1920:1080:force_original_aspect_ratio=decrease',
      'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black',
      'fps=60',
      'format=yuv420p',
    ];
    const audioIsCompatible = isAudioStreamAlreadyTarget(meta);

    await run(
      ffmpeg(scenePath)
        .videoFilters(filters)
        .outputOptions([
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
          ...encoder.outputArgs,
          '-pix_fmt',
          'yuv420p',
          '-r',
          '60',
          ...(audioIsCompatible ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-ar', '48000', '-ac', '2']),
          '-movflags',
          '+faststart',
        ])
        .output(out),
      { timeoutMs: 10 * 60 * 1000, label: `Normalize scene ${path.basename(scenePath)}` }
    );

    normalized.push(out);
    done += 1;
    report(onProgress, {
      stage: 'NORMALIZING',
      message: `Normalized ${done}/${incompatible.length}`,
      progress: Math.round((done / incompatible.length) * 100),
      reencoding: true,
      encoder: encoder.name,
    });
  }

  report(onProgress, {
    stage: 'CONCATENATING',
    message: 'Fast concat mode enabled after normalization',
    reencoding: false,
  });

  return normalized;
}

export function createConcatList(scenePaths: string[]): string {
  return scenePaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n');
}

export async function concatScenes(
  scenePaths: string[],
  outputPath: string,
  workDir: string
): Promise<string> {
  if (!scenePaths.length) throw new Error('No scenes to concat.');
  if (scenePaths.length === 1) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(scenePaths[0], outputPath);
    return outputPath;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const listPath = path.join(workDir, 'scene-concat.txt');
  fs.writeFileSync(listPath, createConcatList(scenePaths), 'utf8');

  await run(
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
      .output(outputPath),
    { timeoutMs: 10 * 60 * 1000, label: 'concat-scenes' }
  );

  return outputPath;
}

export async function prepareFinalAudio(options: {
  narrationPath?: string;
  backgroundMusicPath?: string;
  outputPath: string;
  workDir: string;
}): Promise<string> {
  const { narrationPath, backgroundMusicPath, outputPath, workDir } = options;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  if (!narrationPath && !backgroundMusicPath) {
    throw new Error('No narration or background music available for final audio.');
  }

  const audioInputs: string[] = [];
  const filters: string[] = [];

  if (narrationPath) {
    audioInputs.push(narrationPath);
    filters.push('[0:a]volume=1.0[a0]');
  }

  if (backgroundMusicPath) {
    audioInputs.push(backgroundMusicPath);
    filters.push('[1:a]volume=0.22[a1]');
  }

  if (audioInputs.length === 1) {
    const src = audioInputs[0];
    // Audio-only stream: if it's already AAC/48k/stereo (e.g. a prior final-audio
    // reused across a re-render), stream-copy it instead of re-encoding.
    const meta = await probeSceneInfo(src);
    if (isAudioStreamAlreadyTarget(meta)) {
      await run(
        ffmpeg().input(src).outputOptions(['-c:a', 'copy']).output(outputPath),
        { timeoutMs: 2 * 60 * 1000, label: 'final-audio-copy' }
      );
      return outputPath;
    }
    await run(
      ffmpeg()
        .input(src)
        .outputOptions(['-c:a', 'aac', '-ar', '48000', '-ac', '2'])
        .output(outputPath),
      { timeoutMs: 10 * 60 * 1000, label: 'final-audio' }
    );
    return outputPath;
  }

  const mixFilter = `[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0[outa]`;
  await run(
    ffmpeg()
      .input(audioInputs[0])
      .input(audioInputs[1])
      .complexFilter(`${filters.join(';')};${mixFilter}`)
      .outputOptions(['-map', '[outa]', '-c:a', 'aac', '-ar', '48000', '-ac', '2'])
      .output(outputPath),
    { timeoutMs: 10 * 60 * 1000, label: 'mix-audio' }
  );

  return outputPath;
}

export async function muxFinalVideo(options: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  burnSubtitles?: boolean;
  srtPath?: string;
  onProgress?: StageReporter;
}): Promise<string> {
  const { videoPath, audioPath, outputPath, burnSubtitles = false, srtPath, onProgress } = options;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (burnSubtitles && srtPath) {
    const encoder = await resolveVideoEncoder();
    report(onProgress, {
      stage: 'FINALIZING',
      message: 'Burning subtitles into video',
      reencoding: true,
      reason: 'burning subtitles',
      encoder: encoder.name,
    });

    const srtEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    await run(
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .videoFilters(`subtitles='${srtEscaped}'`)
        .audioFilters('apad')
        .outputOptions([
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          ...encoder.outputArgs,
          '-pix_fmt',
          'yuv420p',
          '-r',
          '60',
          '-c:a',
          'aac',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-shortest',
          '-movflags',
          '+faststart',
        ])
        .output(outputPath),
      { timeoutMs: 12 * 60 * 1000, label: 'final-mux-subtitles' }
    );
    report(onProgress, { stage: 'COMPLETED', message: 'Final video ready' });
    return outputPath;
  }

  report(onProgress, {
    stage: 'FINALIZING',
    message: 'Muxing audio into video',
    reencoding: false,
  });

  await run(
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-shortest',
        '-movflags',
        '+faststart',
      ])
      .output(outputPath),
    { timeoutMs: 12 * 60 * 1000, label: 'final-mux' }
  );

  report(onProgress, { stage: 'COMPLETED', message: 'Final video ready' });
  return outputPath;
}

export function cleanupTempFiles(dirPath: string): void {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Nối nhiều đoạn video thành 1 file bằng concat demuxer stream-copy.
 * Chỉ encode lại khi một scene riêng lẻ không đạt chuẩn; không re-encode toàn bộ batch.
 */
export async function concatClipFiles(
  clipPaths: string[],
  outputPath: string,
  workDir: string,
  onProgress?: StageReporter
): Promise<string> {
  if (!clipPaths.length) throw new Error('No clips to concat.');
  if (clipPaths.length === 1) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(clipPaths[0], outputPath);
    return outputPath;
  }

  const normalized = await normalizeIncompatibleScenes(clipPaths, workDir, onProgress);
  return concatScenes(normalized, outputPath, workDir);
}

export async function assembleFinalVideo(options: {
  clipPaths: string[];
  audioPath: string;
  srtPath: string;
  outputPath: string;
  burnSubtitles: boolean;
  workDir: string;
  estimatedTotalSeconds?: number;
  clipDurations?: number[];
  /** When clips are already 1280x720@30 (e.g. Ken Burns slides), skip re-encode. */
  skipClipNormalize?: boolean;
  onProgress?: StageReporter;
}): Promise<string> {
  const { clipPaths, audioPath, srtPath, outputPath, burnSubtitles, workDir, onProgress } = options;
  if (!clipPaths.length) throw new Error('No clips to assemble.');

  fs.mkdirSync(workDir, { recursive: true });

  // Probe once, reuse the same metadata for both the compatibility check and
  // the normalize pass — avoids ffprobe-ing every scene twice.
  const validation = await validateSceneCompatibility(clipPaths, onProgress);
  const normalized = await normalizeIncompatibleScenes(clipPaths, workDir, onProgress, validation);

  report(onProgress, { stage: 'CONCATENATING', message: `Concatenating ${normalized.length} clip(s)` });
  const mergedVideo = path.join(workDir, 'merged-video.mp4');
  await concatScenes(normalized, mergedVideo, workDir);

  report(onProgress, { stage: 'MIXING_AUDIO', message: 'Preparing final audio track' });
  const finalAudio = path.join(workDir, 'final-audio.m4a');
  const audioMeta = await probeSceneInfo(audioPath);
  if (isAudioStreamAlreadyTarget(audioMeta)) {
    await run(
      ffmpeg().input(audioPath).outputOptions(['-c:a', 'copy']).output(finalAudio),
      { timeoutMs: 2 * 60 * 1000, label: 'normalize-audio-copy' }
    );
  } else {
    await run(
      ffmpeg()
        .input(audioPath)
        .outputOptions(['-c:a', 'aac', '-ar', '48000', '-ac', '2'])
        .output(finalAudio),
      { timeoutMs: 10 * 60 * 1000, label: 'normalize-audio' }
    );
  }

  await muxFinalVideo({
    videoPath: mergedVideo,
    audioPath: finalAudio,
    outputPath,
    burnSubtitles,
    srtPath,
    onProgress,
  });

  const beside = outputPath.replace(/\.mp4$/i, '.srt');
  if (path.resolve(srtPath) !== path.resolve(beside)) {
    try {
      fs.copyFileSync(srtPath, beside);
    } catch {
      /* ignore */
    }
  }

  return outputPath;
}

/**
 * Ken Burns — slow zoom-in then hold.
 * Small push (~6–9%) over ~80% of the clip with smootherstep easing so
 * motion feels cinematic, not a quick linear punch. High-res source +
 * zoompan @ 60fps → 1080p → lanczos 720p reduces sub-pixel shake.
 */
function kenBurnsFilters(durationSec: number): string[] {
  const renderFps = 60;
  const outFps = 30;
  const frames = Math.max(Math.round(durationSec * renderFps), renderFps);
  const last = Math.max(frames - 1, 1);
  // Shorter clips zoom less so they don't feel rushed.
  const delta = Math.min(0.09, Math.max(0.055, durationSec * 0.011));
  // Finish the push early, then hold — avoids constant motion to the last frame.
  const moveFrames = Math.max(Math.round(last * 0.82), 1);

  // Smootherstep: t³(t(6t−15)+10) — softer accel/decel than smoothstep.
  // Commas must be escaped for filtergraph.
  const t = `min(1\\,on/${moveFrames})`;
  const zExpr =
    `1+${delta.toFixed(8)}*((${t})*(${t})*(${t})*((${t})*((${t})*6-15)+10))`;

  // Watermark strip is done separately (stripNanoBananaWatermark) — do NOT
  // put delogo in this chain: expression-based delogo often fails with
  // Windows exit 4294967274 (-22 EINVAL) and frame=0 before any output.
  return [
    // Oversample so each zoom step is a tiny fraction of a 720p pixel.
    'scale=5120:2880:force_original_aspect_ratio=increase:flags=lanczos',
    'crop=5120:2880',
    'setsar=1',
    'format=yuv420p',
    // Keep float x/y (no trunc) — trunc caused 1px “jumps” that looked shaky.
    `zoompan=z='${zExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${renderFps}`,
    'scale=1280:720:flags=lanczos',
    `fps=${outFps}`,
  ];
}

export async function assembleSlideshowFromImages(options: {
  imagePaths: string[];
  audioPath: string;
  srtPath: string;
  outputPath: string;
  burnSubtitles: boolean;
  workDir: string;
  durations?: number[];
  /** Strip nano-banana watermark on each still before Ken Burns (safe, isolated). */
  stripCornerLogo?: boolean;
  onProgress?: StageReporter;
}): Promise<string> {
  const {
    imagePaths,
    audioPath,
    srtPath,
    outputPath,
    burnSubtitles,
    workDir,
    durations,
    stripCornerLogo = false,
    onProgress,
  } = options;
  if (!imagePaths.length) throw new Error('No images to assemble.');

  fs.mkdirSync(workDir, { recursive: true });
  const estimatedTotal = durations?.reduce((sum, value) => sum + value, 0) || imagePaths.length * 5;
  const audioDur = await getDurationSafe(audioPath, estimatedTotal);
  const fallback = Math.max(audioDur / imagePaths.length, 1);

  // Ken Burns clips are always rendered from stills, so libx264 stays the
  // default here (NVENC gives little benefit on short zoompan outputs and
  // this keeps quality/behavior unchanged) — hardware encoding is reserved
  // for the heavier normalize/subtitle-burn passes above.
  const clips: string[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const imagePath = imagePaths[i];
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Thiếu ảnh scene ${i + 1}: ${imagePath}`);
    }
    if (stripCornerLogo) {
      await stripNanoBananaWatermark(imagePath);
    }
    const out = path.join(workDir, `img-clip-${i}.mp4`);
    const dur = Math.max(durations?.[i] ?? fallback, 1);
    const outFrames = Math.max(Math.round(dur * 30), 30);
    try {
      await run(
        ffmpeg(imagePath)
          .inputOptions(['-loop', '1', '-framerate', '60'])
          .videoFilters(kenBurnsFilters(dur))
          .outputOptions([
            '-frames:v',
            String(outFrames),
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '18',
            '-pix_fmt',
            'yuv420p',
            '-r',
            '30',
          ])
          .output(out)
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `FFmpeg lỗi khi tạo clip ảnh scene ${i + 1} (${path.basename(imagePath)}): ${detail}`
      );
    }
    clips.push(out);
    report(onProgress, {
      stage: 'NORMALIZING',
      message: `Ken Burns clip ${i + 1}/${imagePaths.length}`,
      progress: Math.round(((i + 1) / imagePaths.length) * 100),
    });
  }

  // Write to a temp file then rename so the UI never opens a half-written final.mp4.
  const tempOutput = path.join(workDir, `final-build-${Date.now()}.mp4`);
  await assembleFinalVideo({
    clipPaths: clips,
    audioPath,
    srtPath,
    outputPath: tempOutput,
    burnSubtitles,
    workDir,
    estimatedTotalSeconds: estimatedTotal,
    clipDurations: durations,
    skipClipNormalize: true,
    onProgress,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  } catch {
    // ignore locked file — rename may still replace on Windows
  }
  fs.renameSync(tempOutput, outputPath);

  const beside = outputPath.replace(/\.mp4$/i, '.srt');
  const tempSrt = tempOutput.replace(/\.mp4$/i, '.srt');
  if (fs.existsSync(tempSrt)) {
    try {
      if (fs.existsSync(beside)) fs.unlinkSync(beside);
      fs.renameSync(tempSrt, beside);
    } catch {
      fs.copyFileSync(tempSrt, beside);
    }
  }

  return outputPath;
}