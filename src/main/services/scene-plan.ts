/**
 * Bước 3 của dự án thường: chia phân cảnh THEO ĐỘ DÀI VOICEOVER ĐÃ CÓ.
 *
 * Trước đây scene được chia ngay lúc viết kịch bản, dựa trên ước lượng "2,5 từ/giây".
 * Giọng đọc thật luôn lệch con số đó, nên video hoặc thừa hình hoặc thiếu hình so
 * với tiếng. Ở đây thì ngược lại: audio đã nằm trên đĩa, đo được chính xác, và mọi
 * mốc cảnh cắt trên trục thời gian THẬT của bản đọc:
 *
 *  - có mốc từng từ (Whisper/ElevenLabs) → cắt đúng chỗ câu đó được đọc xong;
 *  - không có (GenMax) → cắt theo tỉ lệ ký tự trên đúng độ dài audio.
 *
 * Kết quả: tổng thời lượng các scene luôn bằng đúng độ dài audio, không đệm im lặng.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  achievableSceneDurations,
  clampTargetSceneCount,
  IDEAL_SCENE_BEAT_SEC,
  isNarrationOnlyScript,
  maxSceneBeatSec,
  MIN_SCENE_BEAT_SEC,
  narrationTextOfScript,
  planScenesFromDuration,
  resolveSceneDensity,
  SCENE_DENSITY_OPTIONS,
  snapSceneDurationToModel,
} from '../../shared/models';
import { splitNarrationSentences } from '../../shared/narration-chunks';
import { resolveProjectKind } from '../../shared/types';
import type {
  SceneDraft,
  SceneSection,
  ScenePlanProgress,
  ScenePlanResult,
  ScriptDraft,
} from '../../shared/types';
import { computeSceneTimings, type SceneTiming, type TranscriptWord } from './openai-audio';
import { getDurationSafe } from './ffmpeg';
import {
  NARRATION_FILE,
  RAW_NARRATION_FILE,
  readNarrationCache,
  readNarrationWords,
  writeNarrationCache,
} from './narration-store';
import { getProject, saveProjectDraft } from './projects';
import { salvageSceneMediaForNewScenes } from './scene-media-salvage';
import { writeVisualPromptsForScenes } from './openai';

/** Một cảnh trước khi có visual prompt: khoảng thời gian + lời đọc trong khoảng đó. */
type SceneSlot = { text: string; start: number; end: number };

/**
 * Còn trống dưới ngần này giây thì thôi, không cắt giữa câu nữa.
 * Mẩu 1s đầu câu chẳng đủ để dựng một khuôn hình, mà lại tốn nguyên một lượt gen.
 */
const MIN_MIDSENTENCE_FILL_SEC = 1.5;

/**
 * Chọn câu nào là câu CUỐI của mỗi cảnh.
 *
 * Chia đều trục thời gian thành `count` phần rồi kéo mỗi mốc về ranh giới câu gần
 * nhất — cắt giữa câu thì cảnh sau mở đầu bằng nửa câu, nghe như lỗi ghép.
 */
function chooseSentenceCuts(
  sentenceEnds: number[],
  audioDurationSec: number,
  count: number
): number[] {
  const n = sentenceEnds.length;
  const cuts: number[] = [];
  let prev = -1;

  for (let k = 1; k < count; k++) {
    const ideal = (k * audioDurationSec) / count;
    // Chừa đủ câu cho những cảnh còn lại, không thì cảnh cuối rỗng lời.
    const maxIndex = n - 1 - (count - k);
    let best = -1;
    let bestDelta = Infinity;
    for (let j = prev + 1; j <= maxIndex; j++) {
      const delta = Math.abs(sentenceEnds[j] - ideal);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = j;
      }
      if (sentenceEnds[j] >= ideal) break; // đã qua điểm lý tưởng, xa dần
    }
    if (best < 0) break;
    cuts.push(best);
    prev = best;
  }

  return cuts;
}

