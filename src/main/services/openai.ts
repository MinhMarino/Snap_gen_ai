import type {
  GenerateIdeaInput,
  GenerateMusicAnimationScriptInput,
  SceneDraft,
  SceneSection,
  ScriptDraft,
  TimedLyricLine,
} from '../../shared/types';
import {
  buildTimelineSlots,
  describeTimelineForPrompt,
  linesTextForSlot,
  slotDurationSec,
} from '../../shared/music-align';
import {
  assertNarrationCoversTarget,
  buildNarrationOnlyScript,
  clampTargetSceneCount,
  coalesceScenesToTargetCount,
  countSpokenBudgetUnits,
  DEFAULT_NARRATION_STYLE,
  DEFAULT_STYLE_PROMPT,
  KIDS_3D_TOY_STYLE,
  estimateSpokenSeconds,
  formatDurationLabel,
  isCjkLanguage,
  maxSceneBeatSec,
  mergeUndersizedScenes,
  MIN_NARRATION_COVERAGE,
  MIN_SCENE_BEAT_SEC,
  normalizeSceneDurations,
  planScenesFromDuration,
  spokenBudgetForDurationSec,
  buildStructuredVisualPrompt,
  hasVisualStyleBible,
  type VisualStyleBible,
} from '../../shared/models';
import { sanitizeNarrationText } from '../../shared/narration-clean';
import { detectScriptLanguage } from '../../shared/detect-language';
import { applySpeechRateProfile } from './speech-rate';

/** Chunk lớn hơn → ít API call hơn (TPM-friendly). */
const CHAPTER_CHUNK_SEC = 90;
const MAX_COMPLETION_TOKENS = 8192;
/** Continuations khi chapter thiếu từ — giữ thấp để tránh cháy TPM. */
const MAX_NARRATION_CONTINUATIONS = 2;
/** Retry khi OpenAI 429 / TPM. */
const MAX_RATE_LIMIT_RETRIES = 6;
/** Nghỉ giữa các chapter call để không đụng TPM 30k. */
const INTER_CALL_DELAY_MS = 1500;

interface ChapterOutline {
  name: string;
  section: SceneSection;
  targetSec: number;
  summary: string;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  return JSON.parse(raw);
}

function normalizeSection(raw: unknown): SceneSection | undefined {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'introduction' || value === 'intro' || value === 'hook' || value === 'opening') {
    return 'introduction';
  }
  if (value === 'body' || value === 'main' || value === 'content') {
    return 'body';
  }
  if (
    value === 'conclusion' ||
    value === 'outro' ||
    value === 'ending' ||
    value === 'close' ||
    value === 'closing'
  ) {
    return 'conclusion';
  }
  return undefined;
}

function normalizeChapter(raw: unknown): string | undefined {
  const value = String(raw || '').trim();
  return value || undefined;
}

function assignSections(scenes: SceneDraft[]): SceneDraft[] {
  const n = scenes.length;
  if (n < 3) return scenes;

  const hasAll =
    scenes.some((s) => s.section === 'introduction') &&
    scenes.some((s) => s.section === 'body') &&
    scenes.some((s) => s.section === 'conclusion');
  if (hasAll) return scenes;

  return scenes.map((scene, index) => {
    if (scene.section) return scene;
    let section: SceneSection = 'body';
    if (index === 0) section = 'introduction';
    else if (index === n - 1) section = 'conclusion';
    return { ...scene, section };
  });
}

function assertScriptStructure(scenes: SceneDraft[]): void {
  const intro = scenes.filter((s) => s.section === 'introduction').length;
  const body = scenes.filter((s) => s.section === 'body').length;
  const conclusion = scenes.filter((s) => s.section === 'conclusion').length;
  if (scenes.length < 3 || intro < 1 || body < 1 || conclusion < 1) {
    throw new Error(
      'Kịch bản thiếu cấu trúc bắt buộc (Introduction / Body / Conclusion). Hãy tạo lại script.'
    );
  }
}

function reindexScenes(scenes: SceneDraft[]): SceneDraft[] {
  return scenes.map((scene, i) => ({
    ...scene,
    id: `scene-${String(i + 1).padStart(2, '0')}`,
  }));
}

function mapRawScenes(rawScenes: SceneDraft[]): SceneDraft[] {
  return rawScenes.map((s, i) => ({
    id: `scene-${String(i + 1).padStart(2, '0')}`,
    visual_prompt: s.visual_prompt || '',
    narration_segment: s.narration_segment || '',
    duration_hint: Number(s.duration_hint) || estimateSpokenSeconds(s.narration_segment || '', 6),
    section: normalizeSection((s as SceneDraft).section),
    chapter: normalizeChapter((s as SceneDraft).chapter),
  }));
}

