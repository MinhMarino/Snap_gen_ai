import type { JobProgress, SceneJobState } from '../../shared/types';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Chờ',
  script: 'Phân cảnh',
  tts: 'Voiceover',
  whisper: 'Đồng bộ lời',
  video: 'Render video',
  image: 'Render ảnh',
  merge: 'Ghép final',
  paused: 'Tạm dừng',
  done: 'Xong',
  error: 'Lỗi',
};

const SCENE_STATE_LABEL: Record<SceneJobState, string> = {
  queued: 'Queued',
  generating: 'Generating',
  polling: 'Polling',
  retrying: 'Retrying',
  completed: 'Completed',
  cached: 'Cached',
  failed: 'Failed',
  skipped: 'Skipped',
};

const SCENE_STATE_ICON: Record<SceneJobState, string> = {
  queued: '·',
  generating: '…',
  polling: '⟳',
  retrying: '⚠',
  completed: '✓',
  cached: '✓',
  failed: '✕',
  skipped: '–',
};

export default function JobProgressView({
  progress,
  showControls,
}: {
  progress: JobProgress | null;
  /** Hiện nút Tạm dừng / Tiếp tục / Dừng khi job đang chạy. */
  showControls?: boolean;
}) {
  const percent = Math.min(100, Math.max(0, progress?.percent ?? 0));
  const isError = progress?.phase === 'error';
  const control = progress?.control || 'running';
  const isPaused = control === 'paused' || progress?.phase === 'paused';
  const isStopping = control === 'stop';
  const phaseLabel = progress?.phase ? PHASE_LABEL[progress.phase] || progress.phase : '';
  const detail =
    progress?.detailPercent != null &&
    (progress.phase === 'video' || progress.phase === 'image' || progress.phase === 'paused')
      ? Math.min(100, Math.max(0, progress.detailPercent))
      : null;
  const statuses = progress?.sceneStatuses;
  const completed =
    progress?.scenesCompleted ??
    statuses?.filter((s) => s.state === 'completed' || s.state === 'cached').length;
  const total = progress?.sceneTotal ?? statuses?.length;
  const canControl =
    Boolean(showControls) &&
    Boolean(progress) &&
    progress!.phase !== 'done' &&
    progress!.phase !== 'error' &&
    progress!.phase !== 'idle';

  return (
    <div className="progress-wrap">
      <div className="progress-head">
        <div>
          <span
            className={`status-dot ${
              progress && progress.phase !== 'idle'
                ? isPaused || isStopping
                  ? 'paused'
                  : 'on'
                : ''
            }`}
          />
          {progress?.message || 'Chờ bắt đầu...'}
        </div>
        <strong className="progress-overall">{percent}%</strong>
      </div>

      {(total != null && completed != null) ||
      (progress?.sceneTotal != null && progress.sceneIndex != null) ||
      detail != null ? (
        <p className="progress-meta muted">
          {phaseLabel ? `${phaseLabel} · ` : ''}
          {total != null && completed != null
            ? `${completed} / ${total} scenes`
            : progress?.sceneTotal != null && progress.sceneIndex != null
              ? `Scene ${progress.sceneIndex + 1}/${progress.sceneTotal}`
              : null}
          {progress?.maxConcurrent != null ? ` · ${progress.maxConcurrent} workers` : null}
          {progress?.chunkTotal != null &&
          progress.chunkTotal > 1 &&
          progress.chunkIndex != null
            ? ` · đoạn ${progress.chunkIndex + 1}/${progress.chunkTotal}`
            : null}
          {detail != null ? ` · shot Snapgen ${detail}%` : null}
        </p>
      ) : null}

      <div className="bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${percent}%` }} />
      </div>

      {detail != null ? (
        <div className="bar bar-detail" title="Tiến độ render shot hiện tại trên Snapgen">
          <span style={{ width: `${detail}%` }} />
        </div>
      ) : null}

      {canControl ? (
        <div className="job-control-actions">
          {!isPaused && !isStopping ? (
            <button
              type="button"
              className="btn"
              onClick={() => void window.studio.pauseJob()}
              title="Ngừng tạo scene mới — tiết kiệm token"
            >
              Tạm dừng
            </button>
          ) : null}
          {isPaused && !isStopping ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => void window.studio.resumeJob()}
            >
              Tiếp tục
            </button>
          ) : null}
          <button
            type="button"
            className="btn danger"
            disabled={isStopping}
            onClick={() => {
              if (
                window.confirm(
                  'Dừng job? Scene còn lại sẽ bị bỏ (không tốn thêm token). Scene đã xong vẫn giữ.'
                )
              ) {
                void window.studio.stopJob();
              }
            }}
          >
            {isStopping ? 'Đang dừng…' : 'Dừng'}
          </button>
        </div>
      ) : null}

      {statuses && statuses.length > 0 ? (
        <ul className="scene-job-list" aria-label="Trạng thái từng scene">
          {statuses.map((scene) => (
            <li
              key={scene.sceneId}
              className={`scene-job-item state-${scene.state}`}
              title={scene.error || SCENE_STATE_LABEL[scene.state]}
            >
              <span className="scene-job-icon">{SCENE_STATE_ICON[scene.state]}</span>
              <span className="scene-job-label">
                Scene {scene.sceneIndex + 1}
                {scene.chunkTotal != null && scene.chunkTotal > 1 && scene.chunkIndex != null
                  ? ` · đoạn ${scene.chunkIndex + 1}/${scene.chunkTotal}`
                  : ''}
              </span>
              <span className="scene-job-state">
                {SCENE_STATE_LABEL[scene.state]}
                {scene.state === 'polling' && scene.detailPercent != null
                  ? ` ${scene.detailPercent}%`
                  : ''}
                {scene.state === 'retrying' && scene.attempt
                  ? ` #${scene.attempt}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {isError && progress?.error && <div className="msg error">{progress.error}</div>}
    </div>
  );
}