/** Gộp cảnh ngắn hơn sàn vào hàng xóm ngắn hơn — giữ trục liền mạch. */
function mergeShortSlots(slots: SceneSlot[]): SceneSlot[] {
  const out = slots.map((s) => ({ ...s }));
  while (out.length > 1) {
    let shortest = -1;
    let shortestSec = Infinity;
    for (let i = 0; i < out.length; i++) {
      const sec = out[i].end - out[i].start;
      if (sec < MIN_SCENE_BEAT_SEC && sec < shortestSec) {
        shortestSec = sec;
        shortest = i;
      }
    }
    if (shortest < 0) break;

    const prev = shortest > 0 ? out[shortest - 1] : null;
    const next = shortest < out.length - 1 ? out[shortest + 1] : null;
    const mergeWithPrev =
      prev != null &&
      (next == null || prev.end - prev.start <= next.end - next.start);

    if (mergeWithPrev && prev) {
      prev.text = `${prev.text} ${out[shortest].text}`.trim();
      prev.end = out[shortest].end;
    } else if (next) {
      next.text = `${out[shortest].text} ${next.text}`.trim();
      next.start = out[shortest].start;
    } else {
      break;
    }
    out.splice(shortest, 1);
  }
  return out;
}

/**
 * Xếp lời đọc thành cảnh ĐẦY TRẦN — cách chia cho model video.
 *
 * Trần là một lần gen (Veo 8s) nên số cảnh coi như đã bị định đoạt bởi độ dài lời
 * đọc; việc còn lại là làm sao ÍT cảnh nhất mà vẫn không cảnh nào vượt trần. Vì
 * model tính tiền MỖI CLIP chứ không theo giây, một cảnh 4s tốn đúng bằng một cảnh
 * 8s: cứ để cảnh rơi xuống 4–6s là tự thêm lượt gen phải trả tiền.
 *
 * Nên ở đây gom câu cho tới sát trần rồi mới sang cảnh mới, câu cuối không vừa thì
 * cắt giữa câu cho khít (theo mốc từ nếu có). Cách cũ — chia đều theo số cảnh rồi
 * vá chỗ quá dài — bám ranh giới câu đẹp hơn nhưng đo trên dự án thật (521s lời,
 * câu trung bình 5,1s) ra 86 cảnh so với 68 cảnh ở đây, tức đắt hơn 26%.
 */
