/**
 * Giữ lại footage đã trả tiền khi phân cảnh bị chia lại.
 *
 * Chia lại cảnh (bước 3) đánh số cảnh mới `scene-01…scene-NN`, trong khi clip cũ
 * trên đĩa cũng mang đúng những cái tên đó nhưng thuộc về một cách chia khác — cứ
 * để nguyên thì clip 32s của cách chia cũ bị gán vào cảnh 8s đầu tiên, còn footage
 * thật của những đoạn sau coi như mất.
 *
 * Chỗ này ghép lại theo TRỤC THỜI GIAN của chính bản đọc (cả hai cách chia đều nằm
 * trên một trục): mỗi cảnh mới nhận đúng đoạn footage đang phủ khoảng thời gian đó.
 *
 * Nguồn không phải file clip đã ghép mà là từng `part-N.mp4` trong `work/` — clip
 * ghép của cảnh dài có thể chứa CÙNG một đoạn 8s lặp lại nhiều lần (khi Snapgen trả
 * về job cũ cho hai chunk trùng prompt), nên phần trùng bị loại theo hash: một cảnh
 * mới chỉ nhận footage thật, số còn lại báo thiếu để người dùng gen bù.
 *
 * Không xoá gì: clip cũ được dời vào `clips/_truoc-khi-chia-lai-<ts>/`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaKind, SceneDraft, ScriptDraft } from '../../shared/types';
import { getDurationSafe } from './ffmpeg';
import {
  mediaExtFor,
  resolveSceneMedia,
  safeSceneKey,
  sceneMediaDir,
  sceneMediaTarget,
} from './scene-media';

export interface SceneMediaSalvage {
  /** Số cảnh mới nhận được footage cũ. */
  adopted: number;
  /** Số cảnh mới còn trống — phải gen. */
  missing: number;
  /** Số đoạn bị loại vì trùng hệt đoạn khác (cùng một clip lặp lại). */
  duplicates: number;
  /** Nơi cất clip cũ, null nếu không có gì để cất. */
  backupDir: string | null;
}

/** Một đoạn footage có thật, đã biết nằm ở đâu trên trục thời gian. */
interface Segment {
  file: string;
  start: number;
  end: number;
  hash: string;
}

function fileHash(filePath: string): string {
  // Đọc cả file: clip 8s vài chục MB, hash xong là loại được đoạn lặp chính xác.
  return createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function partFilesFor(workDir: string, sceneId: string, ext: string): string[] {
  const dir = path.join(workDir, `scene-${safeSceneKey(sceneId)}`);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^part-\d+\.[a-z0-9]+$/i.test(name) && name.endsWith(`.${ext}`))
    .sort((a, b) => (Number(a.match(/\d+/)?.[0]) || 0) - (Number(b.match(/\d+/)?.[0]) || 0))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).size > 0;
      } catch {
        return false;
      }
    });
}

/** Mốc bắt đầu của cảnh trên trục audio — draft cũ thiếu thì cộng dồn duration. */
function sceneStartSec(scenes: SceneDraft[], index: number): number {
  const explicit = Number(scenes[index]?.start_sec);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  let sum = 0;
  for (let i = 0; i < index; i++) sum += Math.max(0, Number(scenes[i]?.duration_hint) || 0);
  return sum;
}

function sceneEndSec(scenes: SceneDraft[], index: number): number {
  const explicit = Number(scenes[index]?.end_sec);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return sceneStartSec(scenes, index) + Math.max(0, Number(scenes[index]?.duration_hint) || 0);
}

