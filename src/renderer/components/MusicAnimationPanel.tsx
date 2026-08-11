import ModelPicker from './ModelPicker';
import type {
  ImageFamily,
  MediaKind,
  ModelOption,
  ProjectDraft,
  SceneJobProgress,
  SceneMediaAsset,
  ScriptDraft,
  VideoFamily,
} from '../../shared/types';
import {
  estimateGenerationCredits,
  formatCreditEstimate,
  formatDurationLabel,
  SCENE_DENSITY_OPTIONS,
  type SceneDensityId,
} from '../../shared/models';

export type MusicWorkflowStep = 'input' | 'storyboard' | 'media' | 'merge';

type Props = {
  step: MusicWorkflowStep;
  draft: ProjectDraft | null;
  script: ScriptDraft | null;
  /** Clip/ảnh đang có trên đĩa theo từng scene. */
  sceneMedia: SceneMediaAsset[];
  /** Trạng thái lần chạy gần nhất — nguồn thông báo lỗi từng scene. */
  sceneStatuses?: SceneJobProgress[];
  /** Chọn model Snapgen ngay trong bước 3. */
  mediaKind: MediaKind;
  families: { id: string; label: string }[];
  models: ModelOption[];
  family: string;
  modelId: string;
  aspectRatio: string;
  outputFormat?: string;
  resolution: string;
  mode: string;
  onFamilyChange: (f: VideoFamily | ImageFamily) => void;
  onModelChange: (id: string) => void;
  onAspectRatioChange: (v: string) => void;
  onOutputFormatChange?: (formatId: string) => void;
  onResolutionChange: (v: string) => void;
  onModeChange: (v: string) => void;
  audioPath: string | null;
  musicDurationSec: number | null;
  step3Done: boolean;
  step4Done: boolean;
  busy: boolean;
  sceneDensity: SceneDensityId;
  targetMediaCount: number;
  sceneCountHint: number;
  typicalBeatSec: number;
  sceneCountMin: number;
  sceneCountMax: number;
  onSceneDensityChange: (id: SceneDensityId) => void;
  onTargetMediaCountChange: (count: number) => void;
  onLyricChange: (lyric: string) => void;
  onCastLockChange: (castLock: string) => void;
  onImportMusic: () => void;
  onClearMusic: () => void;
  onImportCharacters: () => void;
  onClearCharacters: () => void;
  onAnalyze: () => void;
  onGenerateMedia: () => void;
  /** Gen lại đúng danh sách scene truyền vào (nút "tạo lại cảnh lỗi"). */
  onRegenerateScenes: (sceneIds: string[]) => void;
  onMerge: () => void;
  onGoStep: (step: MusicWorkflowStep) => void;
};

