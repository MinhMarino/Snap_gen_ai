import { useEffect, useRef } from 'react';
import type { JobProgress } from '../../shared/types';
import JobProgressView from './JobProgress';

export type ActivityLogLevel = 'info' | 'ok' | 'warn' | 'error';

export type ActivityLogLine = {
  id: string;
  at: number;
  text: string;
  level?: ActivityLogLevel;
};

export type ActivityStatus = 'running' | 'done' | 'error';

export type StepActivityState = {
  stepId: string;
  title: string;
  blurb: string;
  percent: number;
  status: ActivityStatus;
  logs: ActivityLogLine[];
  /** Center popup visible (có thể thu nhỏ xuống dock). */
  modalOpen: boolean;
  /** Dock dưới luôn hiện khi activity còn. */
  dockOpen: boolean;
  showJobControls?: boolean;
  jobProgress?: JobProgress | null;
};

let logSeq = 0;

export function createLogLine(text: string, level: ActivityLogLevel = 'info'): ActivityLogLine {
  logSeq += 1;
  return { id: `log-${Date.now()}-${logSeq}`, at: Date.now(), text, level };
}

export function formatLogTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`;
}

export default function StepActivityUI({
  activity,
  onMinimize,
  onExpand,
  onDismiss,
}: {
  activity: StepActivityState | null;
  onMinimize: () => void;
  onExpand: () => void;
  onDismiss: () => void;
}) {
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const dockLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activity?.logs.length, activity?.modalOpen]);

  useEffect(() => {
    const el = dockLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activity?.logs.length, activity?.dockOpen]);

  if (!activity || (!activity.modalOpen && !activity.dockOpen)) return null;

  const percent = Math.min(100, Math.max(0, activity.percent));
  const statusLabel =
    activity.status === 'done' ? 'Hoàn tất' : activity.status === 'error' ? 'Lỗi' : 'Đang chạy';
  const canDismiss = activity.status === 'done' || activity.status === 'error';

  return (
    <>
      {activity.modalOpen ? (
        <div className="modal-backdrop step-activity-backdrop" role="presentation">
          <div
            className="modal-card step-activity-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="step-activity-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <div>
                <p className="step-activity-kicker">{statusLabel}</p>
                <h2 id="step-activity-title">{activity.title}</h2>
                <p>{activity.blurb}</p>
              </div>
              <div className="step-activity-header-actions">
                <button type="button" className="btn ghost" onClick={onMinimize}>
                  Thu nhỏ
                </button>
                {canDismiss ? (
                  <button type="button" className="icon-button" onClick={onDismiss} aria-label="Đóng">
                    ×
                  </button>
                ) : null}
              </div>
            </header>

            <div className="step-activity-body">
              <div className="step-activity-progress-row">
                <strong>{percent}%</strong>
                <span>{activity.jobProgress?.message || activity.logs.at(-1)?.text || 'Đang xử lý…'}</span>
              </div>
              <div
                className={`step-activity-bar ${activity.status === 'running' && percent < 8 ? 'indeterminate' : ''}`}
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${Math.max(percent, activity.status === 'running' ? 8 : 0)}%` }} />
              </div>

              {activity.showJobControls && activity.jobProgress ? (
                <div className="step-activity-job">
                  <JobProgressView progress={activity.jobProgress} showControls />
                </div>
              ) : null}

              <div className="step-activity-log" aria-live="polite" aria-label="Nhật ký bước">
                {activity.logs.length === 0 ? (
                  <p className="hint">Chưa có log…</p>
                ) : (
                  activity.logs.map((line) => (
                    <div key={line.id} className={`step-activity-log-line level-${line.level || 'info'}`}>
                      <time dateTime={new Date(line.at).toISOString()}>{formatLogTime(line.at)}</time>
                      <span>{line.text}</span>
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </div>

            <footer className="modal-footer">
              <button type="button" className="btn" onClick={onMinimize}>
                Chạy nền (giữ dock dưới)
              </button>
              {canDismiss ? (
                <button type="button" className="btn primary" onClick={onDismiss}>
                  Đóng
                </button>
              ) : null}
            </footer>
          </div>
        </div>
      ) : null}

      {activity.dockOpen ? (
        <div
          className={`step-activity-dock status-${activity.status}`}
          role="status"
          aria-live="polite"
        >
          <div className="step-activity-dock-main">
            <div className="step-activity-dock-copy">
              <strong>
                {activity.title} · {percent}%
              </strong>
              <span>
                {activity.jobProgress?.message || activity.logs.at(-1)?.text || statusLabel}
              </span>
            </div>
            <div className="step-activity-dock-actions">
              {!activity.modalOpen ? (
                <button type="button" className="btn" onClick={onExpand}>
                  Mở popup
                </button>
              ) : null}
              {canDismiss ? (
                <button type="button" className="btn primary" onClick={onDismiss}>
                  Đóng
                </button>
              ) : (
                <button type="button" className="btn ghost" onClick={onMinimize}>
                  Thu nhỏ
                </button>
              )}
            </div>
          </div>
          <div
            className={`step-activity-bar dock ${activity.status === 'running' && percent < 8 ? 'indeterminate' : ''}`}
          >
            <span style={{ width: `${Math.max(percent, activity.status === 'running' ? 8 : 0)}%` }} />
          </div>
          <div className="step-activity-dock-log" ref={dockLogRef}>
            {activity.logs.slice(-8).map((line) => (
              <div key={line.id} className={`step-activity-log-line level-${line.level || 'info'}`}>
                <time>{formatLogTime(line.at)}</time>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
