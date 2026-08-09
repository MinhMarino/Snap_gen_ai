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

/** Target final merge: 1080p @ 60fps (không render cao hơn để giữ tốc độ). */
const FINAL_WIDTH = 1920;
const FINAL_HEIGHT = 1080;
const FINAL_FPS = 60;
const FINAL_X264_PRESET = 'ultrafast';
const FINAL_CRF = '23';
/** Fade đen vào/ra mỗi scene — giữ nguyên tổng thời lượng (khớp narration). */
const SCENE_FADE_SEC = 0.28;

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

/**
 * Nối nhiều đoạn video thành 1 file.
 * Dùng filter_complex một lần (không normalize từng file rồi concat -c copy),
 * vì Veo mp4 + concat demuxer dễ treo / rất chậm trên ổ ngoài.
 */
export async function concatClipFiles(
  clipPaths: string[],
  outputPath: string,
  workDir: string
): Promise<string> {
  if (!clipPaths.length) throw new Error('No clips to concat.');
  if (clipPaths.length === 1) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(clipPaths[0], outputPath);
    return outputPath;
  }

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const n = clipPaths.length;
  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  for (let i = 0; i < n; i++) {
    filterParts.push(
      `[${i}:v]scale=${FINAL_WIDTH}:${FINAL_HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${FINAL_WIDTH}:${FINAL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,fps=${FINAL_FPS},format=yuv420p,setsar=1[v${i}]`
    );
    concatInputs.push(`[v${i}]`);
  }
  filterParts.push(`${concatInputs.join('')}concat=n=${n}:v=1:a=0[vout]`);

  const tmpOut = path.join(workDir, `concat-${Date.now()}.mp4`);
  const cmd = ffmpeg();
  for (const clip of clipPaths) {
    cmd.input(clip);
  }
  await run(
    cmd
      .complexFilter(filterParts.join(';'))
      .outputOptions([
        '-map',
        '[vout]',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        FINAL_X264_PRESET,
        '-crf',
        FINAL_CRF,
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(FINAL_FPS),
        '-movflags',
        '+faststart',
      ])
      .output(tmpOut),
    {
      timeoutMs: 8 * 60 * 1000,
      label: `Nối ${n} đoạn video`,
    }
  );

  if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size < 1024) {
    throw new Error(`Nối ${n} đoạn video thất bại — file output rỗng.`);
  }
  fs.renameSync(tmpOut, outputPath);
  return outputPath;
}