function finalizeDraft(
  parsed: ScriptDraft,
  targetDurationSec: number,
  options?: { requireStructure?: boolean }
): ScriptDraft {
  if (!parsed.scenes?.length) throw new Error('Script JSON missing scenes.');

  let scenes = mapRawScenes(parsed.scenes);
  scenes = assignSections(scenes);
  scenes = mergeUndersizedScenes(scenes);
  scenes = reindexScenes(scenes);
  if (options?.requireStructure !== false) {
    assertScriptStructure(scenes);
  }

  const normalized = normalizeSceneDurations(scenes, targetDurationSec);
  parsed.scenes = reindexScenes(normalized);
  parsed.narration = parsed.scenes.map((s) => s.narration_segment).join(' ');
  if (!parsed.title) parsed.title = 'Untitled Video';
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse "Please try again in 5.48s" / HTTP 429 → ms chờ. */
function parseRateLimitWaitMs(message: string, status?: number): number | null {
  const m = message.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 400;
  if (status === 429 || /rate limit|tokens per min|TPM|RPM/i.test(message)) {
    return 8000;
  }
  return null;
}

async function chatJson<T>(options: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
  /** Giới hạn completion — thấp hơn = ít cháy TPM hơn. */
  maxTokens?: number;
}): Promise<T> {
  const maxTokens = Math.min(
    MAX_COMPLETION_TOKENS,
    Math.max(256, options.maxTokens ?? 4096)
  );
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          temperature: options.temperature ?? 0.7,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: options.user },
          ],
        }),
      });

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        error?: { message?: string };
      };

      if (!res.ok) {
        const msg = data.error?.message || `OpenAI error HTTP ${res.status}`;
        const wait = parseRateLimitWaitMs(msg, res.status);
        if (wait != null && attempt < MAX_RATE_LIMIT_RETRIES) {
          await sleep(wait);
          continue;
        }
        throw new Error(msg);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenAI returned empty content.');
      if (data.choices?.[0]?.finish_reason === 'length') {
        throw new Error(
          'OpenAI cắt response vì quá dài (finish_reason=length). Thử model lớn hơn hoặc rút ngắn thời lượng.'
        );
      }

      return extractJson(content) as T;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const wait = parseRateLimitWaitMs(msg);
      if (wait != null && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function defaultChapterPlan(targetDurationSec: number): ChapterOutline[] {
  const introSec = Math.max(20, Math.round(targetDurationSec * 0.12));
  const outroSec = Math.max(15, Math.round(targetDurationSec * 0.1));
  const bodySec = Math.max(CHAPTER_CHUNK_SEC, targetDurationSec - introSec - outroSec);
  const bodyChunks = Math.max(1, Math.ceil(bodySec / CHAPTER_CHUNK_SEC));
  const eachBody = Math.round(bodySec / bodyChunks);

  const chapters: ChapterOutline[] = [
    {
      name: 'Opening',
      section: 'introduction',
      targetSec: introSec,
      summary: 'Hook the viewer and set up the topic.',
    },
  ];
  for (let i = 0; i < bodyChunks; i++) {
    chapters.push({
      name: `Part ${i + 1}`,
      section: 'body',
      targetSec: eachBody,
      summary: `Main content block ${i + 1} of ${bodyChunks}.`,
    });
  }
  chapters.push({
    name: 'Outro',
    section: 'conclusion',
    targetSec: outroSec,
    summary: 'Wrap up, CTA, end.',
  });

  // Fix rounding drift on last body/outro
  const sum = chapters.reduce((s, c) => s + c.targetSec, 0);
  chapters[chapters.length - 1].targetSec = Math.max(
    MIN_SCENE_BEAT_SEC * 2,
    chapters[chapters.length - 1].targetSec + (targetDurationSec - sum)
  );
  return chapters;
}

function normalizeOutline(
  raw: Array<Partial<ChapterOutline>> | undefined,
  targetDurationSec: number
): ChapterOutline[] {
  const fallback = defaultChapterPlan(targetDurationSec);
  if (!raw?.length) return fallback;

  const chapters: ChapterOutline[] = raw.map((c, i) => {
    const section =
      normalizeSection(c.section) ||
      (i === 0 ? 'introduction' : i === raw.length - 1 ? 'conclusion' : 'body');
    return {
      name: String(c.name || `Chapter ${i + 1}`).trim() || `Chapter ${i + 1}`,
      section,
      targetSec: Math.max(
        MIN_SCENE_BEAT_SEC * 2,
        Math.round(Number(c.targetSec) || CHAPTER_CHUNK_SEC)
      ),
      summary: String(c.summary || '').trim() || 'Continue the story.',
    };
  });

  if (!chapters.some((c) => c.section === 'introduction')) {
    chapters[0].section = 'introduction';
  }
  if (!chapters.some((c) => c.section === 'conclusion')) {
    chapters[chapters.length - 1].section = 'conclusion';
  }
  if (!chapters.some((c) => c.section === 'body')) {
    const mid = chapters[Math.floor(chapters.length / 2)];
    if (mid.section !== 'introduction' && mid.section !== 'conclusion') mid.section = 'body';
  }

  // Scale to exact target
  const sum = chapters.reduce((s, c) => s + c.targetSec, 0) || 1;
  const scaled = chapters.map((c) => ({
    ...c,
    targetSec: Math.max(
      MIN_SCENE_BEAT_SEC * 2,
      Math.round((c.targetSec / sum) * targetDurationSec)
    ),
  }));
  const drift =
    targetDurationSec - scaled.reduce((s, c) => s + c.targetSec, 0);
  scaled[scaled.length - 1].targetSec = Math.max(
    MIN_SCENE_BEAT_SEC * 2,
    scaled[scaled.length - 1].targetSec + drift
  );
  return scaled;
}

export async function testOpenAI(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, message: `HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true, message: 'OpenAI API key hợp lệ.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}


/**
 * Cỡ cảnh luân phiên theo index scene — gợi ý cho AI, và cũng là thứ dùng cho
 * khung tạm local. Mọi shot cùng một cỡ là cách nhanh nhất làm video thành nhàm.
 * Giữ từ vựng phổ thông, không dùng tiếng nghề (dolly, OTS…) vì mỗi từ lạ thêm
 * vào là một cơ hội để model đổi style giữa các scene.
 */
const SHOT_LADDER = [
  'wide shot',
  'medium shot',
  'close-up',
  'extreme close-up detail',
  'medium wide shot',
];

/**
 * Khung tạm TRUNG TÍNH về thể loại cho một scene, dùng khi lô viết prompt bị lỗi.
 *
 * Chỉ là scaffold: một chủ thể + một hành động + một nền đơn giản, KHÔNG chép lời
 * thoại vào đây (prompt hình phải sinh từ «Mô tả video» + «Visual style»). Bản cũ
 * cứng "a cute cartoon animal mascot" nên dự án nào cũng ra hoạt hình thiếu nhi.
 */
function scaffoldVisualPrompt(index: number): string {
  const setBases = [
    'simple uncluttered background',
    'natural outdoor setting',
    'plain neutral studio background',
    'simple indoor setting',
  ];
  const actions = [
    'presented clearly in frame',
    'seen from a slightly different angle',
    'shown in a calm steady pose',
    'framed against a clean background',
  ];
  const camera = SHOT_LADDER[index % SHOT_LADDER.length];
  return `the main subject of the video ${actions[index % actions.length]}. ${
    setBases[index % setBases.length]
  }, ${camera}.`;
}

/*
 * ĐÃ XOÁ: `inferSeriesCastBrief` (đoán nhân vật lặp lại từ brief/style) và
 * `applyLocalVisualContinuity` (chèn cast đó vào đầu mọi visual_prompt).
 *
 * Nó dò CHUỖI CON, không có ranh giới từ, và không phân biệt được lệnh cấm với
 * lệnh yêu cầu — nên một style photorealistic có dòng
 * "AVOID: … 3D render, cartoon, anime …" bị đọc thành "người dùng muốn cartoon",
 * rồi `/fox|cáo/` khớp vào chữ "quảng cáo" trong brief tiếng Việt và mọi scene
 * nhận được "a cartoon fox character as the recurring hero". `/cat/` cũng khớp
 * "deli-cat-e", `/bear/` khớp "bearing"… Đoán kiểu này không cứu được.
 *
 * Chủ thể lặp lại giờ do `enrichVisualContinuityWithAi` tự chốt theo brief — model
 * đọc được cả ngữ cảnh phủ định, việc mà regex không làm được.
 */


/**
 * Visual prompt được viết TỪ «Mô tả video» + «Visual style» — hai ô người dùng
 * điền ở bước 1. Cắt ngắn hai thứ này = vứt đúng phần quyết định chủ thể và kiểu
 * hình, nên hạn mức để rộng; chỉ chặn ở mức đủ để một brief dán cả bài báo không
 * nuốt hết context của phần scene.
 */
const MAX_BRIEF_CHARS_FOR_VISUALS = 1500;
const MAX_STYLE_CHARS_FOR_VISUALS = 1200;

/** Prompt chi tiết ~55–90 từ ≈ 150 token, cộng id + khung JSON → ~220 token/scene. */
const VISUAL_PROMPT_TOKENS_PER_SCENE = 220;
/**
 * Số scene mỗi lần gọi. Prompt chi tiết × 75 scene vượt xa cap completion (8192),
 * JSON bị cắt giữa chừng là hỏng CẢ call → mọi scene rơi về khung tạm chung chung.
 * Chia lô: lô nào lỗi thì chỉ lô đó giữ prompt cũ.
 */
const VISUAL_PROMPT_BATCH_SIZE = 10;

/** Style bible được rút từ «Visual style» — cắt rộng tay vì chỉ gửi đúng MỘT lần. */
const MAX_STYLE_CHARS_FOR_BIBLE = 6000;

/**
 * Rút «Visual style» thành bốn khối cố định, gọi đúng một lần cho cả video.
 *
 * Ghép nguyên văn bốn khối này vào mọi cảnh rẻ hơn và chắc tay hơn là bắt model
 * diễn đạt lại phong cách ở từng cảnh: không cảnh nào lệch màu, và phần cấm
 * (NEGATIVE) không bị mỗi cảnh viết mỗi kiểu.
 */
async function deriveVisualStyleBible(options: {
  apiKey: string;
  openaiModel: string;
  brief: string;
  stylePrompt: string;
  mediaKind?: string | null;
}): Promise<VisualStyleBible | null> {
  const isVideo = options.mediaKind === 'video';
  const system = `You turn a VISUAL STYLE description into the fixed blocks of a shot-prompt template for an AI image/video model.
Every shot of this video repeats these blocks word for word, so they must be complete, concrete and self-contained — a render model reads them without any other context.
Return ONLY JSON: { "style": string, "color": string, "motion": string, "negative": string, "series_cast": string }

"style" — 45–80 words. The medium and how it is rendered (live-action camera footage, 3D render, 2D illustration, anime, stop-motion, mixed), how photoreal or stylised it is, genre and era, camera and lens character, depth of field, texture and level of detail, sharpness, film or digital character. Concrete visual words a render model can act on, never adjectives like "beautiful" or "high quality".
"color" — 35–70 words. The palette in named colours, saturation level, contrast, black level, white balance and the overall grade. State plainly whether colour is true-to-life or stylised: if the style asks for realistic colour, write it as natural saturation, neutral blacks, accurate white balance, no colour cast — words a model follows.
"motion" — ${isVideo ? '20–40 words: how things move in an 8-second shot, how the camera moves, how fast, and that one single action is shown once' : 'return an empty string, this video is made of stills'}.
"negative" — 25–60 SHORT terms separated by commas, no sentences, no "no"/"avoid" prefixes, each one a thing to EXCLUDE from the picture. Merge, in this order: every AVOID / do-not / never / "not X" item stated anywhere in the VISUAL STYLE, then the usual render failures (text, watermark, logo, subtitles, extra fingers, deformed hands, distorted anatomy, blurry, out of focus, low resolution, jpeg artifacts, oversaturated, HDR look, plastic CGI look, stock photo look). If the style is photoreal, ban cartoon, anime, illustration, 3D render; if the style is drawn or animated, ban photorealistic and live-action instead. Never put anything here that the style actually asks for.
"series_cast" — one short line naming the world and any recurring character or object, so every scene stays in the same place with the same look.

The VISUAL STYLE always wins over the brief on how things look. Write everything in English.`;

  try {
    const parsed = await chatJson<{
      style?: string;
      color?: string;
      motion?: string;
      negative?: string;
      series_cast?: string;
    }>({
      apiKey: options.apiKey,
      model: options.openaiModel,
      temperature: 0.3,
      maxTokens: 1200,
      system,
      user: `=== VIDEO BRIEF (what the video is about) ===
${options.brief.slice(0, MAX_BRIEF_CHARS_FOR_VISUALS)}

=== VISUAL STYLE (decides how every shot looks) ===
${options.stylePrompt.slice(0, MAX_STYLE_CHARS_FOR_BIBLE)}

Media: ${isVideo ? 'video clips' : 'still images'}.`,
    });

    const bible: VisualStyleBible = {
      style: String(parsed.style || '').trim(),
      color: String(parsed.color || '').trim(),
      motion: isVideo ? String(parsed.motion || '').trim() : '',
      negative: String(parsed.negative || '').trim(),
      seriesCast: String(parsed.series_cast || '').trim(),
    };
    if (!hasVisualStyleBible(bible)) return null;
    return bible;
  } catch {
    // Rút style hỏng → quay về prompt một đoạn như cũ, không chặn cả bước viết prompt.
    return null;
  }
}

/**
 * Viết lại visual_prompt cho toàn bộ scene từ «Mô tả video» + «Visual style».
 *
 * Chia lô nhưng vẫn giữ một thế giới chung: lô đầu chốt `series_cast` (thế giới +
 * nhân vật/vật thể lặp lại), các lô sau nhận lại nguyên văn cast đó cùng vài prompt
 * gần nhất để không lặp khung và không đổi kiểu hình giữa chừng.
 */
async function enrichVisualContinuityWithAi(options: {
  apiKey: string;
  openaiModel: string;
  title: string;
  brief: string;
  language?: string;
  stylePrompt: string;
  mediaKind?: string | null;
  scenes: SceneDraft[];
  onProgress?: (done: number, total: number) => void;
}): Promise<SceneDraft[]> {
  const { scenes } = options;
  if (scenes.length < 2) return scenes;

  // Rút style bible TRƯỚC: có nó thì mỗi lô chỉ còn phải viết phần tả cảnh, phần
  // phong cách / màu / cấm do app ghép vào nên mọi cảnh giống hệt nhau.
  const bible = await deriveVisualStyleBible({
    apiKey: options.apiKey,
    openaiModel: options.openaiModel,
    brief: options.brief,
    stylePrompt: options.stylePrompt,
    mediaKind: options.mediaKind,
  });
  const structured = bible != null;

  /*
   * Nhất quán là nhất quán về THẾ GIỚI (bối cảnh, kiểu hình, nhân vật khi có
   * người), KHÔNG phải lặp lại một chủ thể trong mọi khung.
   *
   * Bản trước ghi "chọn MỘT chủ thể và giữ y hệt ở mọi scene": với style
   * "hands-only" model chọn luôn "hands" rồi mở đầu cả 75/75 scene bằng "Hands…" —
   * 75 shot liên tiếp cùng một thứ, xem rất chán.
   */
  const castLine =
    'Keep ONE consistent world across scenes — same place, same look, same people/objects when they reappear — and report it in "series_cast". Consistency is about the WORLD, not about filming the same thing every time.';

  const system = `You rewrite ONLY visual_prompt fields into DETAILED, CONCRETE shot descriptions for an AI image/video model.
Return ONLY JSON:
{
  "series_cast": string,
  "scenes": [ { "id": string, "visual_prompt": string } ]
}
${
  structured
    ? `LENGTH: each visual_prompt is English, 70–110 words, written as flowing descriptive phrases separated by commas. Detail is what makes the render match the style — do not write a bare one-liner.
You write ONLY the scene itself. The app appends the fixed STYLE, COLOR${bible?.motion ? ', MOTION' : ''} and NEGATIVE blocks to every prompt afterwards, so never write those sections yourself, never restate the palette or the medium, and never list anything to avoid.
Every visual_prompt must describe, in your own words and in roughly this order:
1. the subject and the ONE action or state it is in during THIS scene,
2. how that subject concretely looks — materials, textures, surfaces, condition, what it is wearing or made of,
3. the setting: where it is, what is behind it, two or three supporting details of the place,
4. framing, camera height and distance (use the scene's shot_hint),
5. the light in THIS shot: its source, direction, quality and where the shadows fall.`
    : `LENGTH: each visual_prompt is English, 55–90 words, written as flowing descriptive phrases separated by commas. Detail is what makes the render match the style — do not write a bare one-liner. Never exceed 90 words.
Every visual_prompt must describe, in your own words and in roughly this order:
1. the subject and the ONE action or state it is in during THIS scene,
2. how that subject concretely looks — materials, textures, colours, clothing or surface, expression or condition,
3. the setting: where it is, what is behind it, one or two supporting details of the place,
4. framing and camera position (use the scene's shot_hint),
5. the light: its source, direction and quality, plus the colour grade of the image,
6. the medium and rendering style taken from the VISUAL STYLE block — name it explicitly in EVERY prompt so all scenes look like one piece.`
}
${castLine}
VARIETY IS MANDATORY — this is what makes the video watchable:
- Consecutive scenes must show DIFFERENT things. Never open more than two scenes in a row with the same subject word.
- Across the video, rotate what is in frame: the whole setting, the object being worked on, a close detail of it, the tool, the hands/person doing the action, the result, the surrounding environment.
- Each scene has a "shot_hint" — use it as the framing for that scene unless the narration clearly needs another one.
- A person or their hands should be in frame only when the narration is about doing something. Otherwise show the subject itself.
WHERE EACH PART OF A PROMPT COMES FROM — follow this split strictly:
- WHAT is in frame (subject, people/objects, place, world) comes from the VIDEO BRIEF. A documentary shows real-world scenes and adults, a product video shows the product, a story video shows its characters. Do NOT turn the video into a cartoon unless the style says so.
- HOW it looks (medium, genre, lighting, colour, era, level of realism) comes from the VISUAL STYLE. ${
    structured
      ? 'The fixed blocks already carry it — inside the scene text only mention what THIS shot adds: the light of this moment and the materials in frame.'
      : 'Restate its look in concrete visual words for each scene instead of quoting it back verbatim. Any "AVOID / do not use" list inside it is a ban, never a request — never repeat the banned words in the prompt.'
  }
- The scene's narration only picks WHICH moment of that world this shot shows. Never describe the narration itself and never copy its wording.
NEVER include: continuity notes, OPENING/CONTINUATION labels, quotes of the narration, capitalised labels (SUBJECT:, CAMERA:…), section headers, bullet points, lists of bans, style bibles, locale essays, words about text/logos/watermarks, camera move jargon (parallax, orbit, dolly, tracking), or ages / children / babies / named real people.
Do NOT change narration, duration, chapter, or section. Return one visual_prompt per input scene id.
Good example: ${
    structured
      ? '"A woman in a creased white lab coat lifts a tall glass beaker of luminous blue liquid to eye level, steam curling off the rim, condensation beading down the glass; behind her a cluttered bench of pipettes, open notebooks and a humming centrifuge recedes into soft focus, a whiteboard of equations half visible on the far wall; medium shot at chest height, tall window on the left throwing hard afternoon light across her sleeve, shadows falling to the right across the bench."'
      : '"A woman in a creased white lab coat lifts a tall glass beaker of luminous blue liquid to eye level, steam curling off the rim, her focused expression lit from the side; behind her a cluttered bench of pipettes, notebooks and a humming centrifuge recedes into soft focus; medium shot at chest height, cool daylight from a tall window mixing with warm overhead lamps, muted teal and amber grade, photorealistic documentary cinematography, shallow depth of field, fine grain."'
  }
Bad example: a bare "A scientist holds a beaker in a lab.", or a paragraph of labels, bans and continuity notes.`;

  const briefBlock = options.brief.slice(0, MAX_BRIEF_CHARS_FOR_VISUALS);
  // Đã rút được style bible thì lô sau chỉ cần bốn khối ngắn đó, không gửi lại cả
  // «Visual style» — vừa đỡ token vừa hết cảnh mỗi lô hiểu phong cách một kiểu.
  const styleBlock = structured
    ? `${bible?.style}\nColour: ${bible?.color}${bible?.motion ? `\nMotion: ${bible.motion}` : ''}`
    : options.stylePrompt.slice(0, MAX_STYLE_CHARS_FOR_VISUALS);

  const batches: SceneDraft[][] = [];
  for (let i = 0; i < scenes.length; i += VISUAL_PROMPT_BATCH_SIZE) {
    batches.push(scenes.slice(i, i + VISUAL_PROMPT_BATCH_SIZE));
  }

  const byId = new Map<string, string>();
  /**
   * Neo thế giới chỉ còn MỘT dòng, giống hệt ở mọi lô.
   *
   * Bản cũ nhét thêm 2 prompt gần nhất vào mỗi lô để cảnh nối tiếp nhau — tốn
   * token, và các lô phải chạy tuần tự vì lô sau cần đầu ra của lô trước. Giờ
   * phong cách đã do style bible giữ, mỗi cảnh chỉ cần tả đúng cảnh của nó.
   */
  let seriesCast = bible?.seriesCast?.trim() || '';

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (b > 0) await sleep(INTER_CALL_DELAY_MS);
    const offset = b * VISUAL_PROMPT_BATCH_SIZE;

    const sceneBlock = batch
      .map((s, i) => {
        const index = offset + i;
        return (
          `Scene ${index + 1} [${s.id}] chapter=${s.chapter || '—'} section=${s.section || 'body'} ` +
          `duration_hint=${Math.max(2, s.duration_hint || 6)}s ` +
          `shot_hint=${SHOT_LADDER[index % SHOT_LADDER.length]}\n` +
          `narration: ${(s.narration_segment || '').trim()}`
        );
      })
      .join('\n\n');

    // Không gửi lại prompt của lô trước nữa: mỗi cảnh đứng một mình, chỉ chung
    // một dòng thế giới + bộ khối phong cách cố định.
    const continuityBlock = seriesCast
      ? `\n=== WORLD (same in every scene) ===\n${seriesCast}\n`
      : '';

    try {
      const parsed = await chatJson<{
        series_cast?: string;
        scenes?: Array<{ id?: string; visual_prompt?: string }>;
      }>({
        apiKey: options.apiKey,
        model: options.openaiModel,
        temperature: 0.4,
        maxTokens: Math.min(
          MAX_COMPLETION_TOKENS,
          Math.max(1200, batch.length * VISUAL_PROMPT_TOKENS_PER_SCENE)
        ),
        system,
        user: `Title: ${options.title}

=== VIDEO BRIEF (decides WHAT is in frame) ===
${briefBlock}

=== VISUAL STYLE (decides HOW every shot looks — applies to all scenes) ===
${styleBlock}
${continuityBlock}
=== SCENES ${offset + 1}–${offset + batch.length} of ${scenes.length} ===
${sceneBlock}

Write one DETAILED visual_prompt (${structured ? '70–110 words, the scene only — no style, colour or negative sections' : '55–90 words'}) per scene, built from the brief and the visual style above. Same world and same rendering style throughout the whole video, but each shot shows something different — follow each scene's shot_hint and its own narration.`,
      });

      if (!seriesCast) seriesCast = String(parsed.series_cast || '').trim();
      for (const row of parsed.scenes || []) {
        const id = String(row.id || '').trim();
        const vp = String(row.visual_prompt || '').trim();
        if (id && vp) byId.set(id, vp);
      }
    } catch {
      /* Lô lỗi → giữ prompt cũ cho lô đó, không hỏng cả script. */
    }

    options.onProgress?.(
      Math.min((b + 1) * VISUAL_PROMPT_BATCH_SIZE, scenes.length),
      scenes.length
    );
  }

  if (!byId.size) return scenes;

  return scenes.map((scene, index) => {
    const next = byId.get(scene.id) || byId.get(`scene-${String(index + 1).padStart(2, '0')}`);
    if (!next) return scene;
    // Không gắn thêm "Recurring cast: …" nữa — AI đã lặp cast trong từng câu,
    // và wrapper sẽ cắt mọi chỉ thị kiểu này trước khi gửi Snapgen.
    // Có style bible thì ghép STYLE / COLOR / MOTION / NEGATIVE vào đây, một lần,
    // giống hệt nhau ở mọi cảnh.
    const visual_prompt = bible ? buildStructuredVisualPrompt(next, bible) : next;
    return { ...scene, visual_prompt };
  });
}

