import type {
  GenerateIdeaInput,
  GenerateMusicAnimationScriptInput,
  SceneDraft,
  SceneSection,
  ScriptDraft,
} from '../../shared/types';
import {
  assertNarrationCoversTarget,
  clampTargetSceneCount,
  coalesceScenesToTargetCount,
  countSpokenBudgetUnits,
  DEFAULT_STYLE_PROMPT,
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
  resolveVisualLanguageLock,
  resolveVisualLocaleHint,
  spokenBudgetForDurationSec,
  WORDS_PER_SECOND,
} from '../../shared/models';

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

  const locale = resolveVisualLocaleHint(language);
  const languageLock = resolveVisualLanguageLock(language);
  const cast =
    continuity?.seriesCast?.trim() ||
    'the same recurring cute animal or toy mascot cast throughout the video';
  const styleBit = continuity?.stylePrompt?.trim()
    ? `Style bible: ${continuity.stylePrompt.trim().slice(0, 320)}.`
    : '';

  // Camera / lighting rotate lightly so adjacent beats stay linked but not identical frames.
  const cameraAngles = [
    'medium shot, eye-level, gentle slow push-in',
    'slightly low angle medium shot, soft parallax drift left',
    'medium-wide shot, slow orbit-lite pan right',
    'close-medium on face and hands/paws presenting the prop, subtle bob',
    'three-quarter view, soft push-out revealing the simple set',
  ];
  const lightMoods = [
    'warm sunny key light from upper-left, soft pastel fill, cheerful highlights',
    'bright even classroom-toy lighting, soft shadows, candy-color bounce',
    'golden morning glow, gentle rim light on the mascot silhouette',
    'clean studio-toy light with soft sky-blue ambient fill',
  ];
  const setBases = [
    'simple rounded playroom set with oversized soft blocks and a clean sky gradient',
    'minimal outdoor hill with soft clouds and a few toy trees',
    'cozy toy classroom with rounded shelves and blank colorful shapes (no letters)',
    'open pastel stage with soft floor circle and floating bubbles',
  ];

  return merged.map((segment, index) => {
    const excerpt = segment.replace(/\s+/g, ' ').trim().slice(0, 220);
    const nextExcerpt =
      index < merged.length - 1
        ? merged[index + 1].replace(/\s+/g, ' ').trim().slice(0, 120)
        : '';
    const prevExcerpt =
      index === 0
        ? (continuity?.previousBridge || '').replace(/\s+/g, ' ').trim().slice(0, 160)
        : merged[index - 1].replace(/\s+/g, ' ').trim().slice(0, 120);

    const linkLine =
      index === 0 && !prevExcerpt
        ? `OPENING beat of a continuous sequence: clearly establish ${cast} (same face shape, fur/fabric colors, eye style, and proportions that must repeat every shot) in a friendly readable set.`
        : prevExcerpt
          ? `CONTINUATION beat (seamless from previous shot about "${prevExcerpt}"): keep IDENTICAL cast design, wardrobe, palette, proportions, and camera language — soft motion bridge from the last pose, no hard cut, no redesign.`
          : `CONTINUATION beat: keep IDENTICAL cast, palette, and camera language — soft motion bridge, no hard cut.`;

    const nextLine = nextExcerpt
      ? ` End the shot mid-action so it can flow into the next beat about "${nextExcerpt}".`
      : ' End on a gentle satisfied pose that can close the sequence.';

    const camera = cameraAngles[index % cameraAngles.length];
    const lighting = lightMoods[index % lightMoods.length];
    const setBase = setBases[index % setBases.length];

    const base =
      `${linkLine} ` +
      `Chapter "${chapter.name}", beat ${index + 1}/${merged.length}. ` +
      `Story beat to visualize (match narration precisely): "${excerpt}". ` +
      `SUBJECT: ${cast}; big friendly eyes, rounded soft body, expressive eyebrows, clear silhouette; ` +
      `pose and gesture must act out the spoken idea (point, hold, present, bounce, react). ` +
      `PROP / FOCUS OBJECT: one oversized simple toy object that represents the learning idea in this line ` +
      `(bright primary color, smooth plastic/felt look, no logos, no readable text). ` +
      `ENVIRONMENT: ${setBase}; uncluttered, shallow depth, 2–4 background shapes max, consistent world across shots. ` +
      `ACTION / MOTION: gentle playful bounce and squash, small secondary motion on ears/tail/scarf; ` +
      `smooth 1–2 second gesture cycle, no chaotic cuts inside the shot. ` +
      `CAMERA: ${camera}. ` +
      `LIGHTING & COLOR: ${lighting}; saturated but soft Pingpong kids-cartoon palette, flat shading with soft gradients, rounded edges. ` +
      `COMPOSITION: subject centered or rule-of-thirds, prop readable, negative space clean. ` +
      `${styleBit}${nextLine} ` +
      `STRICT: no readable text, letters, numbers-as-glyphs, subtitles, UI, watermarks; never depict real children or babies.`;
    const withLocale = locale ? `${base} ${locale}.` : base;
    return {
      id: `scene-tmp-${index + 1}`,
      visual_prompt: `${withLocale} ${languageLock}`,
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
  const cast = options.seriesCast;
  return scenes.map((scene, index) => {
    const prevNar =
      index > 0
        ? (scenes[index - 1].narration_segment || '').replace(/\s+/g, ' ').trim().slice(0, 90)
        : '';
    const nextNar =
      index < scenes.length - 1
        ? (scenes[index + 1].narration_segment || '').replace(/\s+/g, ' ').trim().slice(0, 90)
        : '';
    let visual = (scene.visual_prompt || '').trim();
    const lower = visual.toLowerCase();
    if (!lower.includes('continuation') && !lower.includes('opening beat')) {
      const bridge =
        index === 0
          ? `OPENING of a continuous kids-cartoon sequence with ${cast}.`
          : `CONTINUATION from previous narration "${prevNar}": same cast (${cast}), same style, seamless soft transition, no hard cut.`;
      const tail = nextNar
        ? ` Leave motion ready for next beat "${nextNar}".`
        : ' Gentle closing energy for sequence end.';
      visual = `${bridge} ${visual}${tail}`.trim();
    } else if (cast && !lower.includes('recurring') && !lower.includes(cast.slice(0, 24).toLowerCase())) {
      visual = `${visual} Recurring cast: ${cast}.`;
    }
    if (options.stylePrompt?.trim() && !lower.includes('style bible')) {
      visual = `${visual} Style bible: ${options.stylePrompt.trim().slice(0, 180)}.`;
    }
    return { ...scene, visual_prompt: visual };
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

  const localeHint = resolveVisualLocaleHint(options.language);
  const languageLock = resolveVisualLanguageLock(options.language);
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
      temperature: 0.5,
      maxTokens: Math.min(MAX_COMPLETION_TOKENS, Math.max(3200, scenes.length * 380)),
      system: `You rewrite ONLY visual_prompt fields into RICH, DETAILED shot briefs for a continuous kids animated video (Snapgen video-extend / ref_history chaining).
Return ONLY JSON:
{
  "series_cast": string,
  "scenes": [ { "id": string, "visual_prompt": string } ]
}
Rules:
- Keep the SAME recurring cast in every shot: ${options.seriesCast}
- Scene 1 = OPENING establishing shot; Scene 2+ = CONTINUATION from the previous shot (identical character design, wardrobe, palette, proportions, camera language, soft motion bridge, NO hard cut, NO redesign).
- Each visual_prompt MUST be English, ONE shot, highly detailed, about 110–160 words, and explicitly cover ALL of:
  1) continuity link (OPENING / CONTINUATION + what carries over),
  2) subject design (species/toy type, colors, face, size, expression),
  3) exact action/gesture matching the narration beat,
  4) hero prop/object (material, color, size, how it is held/shown),
  5) environment layers (foreground / mid / background, keep world simple but concrete),
  6) camera (framing + slow move),
  7) lighting + color palette,
  8) motion quality (bounce, timing),
  9) end-pose bridge into the next beat,
  10) bans: no readable text/letters/numbers-glyphs/UI/subtitles; never depict real children or babies.
- Pingpong-simple kids cartoon: bright flat colors, soft rounded shapes, clean uncluttered set — detailed description, NOT cluttered art.
- Style: ${options.stylePrompt.slice(0, 360)}
${localeHint ? `- Locale: ${localeHint}` : ''}
- Include this lock idea: ${languageLock.slice(0, 240)}
- Do NOT change narration, duration, chapter, or section. Return one visual_prompt per input scene id.
- Never write vague one-liners like "cute scene of learning". Every prompt must be production-ready for image/video gen.`,
      user: `Title: ${options.title}
Brief: ${options.brief.slice(0, 900)}

${sceneBlock}

Rewrite a DETAILED visual_prompt for every scene so they chain seamlessly and are specific enough for Snapgen.`,
    });

    const byId = new Map<string, string>();
    for (const row of parsed.scenes || []) {
      const id = String(row.id || '').trim();
      const vp = String(row.visual_prompt || '').trim();
      if (id && vp) byId.set(id, vp);
    }
    if (!byId.size) return scenes;

    const cast = String(parsed.series_cast || options.seriesCast).trim();
    return scenes.map((scene, index) => {
      const next = byId.get(scene.id) || byId.get(`scene-${String(index + 1).padStart(2, '0')}`);
      if (!next) return scene;
      let visual = next;
      if (cast && !visual.toLowerCase().includes('recurring') && !visual.toLowerCase().includes('cast')) {
        visual = `${visual} Recurring cast: ${cast}.`;
      }
      return { ...scene, visual_prompt: visual };
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
        narration = String(parsed.narration || '').trim();
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
        const extra = String(parsed.continuation || parsed.narration || '').trim();
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
    const extra = String(parsed.continuation || '').trim();
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
  const localeHint = resolveVisualLocaleHint(language);
  const languageLock = resolveVisualLanguageLock(language);

  const system = `You adjust voiceover length to match a measured TTS runtime for a SIMPLE kids learning video (Pingpong / preschool style).
Return ONLY valid JSON with scenes including section, chapter, visual_prompt, narration_segment, duration_hint.

Rules:
- Language: ${language}
- Prefer keeping the same chapters and scene ideas; you MAY split/merge slightly if needed for ${MIN_SCENE_BEAT_SEC}–${MAX_SCENE_BEAT_SEC}s beats.
- Scale spoken length ≈ ${ratio.toFixed(3)}× (${tooShort ? 'EXPAND' : 'COMPRESS'}).
- Narration: SHORT toddler-friendly sentences, warm playful host, repeat key learning words gently (~${WORDS_PER_SECOND} words/sec).
- One idea / one visual per scene. Continuous voiceover across scenes.
- visual_prompt MUST stay faithful to narration_segment AND chain across scenes: Scene 1 OPENING; Scene 2+ CONTINUATION from previous shot with the SAME recurring cast design, palette, and camera language (soft bridge, no hard cut). Write DETAILED English visual_prompt (110–160 words) covering subject design, action, prop, environment, camera, lighting, motion, and end-pose bridge. Cute animal/toy mascots, bright flat Pingpong kids-cartoon look, no readable text, never depict real children or babies.${localeHint ? ` ${localeHint}.` : ''}
- When rewriting, KEEP or IMPROVE visual_prompt detail — never collapse into a vague one-liner.
- ${languageLock}`;

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
    ? `Global animated style (apply every visual_prompt): ${input.stylePrompt.trim()}`
    : 'Animated music video look (anime/illustration cinematic), vivid, beat-synced staging.';
  const characterLine = input.characterBrief?.trim()
    ? `Character continuity: ${input.characterBrief.trim()}`
    : characterImages?.length
      ? 'Character continuity: match the uploaded character reference image(s) consistently across scenes.'
      : 'Characters may be original if none uploaded — keep cast consistent across scenes.';

  // Ảnh tĩnh không zoom/pan nữa → mô tả camera move là vô nghĩa, phải yêu cầu
  // bố cục một khung đứng vững thay vì "camera pushes in".
  const isStill = input.mediaKind === 'image';
  const shotLine = isStill
    ? 'visual_prompt = ONE STILL KEY FRAME in English (90–140 words): subject design, pose/gesture at the emotional peak of the lyric, hero prop, foreground/midground/background layers, shot size (wide|medium|close-up — VARY it between consecutive scenes), lighting, palette. NO camera-movement wording (no pan/zoom/dolly/tracking/handheld) — the frame is held still. No multi-panel, no readable text.'
    : 'visual_prompt = ONE DETAILED animated shot in English (110–160 words): subject design, action synced to lyric mood, hero prop, environment layers, camera move, lighting, palette, motion quality. Scene 1 establishes cast; later scenes CONTINUATION from previous shot (same character/style, soft bridge for chain-extend). No multi-panel, no readable text.';

  const system = `You are a music-video storyboard director for AI video generation (Snapgen).
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
      "duration_hint": number,
      "narration_segment": string,
      "visual_prompt": string
    }
  ]
}
Rules:
- Total of duration_hint MUST equal ${musicSec} (±2s ok).
- HARD LIMIT: return about ${targetMediaCount} scenes (range ${Math.max(3, targetMediaCount - 2)}–${targetMediaCount + 2}). Typical beat ~${plan.typicalBeatSec}s (max ~${plan.maxBeatSec}s). Do NOT create one scene per lyric line if that exceeds the limit — group lines.
- narration_segment = the lyric lines / vocal phrases that play during that scene (language: ${input.language}). Keep lyric wording faithful; you may lightly punctuate.
- ${shotLine}
- cast_lock = a 30–50 word ENGLISH cast + world bible naming EVERY recurring character with fixed, re-drawable traits (age, hair colour & cut, eye colour, exact outfit, one signature accessory) plus the fixed world palette. Concrete nouns only, no story, no adjectives like "beautiful". Every scene is generated independently, so this text is what keeps the characters identical.
- Every visual_prompt must refer to characters by the SAME names used in cast_lock (never "a girl" / "the singer" if the cast has a name).
- Sync energy: slow/emotional lines → intimate framing, softer light; chorus → wider staging / stronger colour.
- SAFETY (Google blocks these outright — a blocked scene costs the user a failed render): never write children, babies, toddlers, teenagers or school pupils as characters. For nursery-rhyme / kids songs use friendly ANIMAL or TOY mascots instead, or adult characters. Never name or describe real people, celebrities or public figures, never use copyrighted or branded characters (Disney, Pokémon, superheroes…), never put brand logos in frame. This applies to cast_lock and to every visual_prompt.
- ${styleLine}
- ${characterLine}
- section: intro/body/outro structure across the song.
- Media: ${input.mediaKind} · ${input.family}/${input.model} · ${input.aspectRatio} · ${input.resolution}`;

  const userText = `Song duration: ${musicSec}s (${formatDurationLabel(musicSec)})
Target media count: ~${targetMediaCount} scenes (~${plan.typicalBeatSec}s each)
Language / lyric language: ${input.language}
${input.songTitle ? `Title hint: ${input.songTitle}` : ''}

LYRICS / SCRIPT:
"""
${input.lyricText.trim()}
"""

Plan an animated music-video storyboard that fits the song length exactly within the media-count budget.`;

  const model = openaiModel.trim() || 'gpt-4o-mini';
  type MusicScriptResponse = {
    title?: string;
    notes?: string;
    cast_lock?: string;
    scenes?: Array<Partial<SceneDraft>>;
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
      section: normalizeSection(s.section) || (i === 0 ? 'introduction' : 'body'),
      chapter: normalizeChapter(s.chapter) || `Beat ${i + 1}`,
    }))
    .filter((s) => s.visual_prompt || s.narration_segment);

  if (!scenes.length) {
    throw new Error('ChatGPT không trả về scene nào từ lyric.');
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