function packSentencesIntoSlots(options: {
  sentences: string[];
  sentenceEnds: number[];
  words: TranscriptWord[];
  maxSec: number;
  audioDurationSec: number;
}): SceneSlot[] {
  const max = options.maxSec;
  const sentenceStart = (i: number) => (i === 0 ? 0 : options.sentenceEnds[i - 1]);

  // Đơn vị nhỏ nhất xếp được: từng câu; câu nào một mình đã dài hơn trần thì chẻ tiếp.
  const units: SceneSlot[] = [];
  for (let i = 0; i < options.sentences.length; i++) {
    const start = sentenceStart(i);
    const end = i === options.sentences.length - 1 ? options.audioDurationSec : options.sentenceEnds[i];
    if (end - start <= 0.05) continue;
    const unit = { text: options.sentences[i], start, end };
    if (end - start > max + 0.25) {
      units.push(...splitLongUnit(unit, max, options.words));
    } else {
      units.push(unit);
    }
  }
  if (!units.length) return [];

  const out: SceneSlot[] = [];
  let current: SceneSlot | null = null;
  for (let u = 0; u < units.length; u++) {
    // Câu cuối không còn câu nào theo sau để gộp cùng, nên đuôi cắt ra phải tự đứng
    // thành một cảnh: chỉ cắt khi đuôi đủ dài cho một clip thật.
    const isLastUnit = u === units.length - 1;
    let rest: SceneSlot | null = units[u];
    while (rest) {
      if (!current) {
        current = { ...rest };
        rest = null;
        break;
      }
      const room = max + 0.25 - (current.end - current.start);
      if (rest.end - rest.start <= room) {
        current.text = `${current.text} ${rest.text}`.trim();
        current.end = rest.end;
        rest = null;
        break;
      }
      // Còn chỗ đáng kể → cắt câu, nhét phần đầu cho vừa. Chỗ thừa quá ít thì đóng
      // cảnh luôn, cắt ra một mẩu 1s chẳng dựng được khuôn hình nào.
      if (room >= MIN_MIDSENTENCE_FILL_SEC) {
        const [head, tail] = splitUnitAt(rest, room, options.words);
        const tailUsable =
          !isLastUnit || (tail != null && tail.end - tail.start >= MIN_SCENE_BEAT_SEC);
        if (head && tail && tailUsable) {
          current.text = `${current.text} ${head.text}`.trim();
          current.end = head.end;
          out.push(current);
          current = null;
          rest = tail;
          continue;
        }
      }
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);

  return out;
}

/**
 * Cắt một câu làm đôi ở khoảng giây thứ `seconds`.
 *
 * Có mốc từ (Whisper/ElevenLabs) thì cắt đúng chỗ một từ vừa đọc xong TRƯỚC điểm
 * đó — không bao giờ tràn quá chỗ trống còn lại. Không có mốc thì cắt theo tỉ lệ
 * chữ, sai vài phần mười giây, đủ dùng cho việc chọn hình.
 */
function splitUnitAt(
  unit: SceneSlot,
  seconds: number,
  words: TranscriptWord[]
): [SceneSlot, SceneSlot] | [null, null] {
  const span = unit.end - unit.start;
  if (!(span > 0.8)) return [null, null];
  const at = Math.min(Math.max(seconds, 0.3), span - 0.3);

  // Tiếng có khoảng trắng cắt theo từ; CJK không có khoảng trắng thì cắt theo ký tự.
  const tokens = unit.text.split(/\s+/).filter(Boolean);
  const chunks = tokens.length >= 2 ? tokens : [...unit.text.trim()];
  if (chunks.length < 2) return [null, null];
  const joiner = chunks === tokens ? ' ' : '';

  const inside = words.filter((w) => w.start >= unit.start - 0.05 && w.end <= unit.end + 0.05);
  const aligned = inside.length === chunks.length ? inside : [];

  let index = Math.round((chunks.length * at) / span);
  let cut = unit.start + at;
  if (aligned.length) {
    let last = -1;
    for (let i = 0; i < aligned.length - 1; i++) {
      if (aligned[i].end > unit.start + at + 0.01) break;
      last = i;
    }
    if (last >= 0) {
      index = last + 1;
      cut = aligned[last].end;
    }
  }
  index = Math.min(Math.max(index, 1), chunks.length - 1);
  cut = Math.min(Math.max(cut, unit.start + 0.3), unit.end - 0.3);

  return [
    { text: chunks.slice(0, index).join(joiner).trim(), start: unit.start, end: cut },
    { text: chunks.slice(index).join(joiner).trim(), start: cut, end: unit.end },
  ];
}

/** Một câu dài hơn cả trần → chẻ liên tiếp cho tới khi mảnh nào cũng vừa. */
function splitLongUnit(unit: SceneSlot, maxSec: number, words: TranscriptWord[]): SceneSlot[] {
  const out: SceneSlot[] = [];
  let rest: SceneSlot | null = unit;
  while (rest && rest.end - rest.start > maxSec + 0.25) {
    const [head, tail] = splitUnitAt(rest, maxSec, words);
    if (!head || !tail) break;
    out.push(head);
    rest = tail;
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Cắt lời đọc thành cảnh trên trục thời gian thật của audio.
 * Trả về slot liền mạch, phủ kín [0, audioDurationSec].
 *
 * `maxSlotSec` (video): có trần một-lần-gen thì số cảnh không còn là lựa chọn nữa —
 * xếp câu cho đầy trần (`packSentencesIntoSlots`) để ít lượt gen nhất.
 * Không có trần (ảnh tĩnh): chia đúng `sceneCount` cảnh theo ranh giới câu.
 */
export function splitNarrationByAudio(options: {
  narration: string;
  words: TranscriptWord[];
  audioDurationSec: number;
  sceneCount: number;
  maxSlotSec?: number;
}): SceneSlot[] {
  const audio = Math.max(1, options.audioDurationSec);
  const sentences = splitNarrationSentences(options.narration);
  if (!sentences.length) return [{ text: options.narration.trim(), start: 0, end: audio }];

  // Mượn chính bộ căn của voiceover: mỗi CÂU là một "scene" để lấy mốc thật.
  const sentenceTimings = computeSceneTimings({
    scenes: sentences.map((text, i) => ({
      id: `sentence-${i}`,
      narration_segment: text,
      duration_hint: 0,
    })),
    words: options.words,
    audioDuration: audio,
  });

  if (options.maxSlotSec && options.maxSlotSec > 0) {
    const packed = packSentencesIntoSlots({
      sentences,
      sentenceEnds: sentenceTimings.map((t) => t.end),
      words: options.words,
      maxSec: options.maxSlotSec,
      audioDurationSec: audio,
    });
    if (packed.length) {
      packed[0].start = 0;
      packed[packed.length - 1].end = audio;
      return packed;
    }
  }

  const count = Math.max(1, Math.min(options.sceneCount, sentences.length));
  const cuts = chooseSentenceCuts(
    sentenceTimings.map((t) => t.end),
    audio,
    count
  );

  const slots: SceneSlot[] = [];
  let from = 0;
  for (const cut of [...cuts, sentences.length - 1]) {
    const to = Math.max(from, cut);
    slots.push({
      text: sentences.slice(from, to + 1).join(' ').trim(),
      start: from === 0 ? 0 : sentenceTimings[from - 1].end,
      end: to === sentences.length - 1 ? audio : sentenceTimings[to].end,
    });
    from = to + 1;
    if (from > sentences.length - 1) break;
  }

  const merged = mergeShortSlots(slots);
  // Chốt hai đầu: cảnh đầu bắt từ 0, cảnh cuối chạy hết audio.
  merged[0].start = 0;
  merged[merged.length - 1].end = audio;
  return merged;
}

/**
 * Nắn mốc cảnh về những độ dài model THỰC SỰ gen được TRONG MỘT LẦN.
 *
 * Model video chỉ nhận vài mốc rời rạc (Veo: 4/6/8s). Cảnh chia theo giọng đọc thì
 * ra số lẻ (9,05s / 11,42s), đặt hàng xong chỉ nhận 8s → đo trên một dự án 453s có
 * 56 cảnh thì footage hụt 29s, và bước ghép phải vá bằng frame đứng hình.
 *
 * Ở đây mỗi cảnh được kéo về mốc gần nhất mà model trả đúng, phần lệch dồn sang
 * cảnh kế. Mốc mới bám theo MỐC GỐC (không phải độ dài gốc) nên sai lệch giữa hình
 * và lời không cộng dồn — luôn dưới nửa bước lượng tử (~1s), đúng bằng chỗ cắt hình
 * xê dịch một chút so với ranh giới câu.
 *
 * Chỉ lấy mốc một-lần-gen (`singleShot`): mốc ghép nhiều shot (16/24/32s với Veo)
 * dùng lại đúng một visual prompt cho cả cảnh nên xem như một hình đứng lặp lại,
 * mà vẫn tốn đúng ngần ấy lượt gen — xem `maxSceneBeatSec`.
 */
export function snapSlotsToModelDurations(
  slots: SceneSlot[],
  options: { modelId: string; family: string; audioDurationSec: number }
): SceneSlot[] {
  const shortest = shortestClipSeconds(options.modelId, options.family, options.audioDurationSec);
  // Cảnh cuối hụt dưới ngần này giây thì để bước ghép vá bằng frame cuối, còn hơn
  // gen thêm nguyên một clip nữa rồi thừa cả chục giây không có tiếng.
  const tolerance = Math.max(2, shortest * 0.3);
  const out: SceneSlot[] = [];
  let cursor = 0;

  for (let i = 0; i < slots.length; i++) {
    const isLast = i === slots.length - 1;
    const target = (isLast ? options.audioDurationSec : slots[i].end) - cursor;

    // Chỗ còn lại không đủ cho một cảnh ngắn nhất model làm được → dồn lời vào cảnh
    // trước. Model tối thiểu 25s (Sora Pro) mà cứ mỗi slot thêm một cảnh thì video
    // dài gấp mấy lần lời đọc.
    if (out.length && target < shortest * 0.6) {
      const prev = out[out.length - 1];
      // Cảnh cuối phải phủ hết lời đọc → nới cảnh trước cho đủ.
      const extendedEnd = isLast
        ? prev.start +
          snapSceneDurationToModel(
            options.modelId,
            options.family,
            options.audioDurationSec - prev.start,
            { atLeast: true, tolerance, singleShot: true }
          )
        : prev.end;

      // Cảnh trước đã kịch trần một lần gen thì nới không tới nữa; gộp vào là đuôi
      // lời đọc không còn hình, bước ghép phải đứng hình bù. Chỗ đó để nguyên thành
      // cảnh riêng (clip ngắn nhất của model) còn hơn.
      if (!isLast || options.audioDurationSec - extendedEnd <= tolerance) {
        prev.text = `${prev.text} ${slots[i].text}`.trim();
        if (isLast) {
          prev.end = extendedEnd;
          cursor = prev.end;
        }
        continue;
      }
    }

    const seconds = snapSceneDurationToModel(options.modelId, options.family, target, {
      // Cảnh cuối thà dư vài giây rồi cắt còn hơn để lời đọc chạy quá phần hình.
      atLeast: isLast && options.audioDurationSec - cursor > 0.5,
      tolerance,
      singleShot: true,
    });
    out.push({ text: slots[i].text, start: cursor, end: cursor + seconds });
    cursor += seconds;
  }

  return out.length ? out : slots;
}

/** Cảnh ngắn nhất model này gen được (Veo 4s, Sora Pro 25s…). 0 = không ràng buộc. */
function shortestClipSeconds(modelId: string, family: string, audioDurationSec: number): number {
  return achievableSceneDurations(modelId, family, audioDurationSec, { singleShot: true })[0] ?? 0;
}

function sectionForIndex(index: number, total: number): SceneSection {
  if (total < 3) return 'body';
  if (index === 0) return 'introduction';
  if (index === total - 1) return 'conclusion';
  return 'body';
}

/**
 * Số cảnh mục tiêu: mật độ người dùng chọn, áp lên ĐỘ DÀI AUDIO THẬT — nhưng không
 * bao giờ thưa hơn `beatCapSec` (một lần gen của model video).
 */
function resolveSceneCount(options: {
  audioDurationSec: number;
  sceneDensity?: string;
  targetMediaCount?: number;
  mediaKind: 'video' | 'image';
  beatCapSec: number;
  override?: number;
}): { count: number; typicalBeatSec: number; requested: number } {
  const density = resolveSceneDensity(options.sceneDensity);
  const beatSec = SCENE_DENSITY_OPTIONS.find((d) => d.id === density)?.beatSec ?? null;
  const explicit =
    options.override && options.override > 0
      ? options.override
      : density === 'custom' && options.targetMediaCount
        ? options.targetMediaCount
        : undefined;

  const plan = planScenesFromDuration(options.audioDurationSec, {
    targetSceneCount: explicit,
    typicalBeatSec: beatSec ?? undefined,
    mediaKind: options.mediaKind,
    beatCapSec: options.beatCapSec,
  });
  return {
    count: clampTargetSceneCount(options.audioDurationSec, plan.sceneCountHint),
    typicalBeatSec: plan.typicalBeatSec,
    // Số cảnh mật độ đòi khi chưa có trần — để báo cho người dùng biết vì sao khác.
    requested:
      explicit ??
      Math.max(1, Math.round(options.audioDurationSec / Math.max(1, beatSec ?? IDEAL_SCENE_BEAT_SEC))),
  };
}

/**
 * Chia cảnh + viết visual prompt cho dự án đã có voiceover.
 * Ghi thẳng kết quả vào draft dự án và vào cache timing của voiceover.
 */
export async function planScenesFromNarrationAudio(options: {
  projectId: string;
  apiKey: string;
  openaiModel: string;
  /** Ép số cảnh (bỏ qua mật độ) — dùng khi người dùng muốn chia lại thưa/dày hơn. */
  sceneCount?: number;
  onProgress?: (progress: ScenePlanProgress) => void;
}): Promise<ScenePlanResult> {
  const detail = getProject(options.projectId);
  const draft = detail.draft;
  if (!draft) throw new Error('Dự án chưa có draft.');
  if (resolveProjectKind(draft.projectKind ?? detail.meta.projectKind) === 'music-animation') {
    throw new Error('Hoạt hình nhạc phân cảnh theo lời hát ở bước riêng, không dùng bước này.');
  }

  const narration = narrationTextOfScript(draft.script);
  if (!narration) throw new Error('Chưa có lời đọc. Làm bước 1 (viết lời) trước.');

  const projectDir = detail.projectDir;
  const rawPath = path.join(projectDir, RAW_NARRATION_FILE);
  const builtPath = path.join(projectDir, NARRATION_FILE);
  // Ưu tiên file TTS thô: đó là độ dài giọng đọc thật, chưa đệm im lặng.
  const audioSource = fs.existsSync(rawPath) ? rawPath : builtPath;
  if (!fs.existsSync(audioSource) || fs.statSync(audioSource).size < 100) {
    throw new Error('Chưa có voiceover để căn phân cảnh. Làm bước 2 (tạo voice) trước.');
  }

  const audioDurationSec = await getDurationSafe(audioSource, 0);
  if (audioDurationSec < 1) {
    throw new Error('Không đọc được độ dài file voiceover.');
  }

  const words = readNarrationWords(projectDir);
  const isImageProject = draft.mediaKind === 'image';
  // Trần một cảnh = một lần gen của model (Veo 8s). Cảnh dài hơn phải đặt nhiều shot
  // cho cùng một visual prompt: tốn đúng ngần ấy credit mà hình thì lặp lại.
  const beatCapSec = maxSceneBeatSec(draft.model, isImageProject ? 'image' : 'video');
  const { count: densityCount, requested: requestedCount } = resolveSceneCount({
    audioDurationSec,
    sceneDensity: draft.sceneDensity,
    targetMediaCount: draft.targetMediaCount,
    mediaKind: isImageProject ? 'image' : 'video',
    beatCapSec,
    override: options.sceneCount,
  });

  // Model có clip tối thiểu dài (Sora Pro 25s) không chia nổi ngần ấy cảnh —
  // chia dày hơn thì tổng hình dài gấp mấy lần lời đọc.
  const shortest = isImageProject
    ? 0
    : shortestClipSeconds(draft.model, String(draft.family), audioDurationSec);
  const count = shortest > 0
    ? Math.max(1, Math.min(densityCount, Math.floor(audioDurationSec / shortest)))
    : densityCount;

  options.onProgress?.({
    phase: 'split',
    done: 0,
    total: count,
    message:
      // Video xếp câu cho đầy trần nên số cảnh chốt sau khi cắt — đây là ước lượng.
      `Chia ${isImageProject ? '' : '~'}${count} cảnh trên ${Math.round(audioDurationSec)}s voiceover` +
      (words.length ? ' (theo mốc từng từ)' : ' (theo tỉ lệ ký tự)') +
      (count < densityCount ? ` — model chỉ gen được clip từ ${shortest}s` : '') +
      (!isImageProject && count > requestedCount
        ? ` — mỗi cảnh tối đa ${beatCapSec}s (một lần gen), chia nhỏ để mỗi cảnh một hình riêng`
        : '') +
      '…',
  });

  const spokenSlots = splitNarrationByAudio({
    narration,
    words,
    audioDurationSec,
    sceneCount: count,
    // Video: không cảnh nào dài hơn một lần gen — kịch bản ít câu dài vẫn phải ra
    // nhiều cảnh, mỗi cảnh một visual prompt, thay vì một prompt lặp lại 4 shot.
    maxSlotSec: isImageProject ? undefined : beatCapSec,
  });

  // Ảnh tĩnh giữ độ dài trên đĩa bao lâu cũng được; video thì phải theo mốc model gen được.
  const slots =
    isImageProject
      ? spokenSlots
      : snapSlotsToModelDurations(spokenSlots, {
          modelId: draft.model,
          family: String(draft.family),
          audioDurationSec,
        });

  const timings: SceneTiming[] = [];
  const baseScenes: SceneDraft[] = slots.map((slot, index) => {
    const id = `scene-${String(index + 1).padStart(2, '0')}`;
    const start = Math.round(slot.start * 1000) / 1000;
    const end = Math.round(slot.end * 1000) / 1000;
    // Timing là vị trí LỜI ĐỌC trên file audio nên không được vượt quá file; còn
    // duration_hint là chỗ đứng của cảnh trên video, cảnh cuối dài hơn tiếng vài giây.
    timings.push({
      sceneId: id,
      start: Math.min(start, audioDurationSec),
      end: Math.min(end, audioDurationSec),
      hasSpeech: Boolean(slot.text.trim()),
    });
    return {
      id,
      visual_prompt: '',
      narration_segment: slot.text,
      // Mốc model gen được, gần nhất với đoạn nói của cảnh → không phải vá frame đứng hình.
      duration_hint: Math.max(1, Math.round((end - start) * 1000) / 1000),
      start_sec: start,
      end_sec: end,
      section: sectionForIndex(index, slots.length),
    };
  });

  options.onProgress?.({
    phase: 'prompt',
    done: 0,
    total: baseScenes.length,
    message: `ChatGPT viết visual prompt cho ${baseScenes.length} cảnh…`,
  });

  const scenes = await writeVisualPromptsForScenes({
    apiKey: options.apiKey,
    openaiModel: options.openaiModel,
    title: draft.script?.title || detail.meta.name,
    brief: draft.brief || '',
    language: draft.narrationLanguage || draft.language,
    stylePrompt: draft.stylePrompt,
    scenePromptInstruction: draft.scenePromptInstruction,
    mediaKind: draft.mediaKind,
    scenes: baseScenes,
    onProgress: (done, total) =>
      options.onProgress?.({
        phase: 'prompt',
        done,
        total,
        message: `Đã viết prompt ${done}/${total} cảnh…`,
      }),
  });

  const script: ScriptDraft = {
    title: draft.script?.title || detail.meta.name,
    narration,
    scenes,
  };

  // Chia lại phân cảnh của dự án ĐÃ CÓ media: footage cũ nằm trên cùng trục thời
  // gian nên gán lại được cho cảnh mới — người dùng chỉ phải gen phần còn thiếu.
  const previousScenes = draft.script?.scenes ?? [];
  const salvage = previousScenes.length
    ? await salvageSceneMediaForNewScenes({
        projectDir,
        mediaKind: draft.mediaKind === 'image' ? 'image' : 'video',
        oldScenes: previousScenes,
        newScenes: scenes,
      })
    : null;
  if (salvage?.adopted) {
    options.onProgress?.({
      phase: 'salvage',
      done: salvage.adopted,
      total: scenes.length,
      message:
        `Giữ lại ${salvage.adopted}/${scenes.length} cảnh có sẵn footage cũ` +
        (salvage.duplicates ? ` (bỏ ${salvage.duplicates} đoạn trùng lặp)` : '') +
        ` — còn ${salvage.missing} cảnh cần gen.`,
    });
  }

  // Cache timing phải khớp số cảnh MỚI, không thì lần ghép sau tưởng cache hỏng
  // và dựng lại track audio (đệm im lặng) dù audio vẫn y nguyên.
  const previousHash = readNarrationCache(projectDir)?.hash || '';
  writeNarrationCache(projectDir, {
    hash: previousHash,
    audioDuration: audioDurationSec,
    timings,
  });

  saveProjectDraft(options.projectId, {
    ...draft,
    script,
    sceneCount: scenes.length,
    // Độ dài video giờ do audio quyết định (làm tròn lên mốc model gen được ở cảnh
    // cuối) — ghi lại để UI hiện đúng.
    targetDurationSec: Math.round(scenes.reduce((sum, scene) => sum + scene.duration_hint, 0)),
  });

  return {
    script,
    audioDurationSec,
    sceneCount: scenes.length,
    alignedWithWords: words.length > 0,
    salvagedMedia: salvage?.adopted ? salvage : undefined,
  };
}

/** Dự án đã có voiceover nhưng kịch bản chưa phân cảnh → bước 3 phải chạy trước. */
export function needsScenePlanning(script: ScriptDraft | null | undefined): boolean {
  return isNarrationOnlyScript(script);
}
