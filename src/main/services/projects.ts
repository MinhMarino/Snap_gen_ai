import fs from 'node:fs';
import path from 'node:path';
import { getProjectsRoot, getSettings } from '../store';
import { isJobActive } from '../job-state';
import {
  mediaExtFor,
  resolveSceneMedia,
  sceneMediaDir,
  sceneMediaTarget,
} from './scene-media';
import type {
  CreateProjectInput,
  MediaKind,
  ProjectDetail,
  ProjectDraft,
  ProjectMeta,
  ProjectStatus,
  ScriptDraft,
  VideoFamily,
  ImageFamily,
} from '../../shared/types';
import { resolveProjectKind } from '../../shared/types';
import {
  DEFAULT_DURATION_PER_SCENE,
  defaultFamilyForKind,
  defaultModelIdForKind,
  defaultStylePromptForProjectKind,
  getModelById,
} from '../../shared/models';
import { resolveProjectChatModel, resolveProjectVoice, projectDraftHasVoice } from '../../shared/voice';

const META_FILE = 'meta.json';
const DRAFT_FILE = 'draft.json';
const DEFAULT_TARGET_DURATION_SEC = 60;

function resolveTargetDurationSec(
  raw: Partial<ProjectDraft>,
  sceneCount: number
): number {
  if (typeof raw.targetDurationSec === 'number' && raw.targetDurationSec > 0) {
    return Math.round(raw.targetDurationSec);
  }
  const fromScript = raw.script?.scenes?.reduce(
    (sum, scene) => sum + (Number(scene.duration_hint) || 0),
    0
  );
  if (fromScript && fromScript > 0) return Math.round(fromScript);
  return Math.max(
    DEFAULT_DURATION_PER_SCENE,
    sceneCount * DEFAULT_DURATION_PER_SCENE
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'project'
  );
}

function projectDir(id: string): string {
  return path.join(getProjectsRoot(), id);
}

function metaPath(id: string): string {
  return path.join(projectDir(id), META_FILE);
}

function draftPath(id: string): string {
  return path.join(projectDir(id), DRAFT_FILE);
}

function readMeta(id: string): ProjectMeta | null {
  const p = metaPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ProjectMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: ProjectMeta): void {
  const dir = projectDir(meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8');
}

function readDraft(id: string): ProjectDraft | null {
  const p = draftPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ProjectDraft>;
    const sceneCount = raw.sceneCount ?? 3;
    const mediaKind = raw.mediaKind ?? 'video';
    const voice = resolveProjectVoice(raw, getSettings());
    const settings = getSettings();
    const projectKind = resolveProjectKind(raw.projectKind);
    const draft: ProjectDraft = {
      projectKind,
      brief: raw.brief ?? '',
      language: raw.language,
      sceneCount,
      targetMediaCount:
        typeof raw.targetMediaCount === 'number' && raw.targetMediaCount > 0
          ? Math.round(raw.targetMediaCount)
          : undefined,
      sceneDensity: raw.sceneDensity,
      targetDurationSec: resolveTargetDurationSec(raw, sceneCount),
      family: raw.family ?? defaultFamilyForKind(mediaKind),
      model: raw.model ?? defaultModelIdForKind(mediaKind),
      aspectRatio: raw.aspectRatio ?? '16:9',
      resolution:
        raw.resolution ?? getModelById(defaultModelIdForKind(mediaKind))?.defaultResolution ?? '720p',
      mode: raw.mode,
      script: raw.script ?? null,
      mediaKind,
      stylePrompt: raw.stylePrompt ?? defaultStylePromptForProjectKind(projectKind),
      openaiChatModel: resolveProjectChatModel(raw.openaiChatModel, settings.openaiModel),
      outputFormat: raw.outputFormat,
      lyricText: String(raw.lyricText || ''),
      musicRelativePath: raw.musicRelativePath?.trim() || undefined,
      characterRelativePaths: Array.isArray(raw.characterRelativePaths)
        ? raw.characterRelativePaths.map(String).filter(Boolean)
        : [],
      musicStoryNotes: String(raw.musicStoryNotes || ''),
      musicCastLock: String(raw.musicCastLock || ''),
      ...voice,
    };
    // Dự án cũ chưa có voice / chat model → snapshot vào draft một lần.
    if (!projectDraftHasVoice(raw) || !raw.openaiChatModel) {
      writeDraft(id, draft);
    }
    return draft;
  } catch {
    return null;
  }
}

