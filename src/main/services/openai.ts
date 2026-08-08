import type { GenerateIdeaInput, SceneDraft, SceneSection, ScriptDraft } from '../../shared/types';
import {
  assertNarrationCoversTarget,
  assertScenesNarrationFillDuration,
  countSpokenBudgetUnits,
  estimateScriptSpokenSeconds,
  estimateSpokenSeconds,
  familySupportsExtend,
  findScenesWithShortNarration,
  formatDurationLabel,
  isCjkLanguage,
  maxSingleShotDuration,
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

/** Chunk ~50s (~125 từ) — dễ viết đủ lời hơn chunk dài. */
const CHAPTER_CHUNK_SEC = 50;
const MAX_COMPLETION_TOKENS = 16384;
/** Số lần nối tiếp lời thoại khi chapter còn thiếu từ. */
const MAX_NARRATION_CONTINUATIONS = 6;

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

function needsBeatSplit(scenes: SceneDraft[]): boolean {
  return scenes.some(
    (s) => estimateSpokenSeconds(s.narration_segment || '', 0) > MAX_SCENE_BEAT_SEC
  );
}

async function chatJson<T>(options: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
}): Promise<T> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      temperature: options.temperature ?? 0.7,
      max_tokens: MAX_COMPLETION_TOKENS,
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
    throw new Error(data.error?.message || `OpenAI error HTTP ${res.status}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content.');
  if (data.choices?.[0]?.finish_reason === 'length') {
    throw new Error(
      'OpenAI cắt response vì quá dài (finish_reason=length). Thử model lớn hơn hoặc rút ngắn thời lượng.'
    );
  }

  return extractJson(content) as T;
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


/** Chia narration thành scene theo câu khi AI cắt mất lời. */
function splitNarrationFallback(
  narration: string,
  chapter: ChapterOutline,
  typicalBeatSec: number,
  language?: string
): SceneDraft[] {
  const text = narration.trim();
  if (!text) return [];

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
      if (buf && nextSec > MAX_SCENE_BEAT_SEC) {
        chunks.push(buf);
        buf = sentence;
      } else {
        buf = next;
      }
    }
    if (buf) chunks.push(buf);
  }

  // Gộp quá ngắn
  const merged: string[] = [];
  for (const chunk of chunks) {
    const spoken = estimateSpokenSeconds(chunk, 0);
    if (merged.length && spoken < MIN_SCENE_BEAT_SEC) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${chunk}`.trim();
    } else {
      merged.push(chunk);
    }
  }

  const locale = resolveVisualLocaleHint(language);
  const languageLock = resolveVisualLanguageLock(language);
  return merged.map((segment, index) => {
    const excerpt = segment.replace(/\s+/g, ' ').trim().slice(0, 200);
    const base =
      `Detailed cinematic still for chapter "${chapter.name}", beat ${index + 1}: ` +
      `illustrate this spoken idea — "${excerpt}". ` +
      `Show a specific subject with clear age, expression, and clothing; a concrete location and time of day; ` +
      `motivated lighting; medium or wide framing with intentional camera angle; cohesive color mood.`;
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

/**
 * Tạo script theo Chapter → Scene.
 * Mỗi chapter: viết narration văn xuôi đủ từ trước → mới tách scene (tránh caption ngắn trong JSON).
 */
export async function generateScript(
  apiKey: string,
  openaiModel: string,
  input: GenerateIdeaInput
): Promise<ScriptDraft> {
  const isImage = input.mediaKind === 'image';
  const plan = planScenesFromDuration(input.targetDurationSec);
  const targetDurationSec = plan.targetDurationSec;
  const maxShot =
    input.maxShotSec ?? maxSingleShotDuration(input.model) ?? plan.typicalBeatSec;
  const canExtend = !isImage && familySupportsExtend(String(input.family));
  const totalBudget = spokenBudgetForDurationSec(targetDurationSec, input.language);

  const styleLine = input.stylePrompt?.trim()
    ? `- Global visual style (MUST apply to every visual_prompt): ${input.stylePrompt.trim()}`
    : '- Keep visual continuity across scenes.';

  const localeHint = resolveVisualLocaleHint(input.language);
  const languageLock = resolveVisualLanguageLock(input.language);
  const visualRule = isImage
    ? '- visual_prompt: ONE detailed still frame (not a collage). Rich enough for an image model to render without guessing.'
    : '- visual_prompt: ONE detailed primary shot/action per scene. Hard cut between scenes. Rich enough for image/video models.';

  const sharedRules = `Language for narration: ${input.language}
${visualRule}
${styleLine}
VISUAL FIDELITY (critical — image/video must match the script AND the selected Language):
- Write visual_prompt in clear English (best for image models), but the CONTENT must always follow Language "${input.language}".
- visual_prompt MUST depict the SAME people/objects/places as narration_segment: age, gender, role, ethnicity/nationality, clothing, setting, action.
- Selected language "${input.language}" locks culture AND on-image text.${localeHint ? ` Locale rule: ${localeHint}.` : ''}
- ${languageLock}
- Every visual_prompt must explicitly mention the selected language/culture (e.g. Japanese setting / Vietnamese characters) so image models cannot drift to another language.
- Example: narration about an elderly Japanese person → "Elderly Japanese man/woman …" in a Japanese setting with Japanese-only text if any — NEVER a young Western character or English/Chinese signs.
- Do NOT invent a different character, age, or culture than the spoken content.
VISUAL DETAIL (mandatory — avoid short vague prompts like "a person in a city"):
- Length: about 45–90 English words (2–4 concrete sentences). Pack specifics, not fluff.
- Subject: exact age range, gender, ethnicity matching Language, facial expression, pose/gesture, clothing materials/colors, hair.
- Environment: specific place (street type, room, landscape), time of day, weather if relevant, background props tied to the narration.
- Light & camera: lighting direction/quality (soft window light, neon night, overcast…), camera framing (extreme close-up / medium / wide), angle (eye-level, low, high), shallow or deep depth of field.
- Mood & palette: atmosphere + dominant colors that fit the beat (warm amber, cool steel, muted earth…).
- Keep ONE coherent composition; no multi-panel, no text dump of the full narration.
- Each scene = ONE main idea OR ONE primary visual (~${MIN_SCENE_BEAT_SEC}–${MAX_SCENE_BEAT_SEC}s spoken, ideal ~${plan.typicalBeatSec}s).
- duration_hint ≈ spoken length of narration_segment (~${WORDS_PER_SECOND} words/sec).
- Narration is continuous voiceover across scenes; write full host sentences, not captions.
${isImage ? '' : `- Model max shot / extend chunk: ${maxShot}s (${canExtend ? 'extend ok' : 'multi-cut'})`}
Media: ${input.mediaKind} · ${input.family}/${input.model} · ${input.aspectRatio} · ${input.resolution}`;

  // —— Phase 1: outline chapters ——
  const outlineSystem = `You plan a ${formatDurationLabel(targetDurationSec)} video script outline.
Return ONLY JSON:
{
  "title": string,
  "chapters": [
    { "name": string, "section": "introduction"|"body"|"conclusion", "targetSec": number, "summary": string }
  ]
}
Rules:
- Sum of targetSec MUST equal ${targetDurationSec}.
- Prefer chapters of ~${CHAPTER_CHUNK_SEC}s (range 40–60s). For listicles, each list item can be its own chapter.
- Must include introduction, body (one or more), conclusion.
- Do NOT write full narration yet — only chapter plan.`;

  let title = 'Untitled Video';
  let chapters: ChapterOutline[];
  try {
    const outline = await chatJson<{ title?: string; chapters?: Array<Partial<ChapterOutline>> }>({
      apiKey,
      model: openaiModel,
      system: outlineSystem,
      user: `Brief / topic: ${input.brief}

Plan chapters for a ${targetDurationSec}s (${formatDurationLabel(targetDurationSec)}) video (~${totalBudget.amount} ${totalBudget.unitLabel} of speech).
${input.stylePrompt?.trim() ? `Style: ${input.stylePrompt.trim()}` : ''}`,
      temperature: 0.6,
    });
    title = String(outline.title || '').trim() || title;
    chapters = normalizeOutline(outline.chapters, targetDurationSec);
  } catch {
    chapters = defaultChapterPlan(targetDurationSec);
  }

  // —— Phase 2a: narration văn xuôi đủ từ ——
  const writeNarrationSystem = `You write spoken voiceover for ONE video chapter.
Return ONLY JSON: { "narration": string } OR { "continuation": string }
Language: ${input.language}
Write natural host speech. No stage directions, no bullet points, no markdown.
Do NOT summarize. Aim for the exact word budget.`;

  const previousNarrationTail: string[] = [];
  const chapterNarrations: Array<{ chapter: ChapterOutline; narration: string }> = [];

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const budget = spokenBudgetForDurationSec(chapter.targetSec, input.language);
    const minUnits = Math.round(budget.amount * MIN_NARRATION_COVERAGE);
    const minSec = chapter.targetSec * MIN_NARRATION_COVERAGE;
    const prevContext =
      previousNarrationTail.length > 0
        ? `Continue smoothly after this ending (do not repeat):\n"""${previousNarrationTail[previousNarrationTail.length - 1].slice(-400)}"""`
        : 'This is the opening of the video.';

    let narration = '';
    for (let attempt = 1; attempt <= MAX_NARRATION_CONTINUATIONS; attempt++) {
      const spokenSec = estimateSpokenSeconds(narration, 0);
      const haveUnits = countSpokenBudgetUnits(narration, input.language);
      if (spokenSec >= minSec && haveUnits >= minUnits * 0.7) break;
      const needMore = Math.max(0, minUnits - haveUnits);

      if (!narration) {
        const parsed = await chatJson<{ narration?: string }>({
          apiKey,
          model: openaiModel,
          system: writeNarrationSystem,
          user: `Video title: ${title}
Brief: ${input.brief}

Chapter ${i + 1}/${chapters.length}: "${chapter.name}" (${chapter.section})
Summary: ${chapter.summary}
TIME: ${chapter.targetSec}s → write enough spoken content for ~${chapter.targetSec}s
Budget: ~${budget.amount} ${budget.unitLabel} (≥ ${minUnits} ${budget.unitLabel}).
${isCjkLanguage(input.language) ? 'This is a CJK language: count characters (not English-style space-separated words).' : ''}

${prevContext}

Return JSON: { "narration": "<full spoken script for this chapter only>" }`,
          temperature: 0.75,
        });
        narration = String(parsed.narration || '').trim();
      } else {
        const parsed = await chatJson<{ continuation?: string; narration?: string }>({
          apiKey,
          model: openaiModel,
          system: writeNarrationSystem,
          user: `Chapter "${chapter.name}" is TOO SHORT: ~${formatDurationLabel(spokenSec)} / ${chapter.targetSec}s (${haveUnits}/${minUnits} ${budget.unitLabel}).

Already written (keep all of it, then CONTINUE):
"""${narration}"""

Return JSON: { "continuation": "<only the NEW sentences to append, add ~${needMore} ${budget.unitLabel}>" }
Do not restart. Do not summarize the previous text.`,
          temperature: 0.8,
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

  // —— Phase 2b: tách narration → scenes ——
  const splitSystem = `You split ONE chapter's voiceover into visual scenes.
Return ONLY JSON:
{
  "scenes": [
    {
      "id": string,
      "section": "introduction"|"body"|"conclusion",
      "chapter": string,
      "visual_prompt": string,
      "narration_segment": string,
      "duration_hint": number
    }
  ]
}
${sharedRules}
CRITICAL: Concatenating all narration_segment MUST preserve the given narration (same words, same order). Do NOT shorten. Slice at natural beats (~${MIN_SCENE_BEAT_SEC}–${MAX_SCENE_BEAT_SEC}s each).`;

  const allScenes: SceneDraft[] = [];

  for (const { chapter, narration } of chapterNarrations) {
    const sceneHint = Math.max(3, Math.round(chapter.targetSec / plan.typicalBeatSec));
    let chapterScenes: SceneDraft[] = [];
    try {
      const parsed = await chatJson<{ scenes?: SceneDraft[] }>({
        apiKey,
        model: openaiModel,
        system: splitSystem,
        user: `Chapter "${chapter.name}" · section=${chapter.section} · ~${sceneHint} scenes
Language setting (LOCKED for all visuals): ${input.language}${localeHint ? `\nLocale for visuals: ${localeHint}` : ''}
Language lock: ${languageLock}
Full narration to split (preserve EVERY word across segments):
"""${narration}"""

For EACH scene: write a DETAILED visual_prompt (45–90 English words) that mirrors THAT narration_segment — subject (age/gender/expression/clothing), environment, lighting, camera framing/angle, mood/palette — AND stays inside Language "${input.language}" only (no other-language text in the image). Do NOT write short one-liners. All scenes.chapter="${chapter.name}", scenes.section="${chapter.section}".`,
        temperature: 0.4,
      });
      chapterScenes = mapRawScenes(parsed.scenes || []).map((s) => ({
        ...s,
        chapter: chapter.name,
        section: chapter.section,
      }));
    } catch {
      chapterScenes = [];
    }

    const joined = chapterScenes.map((s) => s.narration_segment || '').join(' ').trim();
    const srcSec = estimateSpokenSeconds(narration, 0);
    const outSec = estimateSpokenSeconds(joined, 0);
    if (!chapterScenes.length || outSec < srcSec * 0.85) {
      chapterScenes = splitNarrationFallback(
        narration,
        chapter,
        plan.typicalBeatSec,
        input.language
      );
    }

    if (needsBeatSplit(chapterScenes)) {
      const full = chapterScenes.map((s) => s.narration_segment).join(' ') || narration;
      chapterScenes = splitNarrationFallback(
        full,
        chapter,
        plan.typicalBeatSec,
        input.language
      );
    }

    allScenes.push(...chapterScenes);
  }

  let draft = finalizeDraft({ title, narration: '', scenes: allScenes }, targetDurationSec);

  // —— Phase 3: nếu tổng vẫn thiếu → nối lời vào body chapters đến khi đủ ——
  for (let fill = 1; fill <= 4 && needsNarrationExpansion(draft.scenes, targetDurationSec); fill++) {
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
Existing:
"""${targetChapter.narration}"""

Return { "continuation": "<new sentences only, ≥ ${deficitBudget.amount} ${deficitBudget.unitLabel}>" }`,
      temperature: 0.85,
    });
    const extra = String(parsed.continuation || '').trim();
    if (!extra) continue;

    targetChapter.narration = `${targetChapter.narration} ${extra}`.trim();
    const rebuilt = splitNarrationFallback(
      targetChapter.narration,
      targetChapter.chapter,
      plan.typicalBeatSec,
      input.language
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
    draft = finalizeDraft(
      { title: draft.title, narration: '', scenes: nextScenes },
      targetDurationSec
    );
  }

  assertNarrationCoversTarget(draft.scenes, targetDurationSec, MIN_NARRATION_COVERAGE);
  assertScenesNarrationFillDuration(draft.scenes, MIN_NARRATION_COVERAGE);
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

  const system = `You adjust voiceover length to match a measured TTS runtime.
Return ONLY valid JSON with scenes including section, chapter, visual_prompt, narration_segment, duration_hint.

Rules:
- Language: ${language}
- Prefer keeping the same chapters and scene ideas; you MAY split/merge slightly if needed for ${MIN_SCENE_BEAT_SEC}–${MAX_SCENE_BEAT_SEC}s beats.
- Scale spoken length ≈ ${ratio.toFixed(3)}× (${tooShort ? 'EXPAND' : 'COMPRESS'}).
- Narration must naturally fill each scene duration (~${WORDS_PER_SECOND} words/sec).
- One idea / one visual per scene. Continuous voiceover across scenes.
- visual_prompt MUST stay faithful to narration_segment (same age, person, culture, setting) AND Language "${language}" only.${localeHint ? ` ${localeHint}.` : ''}
- When rewriting, KEEP or IMPROVE visual_prompt detail (subject, environment, lighting, camera, mood) — about 45–90 English words; never collapse into a vague one-liner.
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
