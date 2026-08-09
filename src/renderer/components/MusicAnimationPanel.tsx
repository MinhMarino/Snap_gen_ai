import type { ProjectDraft, ScriptDraft } from '../../shared/types';
import {
  formatDurationLabel,
  SCENE_DENSITY_OPTIONS,
  type SceneDensityId,
} from '../../shared/models';

export type MusicWorkflowStep = 'input' | 'storyboard' | 'media' | 'merge';

type Props = {
  step: MusicWorkflowStep;
  draft: ProjectDraft | null;
  script: ScriptDraft | null;
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
  onImportMusic: () => void;
  onClearMusic: () => void;
  onImportCharacters: () => void;
  onClearCharacters: () => void;
  onAnalyze: () => void;
  onGenerateMedia: () => void;
  onMerge: () => void;
  onGoStep: (step: MusicWorkflowStep) => void;
};

export default function MusicAnimationPanel({
  step,
  draft,
  script,
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
  onImportMusic,
  onClearMusic,
  onImportCharacters,
  onClearCharacters,
  onAnalyze,
  onGenerateMedia,
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
    return (
      <>
        <div className="editor-panel-heading">
          <div>
            <span className="panel-kicker">BƯỚC 3 · SNAPGEN</span>
            <h2>Tạo video từng cảnh</h2>
          </div>
          <span className={`step-status-badge ${step3Done ? 'done' : ''}`}>
            {step3Done ? 'Đủ clip' : 'Chưa đủ'}
          </span>
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
            <div className="step-actions">
              <button
                type="button"
                className="editor-primary full-width"
                disabled={busy}
                onClick={onGenerateMedia}
              >
                {busy ? 'Đang tạo media…' : step3Done ? 'Tạo lại media thiếu / recreate' : 'Tạo video Snapgen'}
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