function sceneTransitionFades(durationSec: number, options?: { fadeIn?: boolean; fadeOut?: boolean }): string[] {
  const fadeIn = options?.fadeIn !== false;
  const fadeOut = options?.fadeOut !== false;
  const d = Math.max(0.05, durationSec);
  const fade = Math.min(SCENE_FADE_SEC, Math.max(0.12, d * 0.12));
  if (d < fade * 2 + 0.15) return [];
  const filters: string[] = [];
  if (fadeIn) filters.push(`fade=t=in:st=0:d=${fade.toFixed(3)}:color=black`);
  if (fadeOut) {
    filters.push(`fade=t=out:st=${(d - fade).toFixed(3)}:d=${fade.toFixed(3)}:color=black`);
  }
  return filters;
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
  /** When clips are already 1080p@60 (e.g. Ken Burns slides), skip re-scale — vẫn encode fade chuyển cảnh. */
  skipClipNormalize?: boolean;
}): Promise<string> {
  const { clipPaths, audioPath, srtPath, outputPath, burnSubtitles, workDir } = options;
  if (!clipPaths.length) throw new Error('No clips to assemble.');

  fs.mkdirSync(workDir, { recursive: true });

  // Fit mỗi clip theo duration + fade đen vào/ra (chuyển cảnh mềm, giữ tổng thời lượng).
  const normalized: string[] = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const out = path.join(workDir, `clip-${i}.mp4`);
    const fadeOpts = { fadeIn: true, fadeOut: true };

    if (options.skipClipNormalize) {
      const planned = options.clipDurations?.[i];
      const natural = await getDurationSafe(clipPaths[i], planned ?? 8);
      const targetDur = planned ?? natural;
      const filters: string[] = [];
      if (planned != null && planned > natural + 0.05) {
        filters.push(`tpad=stop_mode=clone:stop_duration=${(planned - natural).toFixed(3)}`);
      }
      filters.push(...sceneTransitionFades(targetDur, fadeOpts));
      const cmd = ffmpeg(clipPaths[i]).outputOptions([
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        FINAL_X264_PRESET,
        '-crf',
        FINAL_CRF,
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(FINAL_FPS),
      ]);
      if (filters.length) cmd.videoFilters(filters);
      if (planned) cmd.outputOptions(['-t', String(planned)]);
      await run(cmd.output(out));
      normalized.push(out);
      continue;
    }

    const natural = await getDurationSafe(clipPaths[i], options.clipDurations?.[i] ?? 8);
    const planned = options.clipDurations?.[i];
    const targetDur = planned ?? natural;
    const filters = [
      `scale=${FINAL_WIDTH}:${FINAL_HEIGHT}:force_original_aspect_ratio=decrease`,
      `pad=${FINAL_WIDTH}:${FINAL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
      `fps=${FINAL_FPS}`,
    ];
    if (planned != null && planned > natural + 0.05) {
      filters.push(`tpad=stop_mode=clone:stop_duration=${(planned - natural).toFixed(3)}`);
    }
    filters.push(...sceneTransitionFades(targetDur, fadeOpts));

    const cmd = ffmpeg(clipPaths[i]).videoFilters(filters).outputOptions([
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      FINAL_X264_PRESET,
      '-crf',
      FINAL_CRF,
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FINAL_FPS),
    ]);
    if (planned) cmd.outputOptions(['-t', String(planned)]);
    await run(cmd.output(out));
    normalized.push(out);
  }

  const listFile = path.join(workDir, 'concat.txt');
  fs.writeFileSync(
    listFile,
    normalized.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'),
    'utf8'
  );

  const silentConcat = path.join(workDir, 'video-silent.mp4');
  await run(
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(silentConcat)
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // The narration is usually shorter than the footage. `-shortest` would cut the
  // video down to the audio, dropping whole scenes, so instead pad the audio with
  // silence and clamp the output to the full video length.
  const plannedTotal =
    options.estimatedTotalSeconds ??
    options.clipDurations?.reduce((sum, value) => sum + value, 0) ??
    0;
  const videoDuration = await getDurationSafe(silentConcat, plannedTotal);
  const lengthOptions = videoDuration > 0 ? ['-t', videoDuration.toFixed(3)] : ['-shortest'];

  if (burnSubtitles) {
    const srtEscaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    await run(
      ffmpeg()
        .input(silentConcat)
        .input(audioPath)
        .videoFilters(`subtitles='${srtEscaped}'`)
        .audioFilters('apad')
        .outputOptions([
          '-c:v',
          'libx264',
          '-preset',
          FINAL_X264_PRESET,
          '-crf',
          FINAL_CRF,
          '-c:a',
          'aac',
          '-pix_fmt',
          'yuv420p',
          '-r',
          String(FINAL_FPS),
          ...lengthOptions,
        ])
        .output(outputPath)
    );
  } else {
    await run(
      ffmpeg()
        .input(silentConcat)
        .input(audioPath)
        .audioFilters('apad')
        .outputOptions(['-c:v', 'copy', '-c:a', 'aac', ...lengthOptions])
        .output(outputPath)
    );
  }

  const beside = outputPath.replace(/\.mp4$/i, '.srt');
  if (path.resolve(srtPath) !== path.resolve(beside)) {
    fs.copyFileSync(srtPath, beside);
  }

  return outputPath;
}

/**
 * Ken Burns — slow zoom-in then hold.
 * Render thẳng 1080p@60 (không oversample 5K) để bước ghép nhanh hơn.
 */
function kenBurnsFilters(durationSec: number): string[] {
  const frames = Math.max(Math.round(durationSec * FINAL_FPS), FINAL_FPS);
  const last = Math.max(frames - 1, 1);
  // Shorter clips zoom less so they don't feel rushed.
  const delta = Math.min(0.095, Math.max(0.06, durationSec * 0.012));
  // Finish the push a bit earlier (was 0.82) — zoom in nhanh hơn một chút, rồi hold.
  const moveFrames = Math.max(Math.round(last * 0.72), 1);

  // Smootherstep: t³(t(6t−15)+10) — softer accel/decel than smoothstep.
  // Commas must be escaped for filtergraph.
  const t = `min(1\\,on/${moveFrames})`;
  const zExpr =
    `1+${delta.toFixed(8)}*((${t})*(${t})*(${t})*((${t})*((${t})*6-15)+10))`;

  // Watermark strip is done separately (stripNanoBananaWatermark) — do NOT
  // put delogo in this chain: expression-based delogo often fails with
  // Windows exit 4294967274 (-22 EINVAL) and frame=0 before any output.
  return [
    `scale=${FINAL_WIDTH}:${FINAL_HEIGHT}:force_original_aspect_ratio=increase:flags=fast_bilinear`,
    `crop=${FINAL_WIDTH}:${FINAL_HEIGHT}`,
    'setsar=1',
    'format=yuv420p',
    `zoompan=z='${zExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${FINAL_WIDTH}x${FINAL_HEIGHT}:fps=${FINAL_FPS}`,
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
  } = options;
  if (!imagePaths.length) throw new Error('No images to assemble.');

  fs.mkdirSync(workDir, { recursive: true });
  const estimatedTotal = durations?.reduce((sum, value) => sum + value, 0) || imagePaths.length * 5;
  const audioDur = await getDurationSafe(audioPath, estimatedTotal);
  const fallback = Math.max(audioDur / imagePaths.length, 1);

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
    const outFrames = Math.max(Math.round(dur * FINAL_FPS), FINAL_FPS);
    try {
      await run(
        ffmpeg(imagePath)
          .inputOptions(['-loop', '1', '-framerate', String(FINAL_FPS)])
          .videoFilters(kenBurnsFilters(dur))
          .outputOptions([
            '-frames:v',
            String(outFrames),
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            FINAL_X264_PRESET,
            '-crf',
            FINAL_CRF,
            '-pix_fmt',
            'yuv420p',
            '-r',
            String(FINAL_FPS),
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