/** Số scene mỗi lần gọi khi dùng chỉ thị tự đặt — prompt dạng khối rất dài. */
const CUSTOM_PROMPT_BATCH_SIZE = 6;
/** Ước lượng token đầu ra cho MỘT scene dạng khối (`### FORMAT`… ~1500 ký tự). */
const CUSTOM_PROMPT_TOKENS_PER_SCENE = 700;

/**
 * Viết visual_prompt bằng CHỈ THỊ TỰ ĐẶT của người dùng (`scenePromptInstruction`).
 *
 * Khác `enrichVisualContinuityWithAi` ở ba điểm:
 *  1. Chỉ thị của người dùng thay hẳn luật viết prompt mặc định.
 *  2. Kết quả giữ NGUYÊN VĂN — wrapper `buildSceneImagePrompt` bị bỏ qua ở bước gen,
 *     nên các khối có cấu trúc (`### FORMAT`, `### LIGHT`…) không bị cắt/băm.
 *  3. Chia lô: một khối ~1500 ký tự × 75 scene vượt xa giới hạn completion, nên
 *     gọi theo lô nhỏ. Lô nào lỗi thì giữ prompt cũ của lô đó, không hỏng cả script.
 */
async function writeScenePromptsWithInstruction(options: {
  apiKey: string;
  openaiModel: string;
  instruction: string;
  title: string;
  brief: string;
  /** «Visual style» của bước 1 — vẫn là nguồn kiểu hình, chỉ thị tự đặt lo phần FORMAT. */
  stylePrompt: string;
  scenes: SceneDraft[];
  onProgress?: (done: number, total: number) => void;
}): Promise<SceneDraft[]> {
  const { scenes } = options;
  if (!scenes.length) return scenes;

  const byId = new Map<string, string>();
  const batches: SceneDraft[][] = [];
  for (let i = 0; i < scenes.length; i += CUSTOM_PROMPT_BATCH_SIZE) {
    batches.push(scenes.slice(i, i + CUSTOM_PROMPT_BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (b > 0) await sleep(INTER_CALL_DELAY_MS);

    const sceneBlock = batch
      .map((s, i) => {
        const index = b * CUSTOM_PROMPT_BATCH_SIZE + i + 1;
        return (
          `Scene ${index} [${s.id}] chapter=${s.chapter || '—'} section=${s.section || 'body'} ` +
          `duration_hint=${Math.max(2, s.duration_hint || 6)}s\n` +
          `narration: ${(s.narration_segment || '').trim()}`
        );
      })
      .join('\n\n');

    try {
      const parsed = await chatJson<{ scenes?: Array<{ id?: string; prompt?: string }> }>({
        apiKey: options.apiKey,
        model: options.openaiModel,
        temperature: 0.6,
        maxTokens: Math.min(
          MAX_COMPLETION_TOKENS,
          Math.max(1500, batch.length * CUSTOM_PROMPT_TOKENS_PER_SCENE)
        ),
        // Chỉ thị của người dùng đứng NGUYÊN VĂN ở đầu; app chỉ nối thêm hợp đồng
        // đầu ra JSON để map prompt về đúng scene id.
        system: `${options.instruction.trim()}

OUTPUT CONTRACT (added by the app — obey it, it does not replace anything above):
Return ONLY JSON in this exact shape:
{ "scenes": [ { "id": "<the scene id given to you>", "prompt": "<the complete prompt for that scene, exactly in the format specified above>" } ] }
Put the whole prompt for a scene into its "prompt" string, keeping every section and line break the instructions above ask for. Do not number scenes inside the prompt text, do not add commentary, and return one entry per scene id you were given.`,
        user: `Video title: ${options.title}

=== VIDEO BRIEF (decides WHAT is in frame — subject, people/objects, world) ===
${options.brief.slice(0, 2000)}

=== VISUAL STYLE (decides HOW every shot looks — same look in all scenes) ===
${options.stylePrompt.slice(0, MAX_STYLE_CHARS_FOR_VISUALS)}

Write a prompt for each of these ${batch.length} scenes, in the format the instructions above specify. The brief and the visual style define the subject and the look; the narration line only tells you which moment of that video this scene is.

${sceneBlock}`,
      });

      for (const row of parsed.scenes || []) {
        const id = String(row.id || '').trim();
        const prompt = String(row.prompt || '').trim();
        if (id && prompt) byId.set(id, prompt);
      }
    } catch {
      /* Lô lỗi → giữ prompt cũ cho lô đó. */
    }
    options.onProgress?.(Math.min((b + 1) * CUSTOM_PROMPT_BATCH_SIZE, scenes.length), scenes.length);
  }

  if (!byId.size) return scenes;
  return scenes.map((scene) => {
    const next = byId.get(scene.id);
    return next ? { ...scene, visual_prompt: next } : scene;
  });
}

/**
 * Bước 3: viết visual_prompt cho các scene VỪA chia theo độ dài audio thật.
 *
 * Cùng hai đường viết prompt như trước (chỉ thị tự đặt giữ nguyên văn / luật mặc
 * định), chỉ khác thời điểm gọi: giờ scene đã có mốc thời gian thật nên
 * `duration_hint` đưa vào prompt là số giây scene sẽ chạy, không phải số ước lượng.
 * Lô nào lỗi → scene đó rơi về khung tạm, không để prompt rỗng xuống Snapgen.
 */
export async function writeVisualPromptsForScenes(options: {
  apiKey: string;
  openaiModel: string;
  title: string;
  brief: string;
  language?: string;
  stylePrompt?: string;
  scenePromptInstruction?: string;
  /** 'video' → style bible có thêm khối MOTION. */
  mediaKind?: string | null;
  scenes: SceneDraft[];
  onProgress?: (done: number, total: number) => void;
}): Promise<SceneDraft[]> {
  const { scenes } = options;
  if (!scenes.length) return scenes;

  const stylePrompt = options.stylePrompt?.trim() || DEFAULT_STYLE_PROMPT;
  const instruction = options.scenePromptInstruction?.trim();

  const written = instruction
    ? await writeScenePromptsWithInstruction({
        apiKey: options.apiKey,
        openaiModel: options.openaiModel,
        instruction,
        title: options.title,
        brief: options.brief,
        stylePrompt,
        scenes,
        onProgress: options.onProgress,
      })
    : await enrichVisualContinuityWithAi({
        apiKey: options.apiKey,
        openaiModel: options.openaiModel,
        title: options.title,
        brief: options.brief,
        language: options.language,
        stylePrompt,
        mediaKind: options.mediaKind,
        scenes,
        onProgress: options.onProgress,
      });

  return written.map((scene, index) => ({
    ...scene,
    visual_prompt: (scene.visual_prompt || '').trim() || scaffoldVisualPrompt(index),
  }));
}

/**
 * Bước 1 của dự án thường: CHỈ viết lời đọc, theo Chapter.
 *
 * Không chia scene và không viết visual_prompt ở đây nữa. Chia cảnh cần biết lời
 * này đọc ra dài bao nhiêu giây THẬT, mà chỉ TTS mới trả lời được — nên việc đó
 * dời xuống `planScenesFromNarrationAudio` (bước 3, sau khi đã có audio).
 * Tối ưu TPM: ít call hơn, chapter lớn, retry 429, delay giữa call.
 */
export async function generateScript(
  apiKey: string,
  openaiModel: string,
  input: GenerateIdeaInput
): Promise<ScriptDraft> {
  const plan = planScenesFromDuration(input.targetDurationSec, {
    targetSceneCount: input.sceneCount,
    mediaKind: input.mediaKind,
  });
  const targetDurationSec = plan.targetDurationSec;
  // Ngôn ngữ lời bình: người dùng chọn ở panel giọng đọc thì theo đúng lựa chọn đó;
  // để «Tự động» thì đoán từ brief. Phải chốt TRƯỚC khi viết vì ngân sách lời tính
  // bằng ký tự (CJK) hay từ (còn lại) là hai con số khác hẳn nhau.
  const explicitLanguage = input.language?.trim() || '';
  const language = explicitLanguage || detectScriptLanguage(input.brief);
  // Ngân sách lời = thời lượng × nhịp đọc THẬT của giọng đang dùng (đo từ lần TTS
  // gần nhất, xem `speech-rate.ts`). Phải nạp trước mọi phép tính bên dưới vì cả
  // `spokenBudgetForDurationSec` lẫn `estimateSpokenSeconds` đều đọc nhịp này.
  const rate = applySpeechRateProfile(language);
  const totalBudget = spokenBudgetForDurationSec(targetDurationSec, language);
  console.log(
    `[script] ${formatDurationLabel(targetDurationSec)} · ${language} · ` +
      `${Math.round(rate.perSec * 100) / 100} ${rate.unitLabel}/s (${rate.source}) ` +
      `→ ngân sách ~${totalBudget.amount} ${totalBudget.unitLabel}`
  );
  /*
   * Giọng kể — wrapper người dùng đặt cho dự án, rỗng thì lấy mặc định.
   *
   * Chỗ này TRƯỚC ĐÂY nhét `Style: <style hình ảnh>` vào prompt viết lời: người
   * viết voiceover nhận được "natural lighting, clean background, sharp and well
   * composed" — vô nghĩa với lời nói, mà vẫn chiếm chỗ của phần tả giọng. Style
   * hình giờ chỉ đi vào bước viết visual_prompt, đúng chỗ của nó.
   */
  const narrationStyle = input.narrationStyle?.trim() || DEFAULT_NARRATION_STYLE;
  const voiceBlock = `CHANNEL VOICE — this is how this channel talks. Follow it for tone, pacing and word choice; it outranks the generic voice notes above, but never the JSON shape, the language or the word budget.
"""
${narrationStyle}
"""`;

  // —— Phase 1: outline (bỏ qua nếu video ngắn — dùng plan local) ——
  let title =
    input.brief.trim().split(/\n/)[0]?.slice(0, 80).trim() || 'Untitled Video';
  let chapters: ChapterOutline[];

  const skipOutlineApi = targetDurationSec <= 240;
  if (skipOutlineApi) {
    chapters = defaultChapterPlan(targetDurationSec);
  } else {
    const outlineSystem = `You plan a ${formatDurationLabel(targetDurationSec)} video outline.
Return ONLY JSON:
{
  "title": string,
  "chapters": [
    { "name": string, "section": "introduction"|"body"|"conclusion", "targetSec": number, "summary": string }
  ]
}
Rules:
- Sum of targetSec MUST equal ${targetDurationSec}.
- Prefer chapters of ~${CHAPTER_CHUNK_SEC}s (range 70–110s). For listicles, each item can be its own chapter.
- Must include introduction, body (one or more), conclusion.
- Topic, audience and tone come from the brief — match them; do not assume a children's video.
- One clear idea per chapter.
- Do NOT write full narration yet — only chapter plan.`;

    try {
      const outline = await chatJson<{
        title?: string;
        chapters?: Array<Partial<ChapterOutline>>;
      }>({
        apiKey,
        model: openaiModel,
        system: outlineSystem,
        user: `Brief / topic: ${input.brief}

Plan chapters for a ${targetDurationSec}s (${formatDurationLabel(targetDurationSec)}) video (~${totalBudget.amount} ${totalBudget.unitLabel} of speech).

${voiceBlock}`,
        temperature: 0.5,
        maxTokens: 900,
      });
      title = String(outline.title || '').trim() || title;
      chapters = normalizeOutline(outline.chapters, targetDurationSec);
    } catch {
      chapters = defaultChapterPlan(targetDurationSec);
    }
    await sleep(INTER_CALL_DELAY_MS);
  }

  // —— Phase 2: narration per chapter → split scenes local (không gọi AI split) ——
  const writeNarrationSystem = `You write spoken voiceover for ONE chapter of a video.
Return ONLY JSON: { "narration": string } OR { "continuation": string }
Language: ${
    explicitLanguage
      ? `write EVERY narration sentence in ${language}. This is a hard requirement set by the user — the brief itself may be written in a different language, ignore that and write in ${language}. You are NOT translating: write fresh spoken ${language}, the way someone who thinks in ${language} would say it.`
      : `write the narration in the SAME language the brief is written in (detected: ${language}). If the brief explicitly asks for another language, follow the brief instead.`
  }
Audience and tone: taken from the brief. Match it — do not default to a children's video.
Voice: clear and natural for that audience; spoken, not written prose.
Sentences: short enough to say out loud comfortably.
Continuity: keep one through-line across chapters so the video feels like one piece, not disconnected clips.
No stage directions, no bullet points, no markdown, no on-screen text instructions.
The JSON string holds the SPOKEN WORDS ONLY. It must start with the first word the narrator says. No lead-in sentence about what follows ("Dưới đây là…", "Here is the narration…", "Bản dịch tiếng Việt:"), no title line, no note about the language or the translation, no closing remark — those get read out loud by the voice engine.
Do NOT summarize. Aim for the exact word budget.

${voiceBlock}`;

  // Model đôi lúc nhả cả đề bài + đoạn lặp vô nghĩa vào chuỗi narration (JSON
  // vẫn hợp lệ nên parse qua được) → lọc ngay khi nhận, đừng để chảy xuống TTS.
  const cleanNarration = (raw: unknown): string =>
    sanitizeNarrationText(String(raw || ''), {
      dropForeignSentences: isCjkLanguage(language),
    });

  const previousNarrationTail: string[] = [];
  const chapterNarrations: Array<{ chapter: ChapterOutline; narration: string }> = [];

  for (let i = 0; i < chapters.length; i++) {
    if (i > 0) await sleep(INTER_CALL_DELAY_MS);

    const chapter = chapters[i];
    const budget = spokenBudgetForDurationSec(chapter.targetSec, language);
    const minUnits = Math.round(budget.amount * MIN_NARRATION_COVERAGE);
    const minSec = chapter.targetSec * MIN_NARRATION_COVERAGE;
    const prevContext =
      previousNarrationTail.length > 0
        ? `Continue smoothly after this ending (do not repeat):\n"""${previousNarrationTail[previousNarrationTail.length - 1].slice(-280)}"""`
        : 'This is the opening of the video.';
    const chapterMaxTokens = Math.min(
      MAX_COMPLETION_TOKENS,
      Math.max(900, Math.round(chapter.targetSec * 28))
    );

    let narration = '';
    for (let attempt = 1; attempt <= MAX_NARRATION_CONTINUATIONS; attempt++) {
      const spokenSec = estimateSpokenSeconds(narration, 0);
      const haveUnits = countSpokenBudgetUnits(narration, language);
      if (spokenSec >= minSec && haveUnits >= minUnits * 0.7) break;
      const needMore = Math.max(0, minUnits - haveUnits);

      if (attempt > 1) await sleep(INTER_CALL_DELAY_MS);

      if (!narration) {
        const parsed = await chatJson<{ narration?: string }>({
          apiKey,
          model: openaiModel,
          system: writeNarrationSystem,
          user: `Video title: ${title}
Brief: ${input.brief.slice(0, 1200)}

Chapter ${i + 1}/${chapters.length}: "${chapter.name}" (${chapter.section})
Summary: ${chapter.summary}
TIME: ${chapter.targetSec}s → write enough spoken content for ~${chapter.targetSec}s
Budget: ~${budget.amount} ${budget.unitLabel} (≥ ${minUnits} ${budget.unitLabel}).
${isCjkLanguage(language) ? 'This is a CJK language: count characters (not English-style space-separated words).' : ''}

${prevContext}

Return JSON: { "narration": "<full spoken script for this chapter only>" }`,
          temperature: 0.75,
          maxTokens: chapterMaxTokens,
        });
        narration = cleanNarration(parsed.narration);
      } else {
        const parsed = await chatJson<{ continuation?: string; narration?: string }>({
          apiKey,
          model: openaiModel,
          system: writeNarrationSystem,
          user: `Chapter "${chapter.name}" is TOO SHORT: ~${formatDurationLabel(spokenSec)} / ${chapter.targetSec}s (${haveUnits}/${minUnits} ${budget.unitLabel}).

Already written (keep all of it, then CONTINUE):
"""${narration.slice(-1800)}"""

Return JSON: { "continuation": "<only the NEW sentences to append, add ~${needMore} ${budget.unitLabel}>" }
Do not restart. Do not summarize the previous text.`,
          temperature: 0.8,
          maxTokens: Math.min(2048, chapterMaxTokens),
        });
        const extra = cleanNarration(parsed.continuation || parsed.narration);
        if (extra) {
          if (
            extra.length > narration.length * 0.8 &&
            narration.length > 20 &&
            extra.includes(narration.slice(0, Math.min(40, narration.length)))
          ) {
            narration = extra;
          } else {
            narration = `${narration} ${extra}`.trim();
          }
        }
      }
    }

    const spokenSec = estimateSpokenSeconds(narration, 0);
    if (spokenSec < chapter.targetSec * 0.45) {
      throw new Error(
        `Chapter "${chapter.name}" chỉ ~${formatDurationLabel(spokenSec)} (cần ~${formatDurationLabel(chapter.targetSec)}). ` +
          `Thử Generate lại hoặc đổi model.`
      );
    }

    chapterNarrations.push({ chapter, narration });
    previousNarrationTail.push(narration);
  }

  const joinNarration = () =>
    chapterNarrations
      .map((c) => c.narration.trim())
      .filter(Boolean)
      .join('\n\n');

  // —— Phase 3: viết bù khi tổng lời còn ngắn so với mục tiêu (tối đa 2 lần) ——
  for (let fill = 1; fill <= 2; fill++) {
    const spoken = estimateSpokenSeconds(joinNarration(), 0);
    if (spoken >= targetDurationSec * MIN_NARRATION_COVERAGE) break;

    await sleep(INTER_CALL_DELAY_MS);
    const deficitSec = Math.max(15, targetDurationSec - spoken);
    const deficitBudget = spokenBudgetForDurationSec(deficitSec, language);
    const bodyChapters = chapterNarrations.filter((c) => c.chapter.section === 'body');
    const targetChapter =
      bodyChapters[(fill - 1) % Math.max(1, bodyChapters.length)] ||
      chapterNarrations[1] ||
      chapterNarrations[0];
    if (!targetChapter) break;

    const parsed = await chatJson<{ continuation?: string }>({
      apiKey,
      model: openaiModel,
      system: writeNarrationSystem,
      user: `The full video is still short (~${formatDurationLabel(spoken)} / ${formatDurationLabel(targetDurationSec)}). Add ≥ ${deficitBudget.amount} ${deficitBudget.unitLabel} of spoken content (~${Math.round(deficitSec)}s).

Chapter: ${targetChapter.chapter.name}
Existing (tail):
"""${targetChapter.narration.slice(-1600)}"""

Return { "continuation": "<new sentences only, ≥ ${deficitBudget.amount} ${deficitBudget.unitLabel}>" }`,
      temperature: 0.85,
      maxTokens: Math.min(2048, Math.max(600, Math.round(deficitSec * 28))),
    });
    const extra = cleanNarration(parsed.continuation);
    if (!extra) continue;

    targetChapter.narration = `${targetChapter.narration} ${extra}`.trim();
  }

  const draft = buildNarrationOnlyScript({
    title,
    narration: joinNarration(),
    targetDurationSec,
  });
  // Vẫn chặn ở đây: lời quá ngắn thì TTS ra audio hụt, và mọi thứ phía sau
  // (phân cảnh, số ảnh, độ dài video) đều tính từ audio đó.
  assertNarrationCoversTarget(draft.scenes, targetDurationSec, MIN_NARRATION_COVERAGE);
  return draft;
}

async function chatJsonWithImages<T>(options: {
  apiKey: string;
  model: string;
  system: string;
  userText: string;
  images?: Array<{ dataUrl: string; name?: string }>;
  temperature?: number;
  maxTokens?: number;
}): Promise<T> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: options.userText }];
  for (const img of options.images || []) {
    content.push({
      type: 'image_url',
      image_url: { url: img.dataUrl },
    });
  }
  const maxTokens = Math.min(
    MAX_COMPLETION_TOKENS,
    Math.max(256, options.maxTokens ?? 4096)
  );
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          temperature: options.temperature ?? 0.65,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content },
          ],
        }),
      });
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        error?: { message?: string };
      };
      if (!res.ok) {
        const msg = data.error?.message || `OpenAI error HTTP ${res.status}`;
        const wait = parseRateLimitWaitMs(msg, res.status);
        if (wait != null && attempt < MAX_RATE_LIMIT_RETRIES) {
          await sleep(wait);
          continue;
        }
        throw new Error(msg);
      }
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('OpenAI returned empty content.');
      return extractJson(text) as T;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const wait = parseRateLimitWaitMs(msg);
      if (wait != null && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Ghép visual do AI viết với mốc thời gian thật của lời hát.
 *
 * AI chỉ trả về khoảng câu (first_line / last_line); mọi phép tính giây nằm ở
 * `alignRangesToSlots`. Slot nào là phần cắt thêm của một cảnh quá dài thì dùng
 * lại visual của cảnh gốc — wrapper tự đổi cỡ cảnh theo index nên vẫn ra khung khác.
 *
 * Trả về [] khi dữ liệu AI không dùng được → caller lùi về cách chia cũ.
 */
function buildTimedScenes(options: {
  scenes: SceneDraft[];
  timedLines: TimedLyricLine[];
  musicSec: number;
  targetMediaCount: number;
  typicalBeatSec: number;
  maxBeatSec: number;
}): SceneDraft[] {
  const { scenes, timedLines, musicSec, targetMediaCount } = options;
  if (timedLines.length < 2) return [];

  const slots = buildTimelineSlots({
    // AI không trả mốc dùng được → buildTimelineSlots tự chia theo câu hát.
    aiSlots: scenes.map((s) => ({ start: Number(s.start_sec), end: Number(s.end_sec) })),
    lines: timedLines,
    timeline: {
      audioDurationSec: musicSec,
      minSec: Math.max(MIN_SCENE_BEAT_SEC, options.typicalBeatSec * 0.45),
      maxSec: options.maxBeatSec,
      maxCount: targetMediaCount,
    },
  });
  if (!slots.length) return [];

  const out: SceneDraft[] = slots.map((slot, i) => {
    const source = scenes[Math.min(slot.sourceIndex, scenes.length - 1)] || scenes[0];
    // Lời hát của slot: ưu tiên text đã có mốc (đúng theo thời gian); slot không có
    // câu nào (nhạc dạo / outro) thì để rỗng — đúng bản chất, không phải lỗi.
    const lyric = linesTextForSlot(timedLines, slot) || (slot.isSplit ? '' : source.narration_segment?.trim() || '');
    return {
      // Cùng quy ước với `reindexScenes` — tên thư mục media của scene dựa trên id này.
      id: `scene-${String(i + 1).padStart(2, '0')}`,
      visual_prompt: source.visual_prompt || '',
      narration_segment: lyric,
      duration_hint: slotDurationSec(slot),
      start_sec: Math.round(slot.start * 10) / 10,
      end_sec: Math.round(slot.end * 10) / 10,
      section: source.section,
      chapter: source.chapter || `Beat ${i + 1}`,
    };
  });

  return assignSections(out);
}

/**
 * Phân tích lyric + độ dài nhạc → kịch bản phân cảnh cho video hoạt hình nhạc.
 * narration_segment = lyric/beat lines cho scene; visual_prompt = shot Snapgen.
 */
export async function generateMusicAnimationScript(
  apiKey: string,
  openaiModel: string,
  input: GenerateMusicAnimationScriptInput,
  characterImages?: Array<{ dataUrl: string; name?: string }>
): Promise<{ script: ScriptDraft; notes: string; castLock: string }> {
  const musicSec = Math.max(8, Math.round(input.musicDurationSec || 60));
  const plan = planScenesFromDuration(musicSec, {
    targetSceneCount: input.sceneCount,
    mediaKind: input.mediaKind,
    // Một cảnh không dài quá một lần gen: dài hơn thì cùng một visual prompt phải
    // trải ra nhiều shot, tốn đúng ngần ấy credit mà hình lặp lại.
    beatCapSec: maxSceneBeatSec(input.model, input.mediaKind),
  });
  const targetMediaCount = clampTargetSceneCount(musicSec, plan.sceneCountHint);
  // Không còn ô Language → lấy đúng ngôn ngữ của lời bài hát đang nhập.
  const language = input.language?.trim() || detectScriptLanguage(input.lyricText);
  const styleLine = input.stylePrompt?.trim()
    ? `Style (same in every visual_prompt): ${input.stylePrompt.trim()}`
    : `Style (same in every visual_prompt): ${KIDS_3D_TOY_STYLE}`;
  const characterLine = input.characterBrief?.trim()
    ? `Character continuity: ${input.characterBrief.trim()}`
    : characterImages?.length
      ? 'Character continuity: match the uploaded character reference image(s) consistently across scenes.'
      : 'Characters may be original if none uploaded — keep cast consistent across scenes.';

  // Ảnh tĩnh không zoom/pan nữa → mô tả camera move là vô nghĩa, phải yêu cầu
  // bố cục một khung đứng vững thay vì "camera pushes in".
  // Prompt NGẮN cho ra hình ổn định hơn hẳn: bản cũ đòi 90–160 từ với đủ lớp
  // foreground/midground/background, palette, motion quality — model gom lại thành
  // một khung rối, và mỗi scene lại "diễn giải" chi tiết một kiểu nên nhân vật đổi
  // dáng liên tục. Hoạt hình thiếu nhi chỉ cần: ai + làm gì + ở đâu.
  const isStill = input.mediaKind === 'image';
  const shotLine = isStill
    ? 'visual_prompt = ONE simple picture in English, 18–35 words: which character (name it), ONE easy pose from the lyric, ONE simple background, one shot size (wide shot | medium shot | close-up — VARY it between consecutive scenes). No camera-movement words (no pan/zoom/dolly/tracking) — the frame is held still. No text, no collage.'
    : 'visual_prompt = ONE simple animated shot in English, 20–40 words: which character (name it), ONE easy motion, ONE simple background. The motion may ONLY be: bouncing springily up and down, wiggling / swaying side to side, nodding, waving, rolling forward slowly, or a little hop in place. Never dance routines, running, spinning, flips or acrobatics. Keep the same characters and style in every scene. No text, no collage, no camera jargon.';

  // Có mốc thời gian thật thì AI KHÔNG được tự đặt độ dài cảnh nữa: nó chỉ nhóm
  // câu hát (việc nó làm tốt — nhận ra phiên khúc / điệp khúc), còn mốc giây do
  // `alignRangesToSlots` tính từ timestamp thật.
  const timedLines = input.timedLines || [];
  const timedBlock =
    timedLines.length >= 2 ? describeTimelineForPrompt(timedLines, musicSec) : '';
  const timingRules = timedBlock
    ? `- TIMING COMES FROM THE AUDIO, NOT FROM YOU. Each scene returns "start_sec" and "end_sec" taken from the timeline above — do NOT return duration_hint, and do NOT invent timestamps that are not printed there.
- Scenes must run back-to-back with NO gap and NO overlap: scene 1 starts at 0.0s, each next scene starts exactly where the previous ended, the last scene ends at ${musicSec.toFixed(1)}s. Cover the WHOLE song including instrumental parts.
- Give every [INTRO] / [BREAK] / [OUTRO] block its own scene — those seconds have no lyric, so they need a picture of their own (establishing the cast, a wide view of the world, a calm closing shot). Cutting them into a lyric scene is wrong.
- Aim for ~${plan.typicalBeatSec}s of REAL time per scene: read the timestamps, do not count words. A held note or a repeated chorus line can be long; a quick line can be short.
- narration_segment = the lyric lines actually sung inside that time range, copied from the original lyric text (faithful spelling). Empty string for instrumental scenes.`
    : `- Total of duration_hint MUST equal ${musicSec} (±2s ok).`;

  const system = `You storyboard a CHILDREN'S cartoon music video (nursery-rhyme / kids-song style) for AI video generation (Snapgen).
Return ONLY JSON:
{
  "title": string,
  "notes": string,
  "cast_lock": string,
  "scenes": [
    {
      "id": string,
      "chapter": string,
      "section": "introduction"|"body"|"conclusion",
      ${timedBlock ? '"start_sec": number,\n      "end_sec": number,' : '"duration_hint": number,'}
      "narration_segment": string,
      "visual_prompt": string
    }
  ]
}
Rules:
${timingRules}
- HARD LIMIT: return about ${targetMediaCount} scenes (range ${Math.max(3, targetMediaCount - 2)}–${targetMediaCount + 2}). Typical beat ~${plan.typicalBeatSec}s (max ~${plan.maxBeatSec}s). Do NOT create one scene per lyric line if that exceeds the limit — group lines.
- narration_segment = the lyric lines / vocal phrases that play during that scene (language: ${language}). Keep lyric wording faithful; you may lightly punctuate.
- ${shotLine}
- cast_lock = 15–30 ENGLISH words naming every recurring character with a few re-drawable traits (animal/toy type, main colour, one outfit piece, one signature accessory). Concrete nouns only — no story, no age, no adjectives like "beautiful". Every scene is generated independently, so this short line is what keeps the characters identical.
- Every visual_prompt must call characters by the SAME names used in cast_lock (never "the singer" / "a mascot" if the cast has a name).
- Audience is toddlers and young children: everything cheerful, gentle and easy to recognise — daytime, friendly faces, simple toys and nature. No scary, sad-dramatic, dark, violent or romantic imagery, no night gloom, no weapons.
- KEEP IT SIMPLE AND FUN — this is the most important rule. Each scene: 1 to 5 friendly characters at most (never a crowd, never background people), a few big simple props, a clean uncluttered background. Nothing intricate, elaborate or busy.
- Characters are cartoon VEHICLES, ANIMALS or TOYS with big shiny cartoon eyes and happy smiles — the classic kids-channel cast. A row of them side by side facing the camera is a great shot.
- Everything in the frame is a cartoon, including scenery and objects: cars, buses, houses, trees, furniture and food are chunky rounded cartoon shapes in bright saturated colors — never photoreal, never live-action footage.
- Energy: calm lines → one character in a cosy spot; chorus → brighter colours and a slightly bigger bounce. Bigger energy means brighter colour, NOT more characters or more detail.
- SAFETY (Google blocks these outright — a blocked scene costs the user a failed render): characters are friendly cartoon VEHICLES, ANIMALS or TOYS. Never write children, babies, toddlers, teenagers or school pupils, and never mention ages. Never name or describe real people, celebrities or public figures, never use copyrighted or branded characters (Disney, Pokémon, superheroes…), never put brand logos in frame. This applies to cast_lock and to every visual_prompt.
- ${styleLine}
- ${characterLine}
- section: intro/body/outro structure across the song.
- Media: ${input.mediaKind} · ${input.family}/${input.model} · ${input.aspectRatio} · ${input.resolution}`;

  const userText = `Song duration: ${musicSec}s (${formatDurationLabel(musicSec)})
Target media count: ~${targetMediaCount} scenes (~${plan.typicalBeatSec}s each)
Language / lyric language: ${language}
${input.songTitle ? `Title hint: ${input.songTitle}` : ''}
${timedBlock ? `\nSONG TIMELINE — real timestamps measured from the actual audio file:\n${timedBlock}\n` : ''}
LYRICS / SCRIPT:
"""
${input.lyricText.trim()}
"""

Plan a kids cartoon music-video storyboard that fits the song length exactly within the media-count budget. Keep every visual_prompt short and simple.${
    timedBlock
      ? `\nWalk the timeline above from 0.0s to ${musicSec.toFixed(1)}s and cut it into scenes. Return start_sec / end_sec for every scene, back-to-back, covering the instrumental [INTRO]/[BREAK]/[OUTRO] blocks as their own scenes.`
      : ''
  }`;

  const model = openaiModel.trim() || 'gpt-4o-mini';
  type MusicScriptResponse = {
    title?: string;
    notes?: string;
    cast_lock?: string;
    scenes?: Array<Partial<SceneDraft> & { first_line?: number; last_line?: number }>;
  };
  const raw =
    characterImages && characterImages.length
      ? await chatJsonWithImages<MusicScriptResponse>({
          apiKey,
          model,
          system,
          userText,
          images: characterImages,
          temperature: 0.65,
          maxTokens: Math.min(MAX_COMPLETION_TOKENS, Math.max(2000, Math.round(musicSec * 40))),
        })
      : await chatJson<MusicScriptResponse>({
          apiKey,
          model,
          system,
          user: userText,
          temperature: 0.65,
          maxTokens: Math.min(MAX_COMPLETION_TOKENS, Math.max(2000, Math.round(musicSec * 40))),
        });

  const scenes: SceneDraft[] = (raw.scenes || [])
    .map((s, i) => ({
      id: String(s.id || `m${i + 1}`).trim() || `m${i + 1}`,
      visual_prompt: String(s.visual_prompt || '').trim(),
      narration_segment: String(s.narration_segment || '').trim(),
      duration_hint: Math.max(2, Number(s.duration_hint) || 6),
      // Mốc AI chọn trên trục nhạc — giữ lại để `buildTimedScenes` dùng. Phải đi
      // cùng scene qua bước filter, nếu tách mảng riêng thì index lệch → gán sai visual.
      start_sec: Number(s.start_sec),
      end_sec: Number(s.end_sec),
      section: normalizeSection(s.section) || (i === 0 ? 'introduction' : 'body'),
      chapter: normalizeChapter(s.chapter) || `Beat ${i + 1}`,
    }))
    .filter((s) => s.visual_prompt || s.narration_segment);

  if (!scenes.length) {
    throw new Error('ChatGPT không trả về scene nào từ lyric.');
  }

  // —— Căn cảnh theo mốc hát thật ——
  if (timedBlock) {
    const timed = buildTimedScenes({
      scenes,
      timedLines,
      musicSec,
      targetMediaCount,
      typicalBeatSec: plan.typicalBeatSec,
      maxBeatSec: plan.maxBeatSec,
    });
    if (timed.length) {
      return {
        script: {
          title:
            String(raw.title || input.songTitle || 'Music Animation').trim() || 'Music Animation',
          narration: timed.map((s) => s.narration_segment).join('\n'),
          scenes: timed,
        },
        notes: String(raw.notes || '').trim(),
        castLock: String(raw.cast_lock || '').trim() || String(input.characterBrief || '').trim(),
      };
    }
  }

  const limited =
    scenes.length > targetMediaCount
      ? coalesceScenesToTargetCount(assignSections(scenes), targetMediaCount)
      : assignSections(scenes);

  const draft = finalizeDraft(
    {
      title: String(raw.title || input.songTitle || 'Music Animation').trim() || 'Music Animation',
      narration: limited.map((s) => s.narration_segment).join('\n'),
      scenes: limited,
    },
    musicSec,
    { requireStructure: false }
  );

  // Không có cast_lock thì dùng characterBrief người dùng nhập làm phương án dự phòng.
  const castLock =
    String(raw.cast_lock || '').trim() || String(input.characterBrief || '').trim();

  return {
    script: draft,
    notes: String(raw.notes || '').trim(),
    castLock,
  };
}
