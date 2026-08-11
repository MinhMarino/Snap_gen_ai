import { useCallback, useEffect, useState } from 'react';
import type { ProjectKind, ProjectMeta } from '../../shared/types';
import { resolveProjectKind } from '../../shared/types';

interface Props {
  onOpenProject: (id: string) => void;
  onCreateAndOpen: (id: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Nháp',
  generating: 'Đang gen',
  ready: 'Hoàn tất',
  error: 'Lỗi',
};

const KIND_LABEL: Record<ProjectKind, string> = {
  standard: 'Thường',
  'music-animation': 'Nhạc hoạt hình',
  'audio-only': 'Chỉ audio',
};

export default function Projects({ onOpenProject, onCreateAndOpen }: Props) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<ProjectKind>('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [liveJobId, setLiveJobId] = useState<string | null>(null);
  const [livePercent, setLivePercent] = useState<number | null>(null);

  const [projectsRoot, setProjectsRoot] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProjects(await window.studio.listProjects());
    try {
      setProjectsRoot(await window.studio.getProjectsRoot());
    } catch {
      setProjectsRoot(null);
    }
    try {
      const job = await window.studio.getActiveJob();
      setLiveJobId(job.active ? job.projectId : null);
      setLivePercent(job.active ? job.progress?.percent ?? 0 : null);
    } catch {
      setLiveJobId(null);
      setLivePercent(null);
    }
  }, []);

  const openProjectsFolder = async () => {
    try {
      const root = projectsRoot || (await window.studio.getProjectsRoot());
      setProjectsRoot(root);
      const err = await window.studio.openPath(root);
      if (err) setError(err);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openOneProjectFolder = async (projectId: string) => {
    try {
      const detail = await window.studio.getProject(projectId);
      const err = await window.studio.openPath(detail.projectDir);
      if (err) setError(err);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While any project is "generating", keep the list fresh so badge flips to Hoàn tất.
  useEffect(() => {
    const hasGenerating = projects.some((p) => p.status === 'generating');
    if (!hasGenerating && !liveJobId) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [projects, refresh, liveJobId]);

  useEffect(() => {
    return window.studio.onJobFinished(() => {
      void refresh();
    });
  }, [refresh]);

  useEffect(() => {
    return window.studio.onJobProgress((p) => {
      setLivePercent(p.percent ?? 0);
    });
  }, []);
  const create = async () => {
    if (!newName.trim()) {
      setError('Nhập tên dự án trước.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta = await window.studio.createProject({
        name: newName.trim(),
        projectKind: newKind,
      });
      setNewName('');
      await refresh();
      onCreateAndOpen(meta.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (id: string) => {
    if (!renameValue.trim()) {
      setError('Tên dự án không được để trống.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.studio.renameProject(id, renameValue.trim());
      setRenamingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, name: string) => {
    const ok = window.confirm(`Xóa dự án "${name}"? Thư mục media cũng sẽ bị xóa.`);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await window.studio.deleteProject(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-hero">
        <p className="eyebrow">Library</p>
        <h1>Dự án</h1>
        <p className="sub">Tạo dự án mới với tên riêng, mở lại, đổi tên hoặc xóa.</p>
        <div className="create-row" style={{ marginTop: 12, marginBottom: 0, alignItems: 'center' }}>
          <button
            type="button"
            className="btn"
            onClick={() => void openProjectsFolder()}
            title={projectsRoot || 'Mở thư mục chứa tất cả dự án trong Finder'}
          >
            Mở thư mục dự án
          </button>
          {projectsRoot ? (
            <span className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {projectsRoot}
            </span>
          ) : null}
        </div>
      </div>

      <div className="create-row">
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label htmlFor="new-project">Tên dự án mới</label>
          <input
            id="new-project"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Ví dụ: Cafe Da Nang — teaser 30s"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
        </div>
        <div className="field" style={{ width: 220, marginBottom: 0 }}>
          <label htmlFor="new-project-kind">Loại dự án</label>
          <select
            id="new-project-kind"
            value={newKind}
            onChange={(e) => setNewKind(resolveProjectKind(e.target.value))}
          >
            <option value="standard">Bình thường (video)</option>
            <option value="audio-only">Chỉ audio (ElevenLabs)</option>
            <option value="music-animation">Video hoạt hình nhạc</option>
          </select>
        </div>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>
          Tạo &amp; mở
        </button>
      </div>

      {projects.length === 0 ? (
        <p className="muted" style={{ marginTop: 24 }}>
          Chưa có dự án nào. Tạo dự án đầu tiên ở trên.
        </p>
      ) : (
        <div className="project-list">
          {projects.map((p) => (
            <div className="project-card" key={p.id}>
              <div className="project-main">
                {renamingId === p.id ? (
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename(p.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <div>
                    <strong>{p.name}</strong>
                    <div className="muted" style={{ marginTop: 4 }}>
                      <span className={`badge badge-${p.status}`}>
                        {liveJobId === p.id && livePercent != null
                          ? `Đang gen ${Math.round(livePercent)}%`
                          : STATUS_LABEL[p.status] ?? p.status}
                      </span>
                      {' · '}
                      {KIND_LABEL[resolveProjectKind(p.projectKind)]}
                      {' · '}
                      {p.model ?? '—'}
                      {' · '}
                      cập nhật {new Date(p.updatedAt).toLocaleString('vi-VN')}
                    </div>
                    {p.brief ? (
                      <div className="muted" style={{ marginTop: 6 }}>
                        {p.brief.slice(0, 120)}
                        {p.brief.length > 120 ? '…' : ''}
                      </div>
                    ) : null}
                    {p.status === 'error' && p.lastError ? (
                      <div className="msg error" style={{ marginTop: 8 }}>
                        {p.lastError}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="project-actions">
                {renamingId === p.id ? (
                  <>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void saveRename(p.id)}
                    >
                      Lưu tên
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setRenamingId(null)}>
                      Hủy
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn primary" onClick={() => onOpenProject(p.id)}>
                      Mở
                    </button>
                    <button
                      type="button"
                      className="btn"
                      title="Mở thư mục dự án này trong Finder"
                      onClick={() => void openOneProjectFolder(p.id)}
                    >
                      Thư mục
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setRenamingId(p.id);
                        setRenameValue(p.name);
                      }}
                    >
                      Đổi tên
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy}
                      onClick={() => void remove(p.id, p.name)}
                    >
                      Xóa
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="msg error">{error}</div>}
    </div>
  );
}