function writeDraft(id: string, draft: ProjectDraft): void {
  fs.mkdirSync(projectDir(id), { recursive: true });
  fs.writeFileSync(draftPath(id), JSON.stringify(draft, null, 2), 'utf8');
}

function uniqueId(name: string): string {
  const base = `${Date.now()}-${slugify(name)}`;
  if (!fs.existsSync(projectDir(base))) return base;
  return `${base}-${Math.floor(Math.random() * 1000)}`;
}

export function listProjects(): ProjectMeta[] {
  const root = getProjectsRoot();
  if (!fs.existsSync(root)) return [];

  const items: ProjectMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let meta = readMeta(entry.name);
    if (!meta) {
      const hasVideo = fs.existsSync(path.join(root, entry.name, 'final.mp4'));
      meta = {
        id: entry.name,
        name: entry.name,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        status: hasVideo ? 'ready' : 'draft',
        hasVideo,
      };
      writeMeta(meta);
    } else {
      meta.hasVideo = fs.existsSync(path.join(root, entry.name, 'final.mp4'));
      // Heal stale "Đang gen" left behind when a job crashed / app restarted.
      if (meta.status === 'generating' && !isJobActive()) {
        if (meta.hasVideo) {
          meta.status = 'ready';
          meta.lastError = '';
          meta.updatedAt = nowIso();
          writeMeta(meta);
        } else {
          meta.status = 'error';
          meta.lastError = meta.lastError || 'Job bị gián đoạn trước khi tạo xong video.';
          meta.updatedAt = nowIso();
          writeMeta(meta);
        }
      }
    }
    items.push(meta);
  }

  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): ProjectDetail {
  let meta = readMeta(id);
  if (!meta) throw new Error(`Không tìm thấy dự án: ${id}`);

  const dir = projectDir(id);
  const videoPath = path.join(dir, 'final.mp4');
  const hasVideo = fs.existsSync(videoPath);

  // Heal badge "Đang gen" khi job main đã hết nhưng meta chưa cập nhật.
  if (meta.status === 'generating' && !isJobActive()) {
    meta = {
      ...meta,
      status: hasVideo ? 'ready' : 'error',
      lastError: hasVideo
        ? ''
        : meta.lastError || 'Job bị gián đoạn trước khi tạo xong video.',
      updatedAt: nowIso(),
      hasVideo,
    };
    writeMeta(meta);
  }

  const srtPath = path.join(dir, 'subs.srt');
  const narrationMp3 = path.join(dir, 'narration.mp3');
  const narrationRaw = path.join(dir, 'narration-raw.mp3');
  const audioPath = fs.existsSync(narrationMp3)
    ? narrationMp3
    : fs.existsSync(narrationRaw)
      ? narrationRaw
      : null;
  const draft = readDraft(id);
  const mediaKind = draft?.mediaKind ?? 'video';
  const mediaDir = sceneMediaDir(dir, mediaKind);
  const extension = mediaExtFor(mediaKind);
  const resolved = draft?.script ? resolveSceneMedia(dir, draft.script, mediaKind) : [];
  const sceneMedia =
    draft?.script?.scenes.map((scene, index) => {
      const found = resolved[index] ?? null;
      return {
        sceneId: scene.id,
        sceneIndex: index,
        path: found ?? sceneMediaTarget(mediaDir, scene.id, extension),
        kind: mediaKind,
        exists: Boolean(found),
      };
    }) ?? [];

  return {
    meta: {
      ...meta,
      hasVideo,
    },
    draft,
    videoPath: hasVideo ? videoPath : null,
    srtPath: fs.existsSync(srtPath) ? srtPath : null,
    audioPath,
    sceneMedia,
    projectDir: dir,
  };
}

