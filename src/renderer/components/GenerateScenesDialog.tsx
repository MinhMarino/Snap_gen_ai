import { useEffect, useMemo, useState } from 'react';
import type { JobProgress, SceneMediaAsset, ScriptDraft } from '../../shared/types';
import JobProgressView from './JobProgress';

export type GenerateStep = 'audio' | 'media' | 'remux';
export type AudioSourceMode = 'tts' | 'external';

interface Props {
  open: boolean;
  script: ScriptDraft;
  sceneMedia: SceneMediaAsset[];
  hasNarration: boolean;
  mediaKind: 'image' | 'video';
  busy?: boolean;
  progress?: JobProgress | null;
  onClose: () => void;
  onConfirm: (payload: {
    regenerateSceneIds: string[];
    refreshNarration: boolean;
    step: GenerateStep;
    /** Xóa file narration cũ trước khi gọi TTS API. */
    clearNarrationFirst?: boolean;
  }) => void;
  onImportNarration?: () => Promise<void> | void;
  /** Xóa narration hiện có (không TTS lại). */
  onClearNarration?: () => Promise<void> | void;
}

function pickDefaultStep(hasNarration: boolean, missingCount: number): GenerateStep {
  if (!hasNarration) return 'audio';
  if (missingCount > 0) return 'media';
  return 'remux';
}