/** Cắt footage cũ theo mốc thời gian, đặt lại tên theo cảnh mới. */
export async function salvageSceneMediaForNewScenes(options: {
  projectDir: string;
  mediaKind: MediaKind;
  oldScenes: SceneDraft[];
  newScenes: SceneDraft[];
}): Promise<SceneMediaSalvage> {
  const { projectDir, mediaKind, oldScenes, newScenes } = options;
  const empty: SceneMediaSalvage = {
    adopted: 0,
    missing: newScenes.length,
    duplicates: 0,
    backupDir: null,
  };
  if (!oldScenes.length || !newScenes.length) return empty;

  const dir = sceneMediaDir(projectDir, mediaKind);
  const ext = mediaExtFor(mediaKind);
  const workDir = path.join(projectDir, 'work');
  const oldMedia = resolveSceneMedia(
    projectDir,
    { title: '', narration: '', scenes: oldScenes } as ScriptDraft,
    mediaKind
  );
  if (!oldMedia.some(Boolean)) return empty;

  // —— Tìm mọi đoạn footage có thật, kèm chỗ đứng của nó trên trục ——
  const segments: Segment[] = [];
  const seenHashes = new Set<string>();
  let duplicates = 0;

  for (let i = 0; i < oldScenes.length; i++) {
    const clip = oldMedia[i];
    if (!clip) continue;
    const start = sceneStartSec(oldScenes, i);
    const parts = partFilesFor(workDir, oldScenes[i].id, ext);
    // Ảnh tĩnh không có part; clip cũng có thể mất thư mục work → dùng chính file clip.
    const sources = parts.length ? parts : [clip];

    let cursor = start;
    for (const file of sources) {
      const seconds =
        mediaKind === 'image'
          ? Math.max(0.1, sceneEndSec(oldScenes, i) - start)
          : await getDurationSafe(file, 0);
      if (!(seconds > 0)) continue;

      // Đoạn trùng hệt đoạn đã lấy = clip bị lặp, không phải footage mới.
      const hash = fileHash(file);
      if (seenHashes.has(hash)) {
        duplicates += 1;
        cursor += seconds;
        continue;
      }
      seenHashes.add(hash);
      segments.push({ file, start: cursor, end: cursor + seconds, hash });
      cursor += seconds;
    }
  }
  if (!segments.length) return empty;

  // —— Gán đoạn cho cảnh mới theo độ phủ thời gian ——
  const used = new Set<number>();
  const picks = new Map<string, string>();

  for (let n = 0; n < newScenes.length; n++) {
    const start = sceneStartSec(newScenes, n);
    const end = sceneEndSec(newScenes, n);
    const need = Math.max(0.1, end - start);

    let best = -1;
    let bestOverlap = 0;
    for (let s = 0; s < segments.length; s++) {
      if (used.has(s)) continue;
      const seg = segments[s];
      const overlap = Math.min(seg.end, end) - Math.max(seg.start, start);
      if (overlap <= bestOverlap) continue;
      // Đoạn phải đủ dài cho cảnh, không thì bước ghép lại phải đứng hình bù.
      if (mediaKind === 'video' && seg.end - seg.start < need - 0.35) continue;
      bestOverlap = overlap;
      best = s;
    }
    // Phủ dưới nửa cảnh thì coi như footage của chỗ khác — để trống, gen lại đúng hơn.
    if (best >= 0 && bestOverlap >= need * 0.5) {
      used.add(best);
      picks.set(newScenes[n].id, segments[best].file);
    }
  }

  if (!picks.size) {
    return { adopted: 0, missing: newScenes.length, duplicates, backupDir: null };
  }

  // —— Dựng lại thư mục media: cất bản cũ, chép bản đã gán ——
  // Chép ra chỗ tạm TRƯỚC khi đụng vào clips/: nguồn có thể là chính file trong đó.
  const staging = path.join(workDir, `_salvage-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  const staged = new Map<string, string>();
  for (const [sceneId, source] of picks) {
    const temp = path.join(staging, `${safeSceneKey(sceneId)}.${ext}`);
    fs.copyFileSync(source, temp);
    staged.set(sceneId, temp);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dir, `_truoc-khi-chia-lai-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(`.${ext}`)) continue;
    fs.renameSync(path.join(dir, name), path.join(backupDir, name));
  }

  for (const [sceneId, temp] of staged) {
    fs.renameSync(temp, sceneMediaTarget(dir, sceneId, ext));
  }
  fs.rmSync(staging, { recursive: true, force: true });

  return {
    adopted: staged.size,
    missing: Math.max(0, newScenes.length - staged.size),
    duplicates,
    backupDir,
  };
}