export default function MusicAnimationPanel({
  step,
  draft,
  script,
  sceneMedia,
  sceneStatuses,
  mediaKind,
  families,
  models,
  family,
  modelId,
  aspectRatio,
  outputFormat,
  resolution,
  mode,
  onFamilyChange,
  onModelChange,
  onAspectRatioChange,
  onOutputFormatChange,
  onResolutionChange,
  onModeChange,
  audioPath,
  musicDurationSec,
  step3Done,
  step4Done,
  busy,
  sceneDensity,
  targetMediaCount,
  sceneCountHint,
  typicalBeatSec,
  sceneCountMin,
  sceneCountMax,
  onSceneDensityChange,
  onTargetMediaCountChange,
  onLyricChange,
  onCastLockChange,
  onImportMusic,
  onClearMusic,
  onImportCharacters,
  onClearCharacters,
  onAnalyze,
  onGenerateMedia,
  onRegenerateScenes,
  onMerge,
  onGoStep,
}: Props) {
  const hasMusic = Boolean(audioPath || draft?.musicRelativePath);
  const hasLyric = Boolean(draft?.lyricText?.trim());
  const hasScript = Boolean(script?.scenes?.length);
  const chars = draft?.characterRelativePaths || [];

  if (step === 'input') {
    return (
      <>
        <div className="editor-panel-heading">
          <div>
            <span className="panel-kicker">BƯỚC 1 · NHẠC</span>
            <h2>Input nhạc + lyric</h2>
          </div>
          <span className={`step-status-badge ${hasMusic && hasLyric ? 'done' : ''}`}>
            {hasMusic && hasLyric ? 'Đủ input' : 'Thiếu'}
          </span>
        </div>
        <p className="media-note">
          Tải audio bài hát và dán lyric. Ảnh nhân vật là tùy chọn (ChatGPT/Snapgen giữ consistency).
        </p>

        <div className="field">
          <label>File nhạc</label>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={onImportMusic}>
              {hasMusic ? 'Đổi file nhạc' : 'Tải audio lên'}
            </button>
            {hasMusic ? (
              <button type="button" className="btn ghost" disabled={busy} onClick={onClearMusic}>
                Xóa nhạc
              </button>
            ) : null}
          </div>
          <p className="hint">
            {hasMusic
              ? `${draft?.musicRelativePath || 'narration.mp3'}${
                  musicDurationSec ? ` · ~${Math.round(musicDurationSec)}s` : ''
                }`
              : 'Chưa có audio'}
          </p>
        </div>

        <div className="field">
          <label htmlFor="music-lyric">Lyric / script lời bài hát</label>
          <textarea
            id="music-lyric"
            rows={12}
            disabled={busy}
            value={draft?.lyricText || ''}
            placeholder={'Dán toàn bộ lyric…\n\n[Verse 1]\n...\n[Chorus]\n...'}
            onChange={(e) => onLyricChange(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Nhân vật (optional)</label>
          <div className="row-actions">
            <button type="button" className="btn" disabled={busy} onClick={onImportCharacters}>
              Thêm ảnh nhân vật
            </button>
            {chars.length ? (
              <button type="button" className="btn ghost" disabled={busy} onClick={onClearCharacters}>
                Xóa ảnh
              </button>
            ) : null}
          </div>
          <p className="hint">
            {chars.length ? `${chars.length} ảnh: ${chars.map((p) => p.split('/').pop()).join(', ')}` : 'Chưa thêm'}
          </p>
        </div>

        <div className="step-actions">
          <button
            type="button"
            className="editor-primary full-width"
            disabled={busy || !hasMusic || !hasLyric}
            onClick={() => onGoStep('storyboard')}
          >
            Tiếp: Phân cảnh AI →
          </button>
        </div>
      </>
    );
  }

  if (step === 'storyboard') {
    return (
      <>
        <div className="editor-panel-heading">
          <div>
            <span className="panel-kicker">BƯỚC 2 · PHÂN CẢNH</span>
            <h2>ChatGPT phân tích lyric</h2>
          </div>
          <span className={`step-status-badge ${hasScript ? 'done' : ''}`}>
            {hasScript ? `${script!.scenes.length} scene` : 'Chưa'}
          </span>
        </div>
        {!hasMusic || !hasLyric ? (
          <div className="empty-panel">
            <strong>Thiếu input</strong>
            <p>Cần audio + lyric ở bước 1 trước.</p>
            <button type="button" className="editor-secondary" onClick={() => onGoStep('input')}>
              ← Về bước 1
            </button>
          </div>
        ) : (
          <>
            <p className="media-note">
              AI đọc lyric + độ dài nhạc để lập storyboard. Chọn số shot trước để kiểm soát chi phí
              Snapgen.
            </p>
            <div className="field compact-field duration-field scene-density-field">
              <div className="duration-field-head">
                <label>Số shot / cách chia</label>
                <span className="duration-field-live">
                  ~{sceneCountHint} shot · ~{formatDurationLabel(typicalBeatSec)}/scene
                </span>
              </div>
              <div className="duration-presets" role="group" aria-label="Mật độ scene">
                {SCENE_DENSITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`chip-btn ${sceneDensity === opt.id ? 'active' : ''}`}
                    title={opt.hint}
                    disabled={busy}
                    onClick={() => onSceneDensityChange(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="duration-custom">
                <div className="duration-input-wrap">
                  <input
                    type="number"
                    min={sceneCountMin}
                    max={sceneCountMax}
                    disabled={busy}
                    value={targetMediaCount}
                    onChange={(e) => {
                      onSceneDensityChange('custom');
                      onTargetMediaCountChange(Number(e.target.value));
                    }}
                  />
                  <span className="duration-unit">shot</span>
                </div>
              </div>
            </div>
            {draft?.musicStoryNotes ? (
              <p className="hint" style={{ whiteSpace: 'pre-wrap' }}>
                {draft.musicStoryNotes}
              </p>
            ) : null}
            {hasScript || draft?.musicCastLock ? (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="music-cast-lock">Cast lock (dán vào mọi prompt scene)</label>
                <textarea
                  id="music-cast-lock"
                  rows={4}
                  disabled={busy}
                  placeholder="VD: Mai — cô gái 17 tuổi, tóc đen ngang vai, mắt nâu, áo sơ mi trắng + cardigan vàng, đeo tai nghe đỏ…"
                  value={draft?.musicCastLock || ''}
                  onChange={(e) => onCastLockChange(e.target.value)}
                />
                <p className="hint">
                  Mỗi scene là một lần gen độc lập — đoạn này được lặp nguyên văn vào từng prompt để
                  nhân vật không bị vẽ khác nhau. Ghi đặc điểm cố định (tuổi, tóc, mắt, trang phục,
                  phụ kiện, palette), đừng ghi cốt truyện.
                </p>
              </div>
            ) : null}
            <div className="step-actions">
              <button
                type="button"
                className="editor-primary full-width"
                disabled={busy}
                onClick={onAnalyze}
              >
                {busy
                  ? 'Đang phân tích…'
                  : hasScript
                    ? `Phân tích lại (~${sceneCountHint} shot)`
                    : `Phân tích lyric → ~${sceneCountHint} shot`}
              </button>
              {hasScript ? (
                <button
                  type="button"
                  className="editor-secondary full-width"
                  disabled={busy}
                  onClick={() => onGoStep('media')}
                >
                  Tiếp: Tạo video Snapgen →
                </button>
              ) : null}
            </div>
            {hasScript ? (
              <div className="step-scene-summary" style={{ marginTop: 14 }}>
                <div className="editor-panel-heading compact">
                  <h3>{script!.title}</h3>
                </div>
                <ul className="merge-checklist">
                  {script!.scenes.map((s, i) => (
                    <li key={s.id}>
                      {i + 1}. {s.chapter || 'Beat'} · {Math.round(s.duration_hint)}s —{' '}
                      {(s.narration_segment || '').slice(0, 60)}
                      {(s.narration_segment || '').length > 60 ? '…' : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </>
    );
  }

  if (step === 'media') {
    const scenes = script?.scenes ?? [];
    const statusById = new Map((sceneStatuses || []).map((s) => [s.sceneId, s]));
    const rows = scenes.map((scene, index) => {
      const asset =
        sceneMedia.find((item) => item.sceneId === scene.id) ?? sceneMedia[index];
      const status = statusById.get(scene.id);
      const done = Boolean(asset?.exists);
      const running =
        !done &&
        (status?.state === 'generating' ||
          status?.state === 'polling' ||
          status?.state === 'retrying');
      return {
        scene,
        index,
        done,
        running,
        failed: !done && !running && status?.state === 'failed',
        error: status?.error,
      };
    });
    const doneCount = rows.filter((r) => r.done).length;
    // "Cần tạo lại" = mọi scene chưa có clip: gồm scene báo lỗi và scene chưa chạy.
    const retryRows = rows.filter((r) => !r.done && !r.running);
    const failedCount = rows.filter((r) => r.failed).length;
    const retryEstimate = estimateGenerationCredits({
      mediaKind,
      modelId,
      family,
      resolution,
      mode,
      durations: retryRows.map((r) => r.scene.duration_hint),
    });
    const allEstimate = estimateGenerationCredits({
      mediaKind,
      modelId,
      family,
      resolution,
      mode,
      durations: scenes.map((s) => s.duration_hint),
    });

    return (
      <>
        <div className="editor-panel-heading">
          <div>
            <span className="panel-kicker">BƯỚC 3 · SNAPGEN</span>
            <h2>Tạo video từng cảnh</h2>
          </div>
          <div className="panel-heading-actions">
            <span className={`step-status-badge ${step3Done ? 'done' : ''}`}>
              {doneCount}/{scenes.length} clip
            </span>
            {retryRows.length > 0 ? (
              <button
                type="button"
                className="editor-secondary heading-action"
                disabled={busy || !hasScript}
                title={retryRows.map((r) => `Scene ${r.index + 1}`).join(', ')}
                onClick={() => onRegenerateScenes(retryRows.map((r) => r.scene.id))}
              >
                ↻ Tạo lại {retryRows.length} cảnh {failedCount > 0 ? 'lỗi' : 'thiếu'}
              </button>
            ) : null}
          </div>
        </div>
        {!hasScript ? (
          <div className="empty-panel">
            <strong>Chưa có kịch bản</strong>
            <p>Chạy phân tích lyric ở bước 2 trước.</p>
            <button type="button" className="editor-secondary" onClick={() => onGoStep('storyboard')}>
              ← Về bước 2
            </button>
          </div>
        ) : (
          <>
            <p className="media-note">
              Gọi Snapgen theo visual_prompt từng scene. Thời lượng khớp beat lyric.
            </p>

            <ModelPicker
              mediaKind={mediaKind}
              families={families}
              models={models}
              family={family}
              modelId={modelId}
              aspectRatio={aspectRatio}
              outputFormat={outputFormat}
              resolution={resolution}
              mode={mode}
              onFamilyChange={onFamilyChange}
              onModelChange={onModelChange}
              onAspectRatioChange={onAspectRatioChange}
              onOutputFormatChange={onOutputFormatChange}
              onResolutionChange={onResolutionChange}
              onModeChange={onModeChange}
            />

            <div className="credit-estimate">
              <div className="credit-estimate-row">
                <span>Còn phải tạo ({retryRows.length} cảnh)</span>
                <strong>{formatCreditEstimate(retryEstimate)}</strong>
              </div>
              <div className="credit-estimate-row muted">
                <span>Nếu gen lại toàn bộ ({scenes.length} cảnh)</span>
                <strong>{formatCreditEstimate(allEstimate)}</strong>
              </div>
              <p className="hint">
                Ước tính theo bảng giá snapgen.ai/pricing (mỗi lượt gọi API). Video dài hơn giới hạn
                một shot sẽ bị chia thành nhiều lượt gọi.
              </p>
            </div>

            <div className="step-actions">
              <button
                type="button"
                className="editor-primary full-width"
                disabled={busy}
                onClick={onGenerateMedia}
              >
                {busy
                  ? 'Đang tạo media…'
                  : step3Done
                    ? 'Tạo lại media (chọn phạm vi)…'
                    : 'Tạo video Snapgen'}
              </button>
              {step3Done ? (
                <button
                  type="button"
                  className="editor-secondary full-width"
                  disabled={busy}
                  onClick={() => onGoStep('merge')}
                >
                  Tiếp: Ghép nhạc + video →
                </button>
              ) : null}
            </div>

            <ul className="scene-state-list">
              {rows.map((row) => (
                <li
                  key={row.scene.id}
                  className={
                    row.done ? 'ok' : row.failed ? 'failed' : row.running ? 'running' : 'pending'
                  }
                >
                  <span className="scene-state-mark" aria-hidden="true">
                    {row.done ? '✓' : row.failed ? '✕' : row.running ? '◌' : '○'}
                  </span>
                  <span className="scene-state-body">
                    <span className="scene-state-title">
                      Scene {row.index + 1} · {Math.round(row.scene.duration_hint)}s
                      {row.scene.chapter ? ` · ${row.scene.chapter}` : ''}
                    </span>
                    {row.error ? (
                      <span className="scene-state-error" title={row.error}>
                        {row.error}
                      </span>
                    ) : (
                      <span className="scene-state-sub">
                        {(row.scene.narration_segment || row.scene.visual_prompt || '').slice(0, 70)}
                      </span>
                    )}
                  </span>
                  {!row.done && !row.running ? (
                    <button
                      type="button"
                      className="btn ghost scene-state-retry"
                      disabled={busy}
                      onClick={() => onRegenerateScenes([row.scene.id])}
                    >
                      ↻
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  // merge
  return (
    <>
      <div className="editor-panel-heading">
        <div>
          <span className="panel-kicker">BƯỚC 4 · GHÉP</span>
          <h2>Ghép nhạc + video</h2>
        </div>
        <span className={`step-status-badge ${step4Done ? 'done' : ''}`}>
          {step4Done ? 'Có final' : 'Chưa'}
        </span>
      </div>
      <p className="media-note">
        Mux clip Snapgen với audio bài hát đã upload (không TTS). Output final.mp4.
      </p>
      <ul className="merge-checklist">
        <li className={hasMusic ? 'ok' : ''}>1. Nhạc {hasMusic ? '✓' : '—'}</li>
        <li className={hasScript ? 'ok' : ''}>2. Phân cảnh {hasScript ? '✓' : '—'}</li>
        <li className={step3Done ? 'ok' : ''}>3. Media {step3Done ? '✓' : '—'}</li>
      </ul>
      <div className="step-actions">
        <button
          type="button"
          className="editor-primary full-width"
          disabled={busy || !hasMusic || !step3Done}
          onClick={onMerge}
        >
          {busy ? 'Đang ghép…' : step4Done ? 'Ghép lại Final' : 'Ghép nhạc + video'}
        </button>
      </div>
    </>
  );
}
