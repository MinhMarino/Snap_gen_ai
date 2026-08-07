import { useEffect, useMemo, useState } from 'react';
import type { JobProgress, SceneMediaAsset, ScriptDraft } from '../../shared/types';
import JobProgressView from './JobProgress';

interface Props {
  open: boolean;
  script: ScriptDraft;
  sceneMedia: SceneMediaAsset[];
  hasNarration: boolean;
  busy?: boolean;
  progress?: JobProgress | null;
  onClose: () => void;
  onConfirm: (payload: {
    regenerateSceneIds: string[];
    refreshNarration: boolean;
  }) => void;
}

export default function GenerateScenesDialog({
  open,
  script,
  sceneMedia,
  hasNarration,
  busy,
  progress,
  onClose,
  onConfirm,
}: Props) {
  const scenes = script.scenes;
  const mediaById = useMemo(() => {
    const map = new Map<string, SceneMediaAsset>();
    for (const asset of sceneMedia) map.set(asset.sceneId, asset);
    return map;
  }, [sceneMedia]);

  const missingIds = useMemo(
    () =>
      scenes
        .filter((scene, index) => {
          const asset = mediaById.get(scene.id) ?? sceneMedia[index];
          return !asset?.exists;
        })
        .map((scene) => scene.id),
    [scenes, mediaById, sceneMedia]
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refreshNarration, setRefreshNarration] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Default: chỉ scene thiếu. Đã có clip thì không auto chọn lại toàn bộ.
    setSelected(new Set(missingIds));
    setRefreshNarration(!hasNarration);
  }, [open, missingIds, scenes, hasNarration]);

  if (!open) return null;

  const allSelected = scenes.length > 0 && selected.size === scenes.length;
  const allHaveMedia = scenes.length > 0 && missingIds.length === 0;
  // Cho phép: gen scene / chỉ refresh voiceover / chỉ ghép lại Final khi đã đủ clip.
  const canConfirm =
    selected.size > 0 || missingIds.length > 0 || refreshNarration || allHaveMedia;

  const toggle = (sceneId: string, locked: boolean) => {
    if (locked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sceneId)) next.delete(sceneId);
      else next.add(sceneId);
      return next;
    });
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card generate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="generate-dialog-title">
              {busy ? 'Đang tạo media...' : 'Chọn scene để tạo'}
            </h2>
            <p>
              {busy
                ? 'Có thể đóng cửa sổ này, job vẫn chạy tiếp ở nền.'
                : 'Chỉ scene được chọn mới gọi Snapgen. Scene còn lại dùng clip cũ nếu có.'}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
            ×
          </button>
        </header>

        {busy ? (
          <div className="generate-running">
            <JobProgressView progress={progress ?? null} showControls />
            <p className="hint">
              Thấy ảnh/video không đúng tiêu chí? Bấm <strong>Tạm dừng</strong> (ngừng scene mới) hoặc{' '}
              <strong>Dừng</strong> để khỏi tốn token. Mỗi shot Snapgen mất khoảng 80–90 giây.
            </p>
          </div>
        ) : (
          <>
            <div className="export-scene-toolbar" style={{ padding: '8px 18px 0' }}>
              <strong>
                {selected.size}/{scenes.length} scene
              </strong>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setSelected(new Set(scenes.map((s) => s.id)))}
                >
                  Chọn tất cả
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setSelected(new Set(missingIds))}
                >
                  Chỉ scene thiếu
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={selected.size === 0 && missingIds.length === 0}
                  onClick={() => setSelected(new Set())}
                >
                  Bỏ chọn tất cả
                </button>
              </div>
            </div>

            <ul className="export-scene-list" style={{ padding: '8px 18px', maxHeight: 320 }}>
              {scenes.map((scene, index) => {
                const asset = mediaById.get(scene.id) ?? sceneMedia[index];
                const exists = Boolean(asset?.exists);
                const locked = !exists;
                const checked = selected.has(scene.id) || locked;
                return (
                  <li key={scene.id}>
                    <label className={locked ? 'locked' : ''}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={() => toggle(scene.id, locked)}
                      />
                      <span className="export-scene-meta">
                        <strong>
                          Scene {index + 1}
                          <small>
                            · {scene.duration_hint}s ·{' '}
                            {exists ? 'đã có clip' : 'chưa có — bắt buộc gen'}
                          </small>
                        </strong>
                        <em>{scene.visual_prompt || scene.narration_segment || 'Untitled'}</em>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <label
              className={`voiceover-toggle generate-narration-toggle ${
                refreshNarration ? 'on' : 'off'
              }`}
            >
              <input
                type="checkbox"
                checked={refreshNarration}
                disabled={!hasNarration}
                onChange={(event) => setRefreshNarration(event.target.checked)}
              />
              <span className="voiceover-switch" aria-hidden />
              <span className="voiceover-copy">
                <strong>
                  {!hasNarration
                    ? 'Tạo voiceover + subtitle (lần đầu)'
                    : refreshNarration
                      ? 'Tạo lại voiceover + subtitle'
                      : 'Giữ voiceover hiện có'}
                </strong>
                <small>
                  {!hasNarration
                    ? 'Dự án chưa có narration — sẽ tạo mới khi Generate.'
                    : refreshNarration
                      ? 'Đọc liền mạch cả kịch bản, chia mốc để scene khớp đúng lời của mình.'
                      : 'Dùng lại narration.mp3 đã có — không gọi TTS lần này.'}
                </small>
              </span>
            </label>

            {!allSelected && selected.size > 0 && (
              <p className="hint" style={{ padding: '0 18px' }}>
                Scene không chọn sẽ giữ clip cũ (nếu có). Final vẫn ghép đủ tất cả scene.
              </p>
            )}
            {allHaveMedia && selected.size === 0 && !refreshNarration && (
              <p className="hint" style={{ padding: '0 18px' }}>
                Đã đủ clip + narration. Bấm xác nhận để chỉ ghép lại Final (không gen lại).
              </p>
            )}
          </>
        )}

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            {busy ? 'Chạy nền' : 'Hủy'}
          </button>
          {!busy && (
            <button
              type="button"
              className="btn primary"
              disabled={!canConfirm}
              onClick={() => {
                const ids = new Set(selected);
                for (const id of missingIds) ids.add(id);
                onConfirm({
                  regenerateSceneIds: [...ids],
                  refreshNarration: hasNarration ? refreshNarration : true,
                });
              }}
            >
              {selected.size === 0 && missingIds.length === 0
                ? refreshNarration
                  ? 'Chỉ tạo lại voiceover'
                  : 'Ghép lại Final'
                : `Generate ${Math.max(selected.size, missingIds.length)} scene`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