function buildNarrationText(script: ScriptDraft): string {
  return script.scenes
    .map((scene) => (scene.narration_segment || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

export default function GenerateScenesDialog({
  open,
  script,
  sceneMedia,
  hasNarration,
  mediaKind,
  busy,
  progress,
  onClose,
  onConfirm,
  onImportNarration,
  onClearNarration,
}: Props) {
  const scenes = script.scenes;
  const mediaLabel = mediaKind === 'image' ? 'ảnh' : 'video';
  const narrationText = useMemo(() => buildNarrationText(script), [script]);

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

  const allHaveMedia = scenes.length > 0 && missingIds.length === 0;
  const [step, setStep] = useState<GenerateStep>('audio');
  const [audioMode, setAudioMode] = useState<AudioSourceMode>('tts');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  const mediaIds = useMemo(() => {
    const ids = new Set(selected);
    for (const id of missingIds) ids.add(id);
    return [...ids];
  }, [selected, missingIds]);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(missingIds));
    setStep(pickDefaultStep(hasNarration, missingIds.length));
    setAudioMode('tts');
    setCopyMsg(null);
    setImportBusy(false);
    setClearBusy(false);
  }, [open, missingIds, hasNarration]);

  if (!open) return null;

  const clearNarrationOnly = async () => {
    if (!onClearNarration || clearBusy || busy) return;
    if (
      !window.confirm(
        'Xóa voiceover hiện có (narration.mp3, subtitle, timing)? Có thể tạo lại qua TTS API sau.'
      )
    ) {
      return;
    }
    setClearBusy(true);
    setCopyMsg(null);
    try {
      await onClearNarration();
      setCopyMsg('Đã xóa audio. Chọn TTS để tạo lại qua API.');
    } catch (err) {
      setCopyMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setClearBusy(false);
    }
  };

  const toggle = (sceneId: string, locked: boolean) => {
    if (locked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sceneId)) next.delete(sceneId);
      else next.add(sceneId);
      return next;
    });
  };

  const copyNarration = async () => {
    if (!narrationText) {
      setCopyMsg('Kịch bản chưa có narration.');
      return;
    }
    try {
      await navigator.clipboard.writeText(narrationText);
      setCopyMsg(`Đã copy ${narrationText.length.toLocaleString()} ký tự.`);
    } catch {
      setCopyMsg('Không copy được — hãy chọn text và Cmd+C.');
    }
  };

  const importNarration = async () => {
    if (!onImportNarration || importBusy) return;
    setImportBusy(true);
    setCopyMsg(null);
    try {
      await onImportNarration();
    } finally {
      setImportBusy(false);
    }
  };

  const canConfirm =
    step === 'audio'
      ? audioMode === 'external'
        ? Boolean(onImportNarration) && Boolean(narrationText)
        : true
      : step === 'media'
        ? mediaIds.length > 0
        : allHaveMedia && hasNarration;

  const confirmLabel =
    step === 'audio'
      ? audioMode === 'external'
        ? importBusy
          ? 'Đang import...'
          : 'Chọn file audio...'
        : hasNarration
          ? 'Xóa & tạo lại qua API'
          : 'Tạo audio (TTS API)'
      : step === 'media'
        ? `Tạo ${mediaIds.length} ${mediaLabel}`
        : 'Ghép Final';

  const stepCopy =
    step === 'audio'
      ? {
          title: busy || importBusy ? 'Đang xử lý audio...' : 'Bước 1 — Tạo audio',
          blurb:
            busy || importBusy
              ? 'Có thể đóng cửa sổ này, job vẫn chạy tiếp ở nền.'
              : audioMode === 'external'
                ? 'Copy narration ra ngoài → tự TTS → import file audio vào dự án.'
                : 'Chỉ tạo voiceover + subtitle từ kịch bản. Chưa gọi Snapgen ảnh/video.',
        }
      : step === 'media'
        ? {
            title: busy ? `Đang tạo ${mediaLabel}...` : `Bước 2 — Tạo ${mediaLabel}`,
            blurb: busy
              ? 'Có thể đóng cửa sổ này, job vẫn chạy tiếp ở nền.'
              : `Chỉ scene được chọn mới gọi Snapgen. Dùng narration hiện có (không TTS lại).`,
          }
        : {
            title: busy ? 'Đang ghép Final...' : 'Bước 3 — Ghép Final',
            blurb: busy
              ? 'Có thể đóng cửa sổ này, job vẫn chạy tiếp ở nền.'
              : 'Ghép clip/ảnh đã có + narration thành final.mp4 (FFmpeg, không gọi TTS/Snapgen).',
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
            <h2 id="generate-dialog-title">{stepCopy.title}</h2>
            <p>{stepCopy.blurb}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Đóng">
            ×
          </button>
        </header>

        {busy ? (
          <div className="generate-running">
            <JobProgressView progress={progress ?? null} showControls />
            <p className="hint">
              Tiến độ + log cũng hiện ở <strong>popup bước</strong> và <strong>dock dưới màn hình</strong>.
              Có thể đóng dialog này — job vẫn chạy. Bấm <strong>Tạm dừng</strong> / <strong>Dừng</strong> để
              tiết kiệm token.
            </p>
          </div>
        ) : (
          <>
            <div className="generate-steps" role="tablist" aria-label="Các bước tạo media">
              <button
                type="button"
                role="tab"
                aria-selected={step === 'audio'}
                className={`generate-step ${step === 'audio' ? 'active' : ''} ${
                  hasNarration ? 'done' : ''
                }`}
                onClick={() => setStep('audio')}
              >
                <span className="generate-step-num">1</span>
                <span className="generate-step-body">
                  <strong>Tạo audio</strong>
                  <small>{hasNarration ? 'Đã có voiceover' : 'Chưa có voiceover'}</small>
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={step === 'media'}
                className={`generate-step ${step === 'media' ? 'active' : ''} ${
                  allHaveMedia ? 'done' : ''
                }`}
                onClick={() => setStep('media')}
              >
                <span className="generate-step-num">2</span>
                <span className="generate-step-body">
                  <strong>Tạo {mediaLabel}</strong>
                  <small>
                    {allHaveMedia
                      ? `Đủ ${scenes.length} scene`
                      : `Thiếu ${missingIds.length}/${scenes.length}`}
                  </small>
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={step === 'remux'}
                className={`generate-step ${step === 'remux' ? 'active' : ''} ${
                  allHaveMedia && hasNarration ? 'done' : ''
                }`}
                disabled={!allHaveMedia || !hasNarration}
                onClick={() => setStep('remux')}
              >
                <span className="generate-step-num">3</span>
                <span className="generate-step-body">
                  <strong>Ghép Final</strong>
                  <small>
                    {allHaveMedia && hasNarration ? 'Sẵn sàng ghép' : 'Cần đủ audio + media'}
                  </small>
                </span>
              </button>
            </div>

            {step === 'audio' && (
              <div className="generate-step-panel">
                <div className="audio-source-modes" role="radiogroup" aria-label="Nguồn audio">
                  <button
                    type="button"
                    className={`audio-source-mode ${audioMode === 'tts' ? 'active' : ''}`}
                    onClick={() => setAudioMode('tts')}
                  >
                    <strong>TTS trong app</strong>
                    <small>OpenAI / ElevenLabs / Qwen</small>
                  </button>
                  <button
                    type="button"
                    className={`audio-source-mode ${audioMode === 'external' ? 'active' : ''}`}
                    onClick={() => setAudioMode('external')}
                  >
                    <strong>Tự tạo ngoài</strong>
                    <small>Copy text → TTS ngoài → import file</small>
                  </button>
                </div>

                {audioMode === 'tts' ? (
                  <>
                    <p>
                      {hasNarration
                        ? 'Đã có voiceover. Có thể xóa file hiện có, hoặc xóa rồi gọi lại TTS API (OpenAI / ElevenLabs / Irodori).'
                        : 'Sẽ tạo narration.mp3 + subtitle lần đầu từ toàn bộ narration trong kịch bản (gọi TTS API).'}
                    </p>
                    {hasNarration ? (
                      <div className="audio-manage-actions">
                        <button
                          type="button"
                          className="btn danger"
                          disabled={!onClearNarration || clearBusy || busy}
                          onClick={() => void clearNarrationOnly()}
                        >
                          {clearBusy ? 'Đang xóa…' : 'Xóa audio hiện có'}
                        </button>
                        <p className="hint" style={{ margin: 0 }}>
                          Nút chính bên dưới = xóa cache rồi tạo lại qua API.
                        </p>
                      </div>
                    ) : null}
                    {copyMsg ? <p className="hint">{copyMsg}</p> : null}
                    <p className="hint">
                      Bước này không tạo {mediaLabel}. Sau khi xong, sang bước 2 để tạo {mediaLabel}.
                    </p>
                  </>
                ) : (
                  <>
                    <ol className="external-audio-steps">
                      <li>Copy toàn bộ narration bên dưới.</li>
                      <li>Chạy TTS / thu âm ngoài app (ElevenLabs web, studio, …).</li>
                      <li>Import file audio vào dự án — app căn lại timeline scene.</li>
                    </ol>
                    <div className="external-audio-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={!narrationText}
                        onClick={() => void copyNarration()}
                      >
                        Copy narration
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={!onImportNarration || importBusy || !narrationText}
                        onClick={() => void importNarration()}
                      >
                        {importBusy ? 'Đang import...' : 'Import file audio...'}
                      </button>
                    </div>
                    {copyMsg ? <p className="hint">{copyMsg}</p> : null}
                    <textarea
                      className="external-audio-preview"
                      readOnly
                      value={narrationText}
                      rows={6}
                      placeholder="Chưa có narration trong kịch bản."
                    />
                    <p className="hint">
                      Có OpenAI key → căn timeline bằng Whisper. Không có → chia theo tỉ lệ độ dài
                      chữ từng scene.
                    </p>
                  </>
                )}
              </div>
            )}

            {step === 'media' && (
              <>
                {!hasNarration && (
                  <p className="hint generate-step-warn">
                    Chưa có audio — nên làm bước 1 trước để thời lượng scene khớp lời thoại. Vẫn có
                    thể tạo {mediaLabel} theo duration_hint hiện tại.
                  </p>
                )}
                <div className="export-scene-toolbar" style={{ padding: '8px 18px 0' }}>
                  <strong>
                    {mediaIds.length}/{scenes.length} scene
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
                                {exists ? `đã có ${mediaLabel}` : `chưa có — bắt buộc gen`}
                              </small>
                            </strong>
                            <em>{scene.visual_prompt || scene.narration_segment || 'Untitled'}</em>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>

                {!allHaveMedia && mediaIds.length > 0 && (
                  <p className="hint" style={{ padding: '0 18px' }}>
                    Job chỉ tạo scene đã chọn. Khi còn thiếu clip sẽ chưa ghép Final — chạy tiếp
                    bước 2 hoặc bước 3 khi đủ.
                  </p>
                )}
              </>
            )}

            {step === 'remux' && (
              <div className="generate-step-panel">
                <p>
                  Đã đủ voiceover và {scenes.length} {mediaLabel}. Ghép lại final.mp4 theo timeline
                  hiện tại — không tốn token TTS / Snapgen.
                </p>
              </div>
            )}
          </>
        )}

        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            {busy || importBusy ? 'Chạy nền' : 'Hủy'}
          </button>
          {!busy && !(step === 'audio' && audioMode === 'external') && (
            <button
              type="button"
              className="btn primary"
              disabled={!canConfirm || importBusy || clearBusy}
              onClick={() => {
                if (step === 'audio') {
                  onConfirm({
                    regenerateSceneIds: [],
                    refreshNarration: true,
                    step: 'audio',
                    clearNarrationFirst: hasNarration,
                  });
                  return;
                }
                if (step === 'remux') {
                  onConfirm({
                    regenerateSceneIds: [],
                    refreshNarration: false,
                    step: 'remux',
                  });
                  return;
                }
                onConfirm({
                  regenerateSceneIds: mediaIds,
                  refreshNarration: false,
                  step: 'media',
                });
              }}
            >
              {confirmLabel}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