export function createProject(input: CreateProjectInput): ProjectMeta {
  const name = input.name.trim();
  if (!name) throw new Error('Tên dự án không được để trống.');

  const id = uniqueId(name);
  const ts = nowIso();
  const projectKind = resolveProjectKind(input.projectKind);
  const mediaKind: MediaKind = input.mediaKind ?? 'video';
  const defaultModel = getModelById(defaultModelIdForKind(mediaKind));
  const meta: ProjectMeta = {
    id,
    name,
    createdAt: ts,
    updatedAt: ts,
    status: 'draft',
    projectKind,
    brief: input.brief ?? '',
    language: input.language,
    family: input.family ?? defaultFamilyForKind(mediaKind),
    model: input.model ?? defaultModelIdForKind(mediaKind),
    aspectRatio: input.aspectRatio ?? defaultModel?.defaultAspectRatio ?? '16:9',
    resolution: input.resolution ?? defaultModel?.defaultResolution ?? (mediaKind === 'image' ? '1K' : '720p'),
    mode: input.mode,
    sceneCount: input.sceneCount ?? 3,
    targetDurationSec:
      input.targetDurationSec ??
      (input.sceneCount ?? 3) * DEFAULT_DURATION_PER_SCENE,
    hasVideo: false,
    mediaKind,
    stylePrompt: input.stylePrompt ?? defaultStylePromptForProjectKind(projectKind),
  };

  writeMeta(meta);
  const settings = getSettings();
  const voiceBase = resolveProjectVoice(input, settings);
  /** audio-only: mặc định ElevenLabs TTS. */
  const voice =
    projectKind === 'audio-only'
      ? { ...voiceBase, ttsProvider: input.ttsProvider || ('elevenlabs' as const) }
      : voiceBase;
  writeDraft(id, {
    projectKind,
    brief: meta.brief ?? '',
    language: meta.language,
    sceneCount: meta.sceneCount ?? 3,
    targetDurationSec: meta.targetDurationSec ?? DEFAULT_TARGET_DURATION_SEC,
    family: (meta.family ?? defaultFamilyForKind(mediaKind)) as VideoFamily | ImageFamily,
    model: meta.model ?? defaultModelIdForKind(mediaKind),
    aspectRatio: meta.aspectRatio ?? '16:9',
    resolution: meta.resolution ?? (mediaKind === 'image' ? '1K' : '720p'),
    mode: meta.mode,
    script: null,
    mediaKind,
    stylePrompt: meta.stylePrompt ?? defaultStylePromptForProjectKind(projectKind),
    openaiChatModel: resolveProjectChatModel(input.openaiChatModel, settings.openaiModel),
    lyricText: '',
    characterRelativePaths: [],
    musicStoryNotes: '',
    musicCastLock: '',
    ...voice,
  });

  return meta;
}

export function renameProject(id: string, name: string): ProjectMeta {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Tên dự án không được để trống.');
  const meta = readMeta(id);
  if (!meta) throw new Error(`Không tìm thấy dự án: ${id}`);
  meta.name = trimmed;
  meta.updatedAt = nowIso();
  writeMeta(meta);
  return meta;
}

