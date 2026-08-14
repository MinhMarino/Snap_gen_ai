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
  clampTargetSceneCount,
  coalesceScenesToTargetCount,
  countSpokenBudgetUnits,
  DEFAULT_STYLE_PROMPT,
  KIDS_3D_TOY_STYLE,
  estimateScriptSpokenSeconds,
  estimateSpokenSeconds,
  findScenesWithShortNarration,
  formatDurationLabel,
  isCjkLanguage,
  MAX_SCENE_BEAT_SEC,
  mergeUndersizedScenes,
  MIN_NARRATION_COVERAGE,
  MIN_SCENE_BEAT_SEC,
  normalizeSceneDurations,
  planScenesFromDuration,
  spokenBudgetForDurationSec,
  WORDS_PER_SECOND,
} from '../../shared/models';
import { sanitizeNarrationText } from '../../shared/narration-clean';

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

function needsNarrationExpansion(scenes: SceneDraft[], targetDurationSec: number): boolean {
  if (estimateScriptSpokenSeconds(scenes) < targetDurationSec * MIN_NARRATION_COVERAGE) {
    return true;
  }
  return findScenesWithShortNarration(scenes).length > 0;
}

function needsBeatSplit(scenes: SceneDraft[], maxBeatSec = MAX_SCENE_BEAT_SEC): boolean {
  const cap = Math.max(MIN_SCENE_BEAT_SEC, maxBeatSec);
  return scenes.some(
    (s) => estimateSpokenSeconds(s.narration_segment || '', 0) > cap
  );
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


/** Chia narration thành scene theo câu khi AI cắt mất lời — visual prompt liên kết beat trước/sau. */
function splitNarrationFallback(
  narration: string,
  chapter: ChapterOutline,
  typicalBeatSec: number,
  language?: string,
  maxBeatSec = MAX_SCENE_BEAT_SEC,
  continuity?: {
    seriesCast?: string;
    /** Tóm tắt shot trước (chapter trước / beat trước). */
    previousBridge?: string;
    stylePrompt?: string;
  }
): SceneDraft[] {
  const text = narration.trim();
  if (!text) return [];
  const beatCap = Math.max(MIN_SCENE_BEAT_SEC, maxBeatSec);

  const sentences = text
    .split(/(?<=[.!?…。！？])\s+|(?<=[.!?…。！？])(?=[^\s])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  if (!sentences.length) {
    chunks.push(text);
  } else {
    let buf = '';
    for (const sentence of sentences) {
      const next = buf ? `${buf} ${sentence}` : sentence;
      const nextSec = estimateSpokenSeconds(next, 0);
      if (buf && nextSec > beatCap) {
        chunks.push(buf);
        buf = sentence;
      } else {
        buf = next;
      }
    }
    if (buf) chunks.push(buf);
  }

  // Gộp quá ngắn — với beat dài thì gộp đến ~60% typical để giảm số scene.
  const minKeepSec = Math.min(typicalBeatSec * 0.55, Math.max(MIN_SCENE_BEAT_SEC, beatCap * 0.35));
  const merged: string[] = [];
  for (const chunk of chunks) {
    const spoken = estimateSpokenSeconds(chunk, 0);
    if (merged.length && spoken < minKeepSec) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${chunk}`.trim();
    } else {
      merged.push(chunk);
    }
  }

  const cast = continuity?.seriesCast?.trim() || 'a cute cartoon animal mascot';

  // Đổi nhẹ góc máy / bối cảnh cho các beat liền nhau đỡ trùng khung. Giữ NGẮN.
  const cameraAngles = [
    'medium shot',
    'medium wide shot',
    'close-up',
    'three-quarter view',
  ];
  const setBases = [
    'simple playroom with soft blocks',
    'sunny grassy hill with a few trees',
    'plain pastel stage',
    'cozy room with rounded shelves',
  ];
  /** Hành động dự phòng khi narration rỗng — luôn là hành động đơn, dễ vẽ. */
  const fallbackActions = [
    'waving happily',
    'holding up a big colorful toy',
    'pointing at a simple shape',
    'jumping with joy',
  ];

  return merged.map((segment, index) => {
    // Ngắn hơn hẳn bản cũ (220 ký tự) và bỏ ngoặc kép.
    const excerpt = segment.replace(/\s+/g, ' ').replace(/["“”]/g, '').trim().slice(0, 90);
    const camera = cameraAngles[index % cameraAngles.length];
    const setBase = setBases[index % setBases.length];
    const action = excerpt ? `showing ${excerpt}` : fallbackActions[index % fallbackActions.length];

    // Mô tả NGẮN: một chủ thể + một hành động + một nền đơn giản.
    // Bản cũ ~150 chữ với 8 nhãn viết hoa (SUBJECT/PROP/CAMERA…) và narration trong
    // ngoặc kép — Veo Fast hoặc chặn, hoặc vẽ luôn chữ trong ngoặc lên màn hình.
    const base = `${cast} ${action}. ${setBase}, ${camera}, soft bounce.`;
    return {
      id: `scene-tmp-${index + 1}`,
      visual_prompt: base,
      narration_segment: segment,
      duration_hint: Math.max(
        MIN_SCENE_BEAT_SEC,
        Math.round(estimateSpokenSeconds(segment, typicalBeatSec) * 10) / 10
      ),
      section: chapter.section,
      chapter: chapter.name,
    };
  });
}

/** Gợi ý cast cố định từ brief/style — giúp mọi scene cùng nhân vật. */
function inferSeriesCastBrief(brief: string, stylePrompt?: string): string {
  const blob = `${brief} ${stylePrompt || ''}`.toLowerCase();
  if (/fox|cáo/.test(blob)) return 'a cute cartoon fox mascot as the recurring hero';
  if (/cat|mèo|kitty/.test(blob)) return 'a cute cartoon cat mascot as the recurring hero';
  if (/dog|puppy|chó/.test(blob)) return 'a cute cartoon puppy mascot as the recurring hero';
  if (/bear|gấu/.test(blob)) return 'a cute cartoon bear mascot as the recurring hero';
  if (/bunny|rabbit|thỏ/.test(blob)) return 'a cute cartoon bunny mascot as the recurring hero';
  if (/dino|dinosaur/.test(blob)) return 'a friendly cartoon dinosaur mascot as the recurring hero';
  if (/robot/.test(blob)) return 'a friendly round toy robot mascot as the recurring hero';
  if (/color|màu|số|number|alphabet|letter|animal|động vật/.test(blob)) {
    return 'one recurring cute animal teacher-mascot plus simple toy props matching each learning beat';
  }
  return 'one recurring cute animal or toy mascot hero (same face, colors, and proportions in every shot)';
}

/**
 * Post-process local: gắn cầu nối CONTINUATION giữa scene (không gọi API).
 */
function applyLocalVisualContinuity(
  scenes: SceneDraft[],
  options: { seriesCast: string; stylePrompt?: string }
): SceneDraft[] {
  if (scenes.length < 2) return scenes;
  const cast = options.seriesCast.trim();
  // Liên tục giữa các scene giờ do keyframe / video-extend lo (frame cuối scene trước
  // làm frame đầu scene sau). Nhồi thêm narration + "no hard cut" + style bible vào
  // prompt chỉ làm nó dài ra và dễ bị Veo chặn. Chỉ giữ một mệnh đề khóa nhân vật.
  return scenes.map((scene) => {
    const visual = (scene.visual_prompt || '').trim();
    if (!cast || visual.toLowerCase().includes(cast.toLowerCase().slice(0, 18))) return scene;
    return { ...scene, visual_prompt: `${cast} ${visual}`.replace(/\s+/g, ' ').trim() };
  });
}

/**
 * 1 lần gọi AI: viết lại visual_prompt toàn bộ scene thành chuỗi liền mạch (phù hợp video-extend).
 */
async function enrichVisualContinuityWithAi(options: {
  apiKey: string;
  openaiModel: string;
  title: string;
  brief: string;
  language?: string;
  stylePrompt: string;
  seriesCast: string;
  scenes: SceneDraft[];
}): Promise<SceneDraft[]> {
  const { scenes } = options;
  if (scenes.length < 2) return scenes;

  const sceneBlock = scenes
    .map((s, i) => {
      return (
        `Scene ${i + 1} [${s.id}] chapter=${s.chapter || '—'} section=${s.section || 'body'} ` +
        `duration_hint=${Math.max(2, s.duration_hint || 6)}s\n` +
        `narration: ${(s.narration_segment || '').trim()}\n` +
        `visual_now: ${(s.visual_prompt || '').trim().slice(0, 700)}`
      );
    })
    .join('\n\n');

  try {
    const parsed = await chatJson<{
      series_cast?: string;
      scenes?: Array<{ id?: string; visual_prompt?: string }>;
    }>({
      apiKey: options.apiKey,
      model: options.openaiModel,
      temperature: 0.4,
      maxTokens: Math.min(MAX_COMPLETION_TOKENS, Math.max(1200, scenes.length * 110)),
      system: `You rewrite ONLY visual_prompt fields into SHORT, SIMPLE shot descriptions for a preschool kids cartoon rendered by Google Veo.
Return ONLY JSON:
{
  "series_cast": string,
  "scenes": [ { "id": string, "visual_prompt": string } ]
}
HARD LENGTH LIMIT: each visual_prompt is English, 12–28 words, ONE sentence or two short ones. Longer prompts make Veo fail — brevity matters more than detail.
Each visual_prompt = the SAME cast (${options.seriesCast}) + ONE simple action matching the narration + ONE simple background.
Allowed extras (at most one each, only if useful): a simple framing word (medium shot / close-up / wide shot), one prop, one light word (sunny / warm).
NEVER include: continuity notes, OPENING/CONTINUATION labels, quotes of the narration, capitalised labels (SUBJECT:, CAMERA:…), lists of bans, style bibles, locale essays, words about text/logos/watermarks, camera move jargon (parallax, orbit, dolly), or ages / children / babies / real people.
Characters are always friendly cartoon animals or toys — never humans, never children.
Style to imply (do not quote it): ${options.stylePrompt.slice(0, 120)}
Do NOT change narration, duration, chapter, or section. Return one visual_prompt per input scene id.
Good example: "The orange fox mascot holds up a big red ball, medium shot, sunny grassy hill."
Bad example: a 100-word brief with labels, bans and continuity notes.`,
      user: `Title: ${options.title}
Brief: ${options.brief.slice(0, 400)}

${sceneBlock}

Rewrite one SHORT visual_prompt (12–28 words) per scene. Same cast every scene, simple actions, simple backgrounds.`,
    });

    const byId = new Map<string, string>();
    for (const row of parsed.scenes || []) {
      const id = String(row.id || '').trim();
      const vp = String(row.visual_prompt || '').trim();
      if (id && vp) byId.set(id, vp);
    }
    if (!byId.size) return scenes;

    return scenes.map((scene, index) => {
      const next = byId.get(scene.id) || byId.get(`scene-${String(index + 1).padStart(2, '0')}`);
      // Không gắn thêm "Recurring cast: …" nữa — AI đã lặp cast trong từng câu,
      // và wrapper sẽ cắt mọi chỉ thị kiểu này trước khi gửi Snapgen.
      return next ? { ...scene, visual_prompt: next } : scene;
    });
  } catch {
    return scenes;
  }
}

/**
 * Tạo script theo Chapter → Scene.
 * Tối ưu TPM: ít call hơn (bỏ AI split), chapter lớn hơn, retry 429, delay giữa call.
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
  const targetMediaCount = clampTargetSceneCount(targetDurationSec, plan.sceneCountHint);
  const totalBudget = spokenBudgetForDurationSec(targetDurationSec, input.language);
  const resolvedStyle = input.stylePrompt?.trim() || DEFAULT_STYLE_PROMPT;
  const styleHint = `Style: ${resolvedStyle}`;
  const seriesCast = inferSeriesCastBrief(input.brief, resolvedStyle);

  // —— Phase 1: outline (bỏ qua nếu video ngắn — dùng plan local) ——
  let title =
    input.brief.trim().split(/\n/)[0]?.slice(0, 80).trim() || 'Untitled Video';
  let chapters: ChapterOutline[];

  const skipOutlineApi = targetDurationSec <= 240;
  if (skipOutlineApi) {
    chapters = defaultChapterPlan(targetDurationSec);
  } else {
    const outlineSystem = `You plan a ${formatDurationLabel(targetDurationSec)} SIMPLE kids learning video outline (Pingpong / preschool style).
Return ONLY JSON:
{
  "title": string,
  "chapters": [
    { "name": string, "section": "introduction"|"body"|"conclusion", "targetSec": number, "summary": string }
  ]
}
Rules:
- Sum of targetSec MUST equal ${targetDurationSec}.
- Prefer chapters of ~${CHAPTER_CHUNK_SEC}s (range 70–110s). For listicles (colors, animals, numbers), each item can be its own chapter.
- Must include introduction, body (one or more), conclusion.
- Keep topics very simple for toddlers: one clear idea per chapter, friendly and playful.
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

Plan chapters for a ${targetDurationSec}s (${formatDurationLabel(targetDurationSec)}) kids video (~${totalBudget.amount} ${totalBudget.unitLabel} of speech).
${styleHint}`,
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
  const writeNarrationSystem = `You write spoken voiceover for ONE chapter of a SIMPLE kids learning video (Pingpong / preschool style).
Return ONLY JSON: { "narration": string } OR { "continuation": string }
Language: ${input.language}
Audience: toddlers / young children.
Voice: warm, friendly teacher or playful host — never scary, sarcastic, or complex.
Sentences: SHORT and clear (about 4–10 words each). Repeat key words gently for learning.
Story continuity: keep one recurring cast/idea across chapters so the video feels like one continuous journey, not disconnected clips.
No stage directions, no bullet points, no markdown, no on-screen text instructions.
Do NOT summarize. Aim for the exact word budget.
${styleHint}
Recurring cast hint: ${seriesCast}`;

  // Model đôi lúc nhả cả đề bài + đoạn lặp vô nghĩa vào chuỗi narration (JSON
  // vẫn hợp lệ nên parse qua được) → lọc ngay khi nhận, đừng để chảy xuống TTS.
  const cleanNarration = (raw: unknown): string =>
    sanitizeNarrationText(String(raw || ''), {
      dropForeignSentences: isCjkLanguage(input.language),
    });

  const previousNarrationTail: string[] = [];
  const chapterNarrations: Array<{ chapter: ChapterOutline; narration: string }> = [];

  for (let i = 0; i < chapters.length; i++) {
    if (i > 0) await sleep(INTER_CALL_DELAY_MS);

    const chapter = chapters[i];
    const budget = spokenBudgetForDurationSec(chapter.targetSec, input.language);
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
      const haveUnits = countSpokenBudgetUnits(narration, input.language);
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
${styleHint}

Chapter ${i + 1}/${chapters.length}: "${chapter.name}" (${chapter.section})
Summary: ${chapter.summary}
TIME: ${chapter.targetSec}s → write enough spoken content for ~${chapter.targetSec}s
Budget: ~${budget.amount} ${budget.unitLabel} (≥ ${minUnits} ${budget.unitLabel}).
${isCjkLanguage(input.language) ? 'This is a CJK language: count characters (not English-style space-separated words).' : ''}

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

  let allScenes: SceneDraft[] = [];
  let previousBridge = '';
  for (const { chapter, narration } of chapterNarrations) {
    const continuityOpts = {
      seriesCast,
      previousBridge,
      stylePrompt: resolvedStyle,
    };
    let chapterScenes = splitNarrationFallback(
      narration,
      chapter,
      plan.typicalBeatSec,
      input.language,
      plan.maxBeatSec,
      continuityOpts
    );
    if (needsBeatSplit(chapterScenes, plan.maxBeatSec)) {
      chapterScenes = splitNarrationFallback(
        chapterScenes.map((s) => s.narration_segment).join(' ') || narration,
        chapter,
        plan.typicalBeatSec,
        input.language,
        plan.maxBeatSec,
        continuityOpts
      );
    }
    allScenes.push(...chapterScenes);
    const lastNar = chapterScenes[chapterScenes.length - 1]?.narration_segment || '';
    previousBridge = lastNar.replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  // Ép số media ≤ mục tiêu (vd. 10 phút → 20 ảnh thay vì ~100).
  if (allScenes.length > targetMediaCount) {
    allScenes = coalesceScenesToTargetCount(allScenes, targetMediaCount);
  }

  allScenes = applyLocalVisualContinuity(allScenes, {
    seriesCast,
    stylePrompt: resolvedStyle,
  });

  let draft = finalizeDraft({ title, narration: '', scenes: allScenes }, targetDurationSec);

  // —— Phase 3: fill thiếu (tối đa 2 lần, rebuild scene local) ——
  for (
    let fill = 1;
    fill <= 2 && needsNarrationExpansion(draft.scenes, targetDurationSec);
    fill++
  ) {
    await sleep(INTER_CALL_DELAY_MS);
    const spoken = estimateScriptSpokenSeconds(draft.scenes);
    const deficitSec = Math.max(15, targetDurationSec - spoken);
    const deficitBudget = spokenBudgetForDurationSec(deficitSec, input.language);
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
    const rebuilt = splitNarrationFallback(
      targetChapter.narration,
      targetChapter.chapter,
      plan.typicalBeatSec,
      input.language,
      plan.maxBeatSec,
      { seriesCast, stylePrompt: resolvedStyle }
    );
    const nextScenes: SceneDraft[] = [];
    let replaced = false;
    for (const scene of draft.scenes) {
      if ((scene.chapter || '') === targetChapter.chapter.name) {
        if (!replaced) {
          nextScenes.push(...rebuilt);
          replaced = true;
        }
        continue;
      }
      nextScenes.push(scene);
    }
    if (!replaced) nextScenes.push(...rebuilt);
    let mergedScenes = nextScenes;
    if (mergedScenes.length > targetMediaCount) {
      mergedScenes = coalesceScenesToTargetCount(mergedScenes, targetMediaCount);
    }
    draft = finalizeDraft(
      { title: draft.title, narration: '', scenes: mergedScenes },
      targetDurationSec
    );
  }

  if (draft.scenes.length > targetMediaCount) {
    draft = finalizeDraft(
      {
        title: draft.title,
        narration: '',
        scenes: coalesceScenesToTargetCount(draft.scenes, targetMediaCount),
      },
      targetDurationSec
    );
  }

  assertNarrationCoversTarget(draft.scenes, targetDurationSec, MIN_NARRATION_COVERAGE);

  // —— Phase 4: liên kết visual_prompt toàn video (phù hợp chain-extend) ——
  draft.scenes = applyLocalVisualContinuity(draft.scenes, {
    seriesCast,
    stylePrompt: resolvedStyle,
  });
  await sleep(INTER_CALL_DELAY_MS);
  draft.scenes = await enrichVisualContinuityWithAi({
    apiKey,
    openaiModel,
    title: draft.title,
    brief: input.brief,
    language: input.language,
    stylePrompt: resolvedStyle,
    seriesCast,
    scenes: draft.scenes,
  });
  draft = finalizeDraft(
    { title: draft.title, narration: '', scenes: draft.scenes },
    targetDurationSec,
    { requireStructure: false }
  );

  return draft;
}

/**
 * Sau khi đo audio TTS lệch mục tiêu: AI rewrite narration rồi TTS lại.
 */
export async function rewriteNarrationToMatchDuration(options: {
  apiKey: string;
  openaiModel: string;
  script: ScriptDraft;
  language: string;
  targetDurationSec: number;
  actualAudioSec: number;
}): Promise<ScriptDraft> {
  const { apiKey, openaiModel, script, language, targetDurationSec, actualAudioSec } = options;
  const target = Math.max(1, targetDurationSec);
  const actual = Math.max(0.1, actualAudioSec);
  const ratio = target / actual;
  const tooShort = actual < target;

  const system = `You adjust voiceover length to match a measured TTS runtime for a SIMPLE kids learning video (Pingpong / preschool style).
Return ONLY valid JSON with scenes including section, chapter, visual_prompt, narration_segment, duration_hint.

Rules:
- Language: ${language}
- Prefer keeping the same chapters and scene ideas; you MAY split/merge slightly if needed for ${MIN_SCENE_BEAT_SEC}–${MAX_SCENE_BEAT_SEC}s beats.
- Scale spoken length ≈ ${ratio.toFixed(3)}× (${tooShort ? 'EXPAND' : 'COMPRESS'}).
- Narration: SHORT toddler-friendly sentences, warm playful host, repeat key learning words gently (~${WORDS_PER_SECOND} words/sec).
- One idea / one visual per scene. Continuous voiceover across scenes.
- visual_prompt: English, SHORT (12–28 words), same recurring cartoon animal/toy cast in every scene, ONE simple action matching the narration, ONE simple background. No labels, no continuity notes, no quoted narration, no ages/children/real people. Brevity matters — long prompts make Veo fail.`;

  const sceneLines = script.scenes
    .map((s, i) => {
      const planned = Math.max(2, s.duration_hint || 6);
      return `Scene ${i + 1} [${s.id}] chapter=${s.chapter || '—'} section=${s.section || 'body'} duration_hint=${planned}s\nvisual: ${s.visual_prompt}\nnarration: ${s.narration_segment}`;
    })
    .join('\n\n');

  const rewritten = await chatJson<ScriptDraft>({
    apiKey,
    model: openaiModel,
    system,
    maxTokens: Math.min(MAX_COMPLETION_TOKENS, Math.max(2800, Math.round(target * 55))),
    user: `Target voiceover: ${target}s (${formatDurationLabel(target)})
Measured TTS audio: ${actual.toFixed(2)}s (${formatDurationLabel(actual)})
Relative error: ${(((actual - target) / target) * 100).toFixed(1)}%
Action: ${tooShort ? 'LENGTHEN' : 'SHORTEN'} narration so a new TTS pass lands within ±3% of ${target}s.

Title: ${script.title}
${sceneLines}

Return the FULL rewritten JSON.`,
    temperature: 0.55,
  });

  if (rewritten.scenes?.length) {
    const dropForeignSentences = isCjkLanguage(language);
    rewritten.scenes = rewritten.scenes.map((scene) => ({
      ...scene,
      narration_segment: sanitizeNarrationText(scene.narration_segment || '', {
        dropForeignSentences,
      }),
    }));
  }

  return finalizeDraft(rewritten, target);
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
  });
  const targetMediaCount = clampTargetSceneCount(musicSec, plan.sceneCountHint);
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
- narration_segment = the lyric lines / vocal phrases that play during that scene (language: ${input.language}). Keep lyric wording faithful; you may lightly punctuate.
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
Language / lyric language: ${input.language}
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
