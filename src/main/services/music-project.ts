import fs from 'node:fs';
import path from 'node:path';
import { convertAudioToMp3, getDurationSafe } from './ffmpeg';
import { getProject, getProjectDir, saveProjectDraft } from './projects';
import type { ProjectDraft } from '../../shared/types';
import { resolveProjectKind } from '../../shared/types';

const MUSIC_DIR = 'music';
const CHAR_DIR = 'characters';
const MUSIC_AS_NARRATION = 'narration.mp3';

function ensureMusicDirs(projectDir: string): { musicDir: string; charDir: string } {
  const musicDir = path.join(projectDir, MUSIC_DIR);
  const charDir = path.join(projectDir, CHAR_DIR);
  fs.mkdirSync(musicDir, { recursive: true });
  fs.mkdirSync(charDir, { recursive: true });
  return { musicDir, charDir };
}

function patchDraft(projectId: string, patch: Partial<ProjectDraft>): ProjectDraft {
  const detail = getProject(projectId);
  if (!detail.draft) throw new Error('Dự án chưa có draft.');
  const next: ProjectDraft = {
    ...detail.draft,
    ...patch,
    projectKind: resolveProjectKind(patch.projectKind ?? detail.draft.projectKind ?? detail.meta.projectKind),
  };
  saveProjectDraft(projectId, next);
  return next;
}

/** Import file nhạc → music/source.* + narration.mp3 (để bước ghép dùng lại pipeline hiện tại). */
export async function importMusicAudio(options: {
  projectId: string;
  sourcePath: string;
}): Promise<{
  musicRelativePath: string;
  audioPath: string;
  durationSec: number;
  draft: ProjectDraft;
}> {
  const projectDir = getProjectDir(options.projectId);
  const { musicDir } = ensureMusicDirs(projectDir);
  const ext = path.extname(options.sourcePath).toLowerCase() || '.mp3';
  const destRel = path.join(MUSIC_DIR, `source${ext}`);
  const destAbs = path.join(projectDir, destRel);
  fs.copyFileSync(options.sourcePath, destAbs);

  const narrationPath = path.join(projectDir, MUSIC_AS_NARRATION);
  if (ext === '.mp3') {
    fs.copyFileSync(destAbs, narrationPath);
  } else {
    await convertAudioToMp3(destAbs, narrationPath);
  }

  const durationSec = await getDurationSafe(narrationPath, 0);
  const draft = patchDraft(options.projectId, {
    projectKind: 'music-animation',
    musicRelativePath: destRel.replace(/\\/g, '/'),
    targetDurationSec:
      durationSec > 0
        ? Math.round(durationSec)
        : getProject(options.projectId).draft?.targetDurationSec || 60,
  });

  return {
    musicRelativePath: draft.musicRelativePath || destRel,
    audioPath: narrationPath,
    durationSec,
    draft,
  };
}

export function clearMusicAudio(projectId: string): { removed: string[]; draft: ProjectDraft } {
  const projectDir = getProjectDir(projectId);
  const detail = getProject(projectId);
  const removed: string[] = [];
  const rel = detail.draft?.musicRelativePath;
  if (rel) {
    const abs = path.join(projectDir, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
    }
  }
  const narration = path.join(projectDir, MUSIC_AS_NARRATION);
  if (fs.existsSync(narration)) {
    fs.rmSync(narration, { force: true });
    removed.push(MUSIC_AS_NARRATION);
  }
  const draft = patchDraft(projectId, {
    projectKind: 'music-animation',
    musicRelativePath: undefined,
  });
  return { removed, draft };
}

/** Import 1+ ảnh nhân vật (optional). */
export function importMusicCharacters(options: {
  projectId: string;
  sourcePaths: string[];
}): { characterRelativePaths: string[]; draft: ProjectDraft } {
  const projectDir = getProjectDir(options.projectId);
  const { charDir } = ensureMusicDirs(projectDir);
  const existing = getProject(options.projectId).draft?.characterRelativePaths || [];
  const next = [...existing];
  let idx = next.length;
  for (const src of options.sourcePaths) {
    if (!fs.existsSync(src)) continue;
    const ext = path.extname(src).toLowerCase() || '.png';
    const rel = path.join(CHAR_DIR, `char-${idx}${ext}`).replace(/\\/g, '/');
    fs.copyFileSync(src, path.join(projectDir, rel));
    next.push(rel);
    idx += 1;
  }
  const draft = patchDraft(options.projectId, {
    projectKind: 'music-animation',
    characterRelativePaths: next,
  });
  return { characterRelativePaths: next, draft };
}

export function clearMusicCharacters(projectId: string): {
  removed: string[];
  draft: ProjectDraft;
} {
  const projectDir = getProjectDir(projectId);
  const detail = getProject(projectId);
  const removed: string[] = [];
  for (const rel of detail.draft?.characterRelativePaths || []) {
    const abs = path.join(projectDir, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
    }
  }
  const draft = patchDraft(projectId, {
    projectKind: 'music-animation',
    characterRelativePaths: [],
  });
  return { removed, draft };
}

export function resolveMusicAudioPath(projectId: string): string | null {
  const detail = getProject(projectId);
  const projectDir = detail.projectDir;
  const narration = path.join(projectDir, MUSIC_AS_NARRATION);
  if (fs.existsSync(narration) && fs.statSync(narration).size > 0) return narration;
  const rel = detail.draft?.musicRelativePath;
  if (rel) {
    const abs = path.join(projectDir, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** Đọc ảnh nhân vật → data URL nhỏ (cho GPT vision). */
export function loadCharacterDataUrls(
  projectId: string,
  maxImages = 3
): Array<{ name: string; dataUrl: string }> {
  const detail = getProject(projectId);
  const projectDir = detail.projectDir;
  const out: Array<{ name: string; dataUrl: string }> = [];
  for (const rel of (detail.draft?.characterRelativePaths || []).slice(0, maxImages)) {
    const abs = path.join(projectDir, rel);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    if (buf.length > 6_000_000) continue; // bỏ ảnh quá lớn
    const ext = path.extname(abs).toLowerCase().replace('.', '') || 'png';
    const mime =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : 'image/png';
    out.push({
      name: path.basename(rel),
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    });
  }
  return out;
}