export function deleteProject(id: string): boolean {
  const dir = projectDir(id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function saveProjectDraft(
  id: string,
  draft: ProjectDraft,
  patch?: Partial<Pick<ProjectMeta, 'name' | 'status' | 'lastError'>>
): ProjectMeta {
  let meta = readMeta(id);
  if (!meta) throw new Error(`Không tìm thấy dự án: ${id}`);

  writeDraft(id, draft);
  meta = {
    ...meta,
    projectKind: resolveProjectKind(draft.projectKind ?? meta.projectKind),
    brief: draft.brief,
    language: draft.language,
    sceneCount: draft.sceneCount,
    targetDurationSec: draft.targetDurationSec,
    family: draft.family,
    model: draft.model,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    mode: draft.mode,
    mediaKind: draft.mediaKind,
    stylePrompt: draft.stylePrompt,
    updatedAt: nowIso(),
    ...(patch?.name ? { name: patch.name.trim() || meta.name } : {}),
    ...(patch?.status ? { status: patch.status } : {}),
    ...(patch?.lastError !== undefined ? { lastError: patch.lastError } : {}),
  };
  writeMeta(meta);
  return meta;
}

export function ensureProject(options: {
  projectId?: string;
  projectName?: string;
  brief?: string;
  language?: string;
  family: VideoFamily | ImageFamily;
  model: string;
  aspectRatio: string;
  resolution: string;
  mode?: string;
  script: ScriptDraft;
  mediaKind?: MediaKind;
  stylePrompt?: string;
}): ProjectMeta {
  if (options.projectId) {
    const existing = readMeta(options.projectId);
    if (existing) {
      if (options.projectName?.trim()) {
        existing.name = options.projectName.trim();
      }
      existing.updatedAt = nowIso();
      existing.status = 'generating';
      existing.brief = options.brief ?? existing.brief;
      existing.language = options.language ?? existing.language;
      existing.family = options.family;
      existing.model = options.model;
      existing.aspectRatio = options.aspectRatio;
      existing.resolution = options.resolution;
      existing.mode = options.mode;
      existing.sceneCount = options.script.scenes.length;
      existing.targetDurationSec =
        options.script.scenes.reduce((sum, scene) => sum + scene.duration_hint, 0) ||
        existing.targetDurationSec;
      existing.mediaKind = options.mediaKind ?? existing.mediaKind ?? 'video';
      existing.stylePrompt = options.stylePrompt ?? existing.stylePrompt ?? '';
      writeMeta(existing);
      const prevDraft = readDraft(options.projectId);
      const settings = getSettings();
      const voice = resolveProjectVoice(prevDraft, settings);
      const keptKind = resolveProjectKind(prevDraft?.projectKind ?? existing.projectKind);
      writeDraft(options.projectId, {
        // writeDraft ghi đè NGUYÊN file draft.json → phải mang theo mọi field
        // không nằm trong options, nếu không dự án nhạc mất lyric / cast lock.
        projectKind: keptKind,
        brief: existing.brief ?? '',
        language: existing.language,
        sceneCount: options.script.scenes.length,
        targetMediaCount: prevDraft?.targetMediaCount,
        sceneDensity: prevDraft?.sceneDensity,
        targetDurationSec:
          existing.targetDurationSec ?? DEFAULT_TARGET_DURATION_SEC,
        family: options.family,
        model: options.model,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        mode: options.mode,
        script: options.script,
        mediaKind: existing.mediaKind ?? 'video',
        stylePrompt: existing.stylePrompt ?? defaultStylePromptForProjectKind(keptKind),
        openaiChatModel: resolveProjectChatModel(
          prevDraft?.openaiChatModel,
          settings.openaiModel
        ),
        outputFormat: prevDraft?.outputFormat,
        lyricText: prevDraft?.lyricText,
        musicRelativePath: prevDraft?.musicRelativePath,
        characterRelativePaths: prevDraft?.characterRelativePaths ?? [],
        musicStoryNotes: prevDraft?.musicStoryNotes,
        musicCastLock: prevDraft?.musicCastLock,
        ...voice,
      });
      return existing;
    }
  }

  const name =
    options.projectName?.trim() ||
    options.script.title?.trim() ||
    `Dự án ${new Date().toLocaleString('vi-VN')}`;

  const scriptDuration = options.script.scenes.reduce(
    (sum, scene) => sum + scene.duration_hint,
    0
  );

  const created = createProject({
    name,
    brief: options.brief,
    language: options.language,
    sceneCount: options.script.scenes.length,
    targetDurationSec: scriptDuration || DEFAULT_TARGET_DURATION_SEC,
    family: options.family,
    model: options.model,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    mode: options.mode,
    mediaKind: options.mediaKind,
    stylePrompt: options.stylePrompt,
  });

  created.status = 'generating';
  created.updatedAt = nowIso();
  writeMeta(created);
  const voice = resolveProjectVoice(readDraft(created.id), getSettings());
  writeDraft(created.id, {
    brief: options.brief ?? '',
    language: options.language,
    sceneCount: options.script.scenes.length,
    targetDurationSec: scriptDuration || DEFAULT_TARGET_DURATION_SEC,
    family: options.family,
    model: options.model,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    mode: options.mode,
    script: options.script,
    mediaKind: options.mediaKind ?? 'video',
    stylePrompt: options.stylePrompt ?? defaultStylePromptForProjectKind(created.projectKind),
    openaiChatModel: resolveProjectChatModel(undefined, getSettings().openaiModel),
    ...voice,
  });
  return created;
}

export function updateProjectStatus(
  id: string,
  status: ProjectStatus,
  extra?: Partial<ProjectMeta>
): ProjectMeta {
  const meta = readMeta(id);
  if (!meta) throw new Error(`Không tìm thấy dự án: ${id}`);
  const next: ProjectMeta = {
    ...meta,
    ...extra,
    status,
    updatedAt: nowIso(),
    hasVideo: fs.existsSync(path.join(projectDir(id), 'final.mp4')),
  };
  writeMeta(next);
  return next;
}

export function getProjectDir(id: string): string {
  return projectDir(id);
}
