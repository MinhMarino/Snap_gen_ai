import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenmaxBackend, GenmaxVoice } from '../../shared/types';

const BACKENDS: Array<{ id: GenmaxBackend; label: string; hint: string }> = [
  { id: 'elevenlabs', label: 'ElevenLabs', hint: 'Premade + shared library' },
  { id: 'minimax', label: 'MiniMax', hint: 'System voices' },
  { id: 'capcut', label: 'CapCut', hint: 'Giọng CapCut / VI' },
];

function voiceMeta(v: GenmaxVoice): string {
  return [v.gender, v.language || v.accent, v.age, v.category].filter(Boolean).join(' · ');
}

function extractVoiceId(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  // URL kiểu …/voices/xxx hoặc query voice_id=
  try {
    if (/^https?:\/\//i.test(t)) {
      const u = new URL(t);
      const q = u.searchParams.get('voice_id') || u.searchParams.get('voiceId');
      if (q) return q.trim();
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => p === 'voices' || p === 'voice');
      if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
      return decodeURIComponent(parts[parts.length - 1] || '');
    }
  } catch {
    /* plain id */
  }
  return t;
}

export default function GenmaxVoicePicker({
  backend,
  value,
  speed,
  disabled,
  onChange,
  onVoiceResolved,
  onBackendChange,
}: {
  backend: GenmaxBackend;
  value: string;
  /** Tốc độ đọc khi nghe thử (nếu có). */
  speed?: number;
  disabled?: boolean;
  onChange: (voice: GenmaxVoice) => void;
  /** Giọng đang chọn sau khi load xong list — chỉ để đồng bộ metadata, không đổi lựa chọn. */
  onVoiceResolved?: (voice: GenmaxVoice) => void;
  onBackendChange: (backend: GenmaxBackend) => void;
}) {
  const [voices, setVoices] = useState<GenmaxVoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [customId, setCustomId] = useState('');
  const [idMsg, setIdMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const searchTimer = useRef<number | null>(null);

  const stopPreview = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
  };

  const load = async (searchOverride?: string) => {
    setBusy(true);
    setError(null);
    try {
      const search = (searchOverride ?? query).trim() || undefined;
      const list = await window.studio.listGenmaxVoices({
        backend,
        search,
        pageSize: 80,
      });
      setVoices(list);
      // Giữ selection hiện tại; chỉ gợi ý mặc định khi chưa có value.
      if (!value?.trim() && list[0]) onChange(list[0]);
      // Báo metadata của giọng ĐANG chọn để panel đồng bộ ngôn ngữ lời bình —
      // dự án tạo trước tính năng này chưa có ngôn ngữ nào được lưu.
      else {
        const current = list.find((v) => v.voiceId === value);
        if (current) onVoiceResolved?.(current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load('');
    setQuery('');
    setCustomId('');
    setIdMsg(null);
    stopPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  useEffect(() => () => stopPreview(), []);

  // Debounce tìm trên server khi gõ (kèm filter local tức thì).
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      void load(query);
    }, 420);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter((v) =>
      `${v.name} ${v.description || ''} ${v.language || ''} ${v.gender || ''} ${v.voiceId} ${v.uniqId || ''}`
        .toLowerCase()
        .includes(q)
    );
  }, [voices, query]);

  const selected =
    voices.find((v) => v.voiceId === value) ||
    (value
      ? ({
          voiceId: value,
          name: value.length > 28 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value,
          backend,
          category: 'custom-id',
          description: 'Giọng chọn bằng ID (không có trong list hiện tại)',
        } satisfies GenmaxVoice)
      : undefined);

  const preview = async (voice: GenmaxVoice) => {
    if (playingId === voice.voiceId) {
      stopPreview();
      return;
    }
    setPreviewBusy(true);
    setError(null);
    try {
      stopPreview();
      // Sample URL không áp dụng speed — khi user chỉnh tốc độ thì TTS preview ngắn.
      const useSample = Boolean(voice.previewUrl) && (speed == null || Math.abs(speed - 1) < 0.01);
      let src = useSample ? voice.previewUrl || '' : '';
      if (!src) {
        const { dataUrl } = await window.studio.previewGenmaxVoice({
          voiceId: voice.voiceId,
          backend,
          speed,
        });
        src = dataUrl;
      }
      const el = new Audio(src);
      audioRef.current = el;
      setPlayingId(voice.voiceId);
      el.onended = () => stopPreview();
      await el.play();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewBusy(false);
    }
  };

  const applyCustomId = async (alsoPreview: boolean) => {
    const voiceId = extractVoiceId(customId);
    if (!voiceId) {
      setIdMsg({ type: 'error', text: 'Dán voice ID hoặc URL chứa voice id.' });
      return;
    }
    const voice: GenmaxVoice = {
      voiceId,
      name: voiceId,
      backend,
      category: 'custom-id',
      description: 'Đã thêm bằng ID',
    };
    // Nếu ID đã có trong list → dùng meta đẹp hơn.
    const known = voices.find((v) => v.voiceId === voiceId || v.uniqId === voiceId);
    const next = known || voice;
    onChange(next);
    setCustomId(voiceId);
    setIdMsg({
      type: 'ok',
      text: known
        ? `Đã chọn «${known.name}»`
        : `Đã gắn voice ID — dùng trực tiếp khi TTS (GenMax không cần Add library).`,
    });
    if (alsoPreview) await preview(next);
  };

  return (
    <div className={`genmax-voice-picker ${disabled ? 'disabled' : ''}`}>
      <div className="genmax-voice-head">
        <div>
          <strong>Chọn giọng GenMax</strong>
          <p className="hint">Tìm theo tên, lọc provider, hoặc dán voice ID / URL.</p>
        </div>
        <button
          type="button"
          className="btn ghost"
          disabled={disabled || busy}
          onClick={() => void load(query)}
        >
          {busy ? 'Đang tải…' : 'Tải lại'}
        </button>
      </div>

      <div className="genmax-backend-tabs" role="tablist" aria-label="GenMax provider">
        {BACKENDS.map((b) => {
          const active = backend === b.id;
          return (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`genmax-backend-tab ${active ? 'active' : ''}`}
              disabled={disabled}
              onClick={() => onBackendChange(b.id)}
            >
              <strong>{b.label}</strong>
              <span>{b.hint}</span>
            </button>
          );
        })}
      </div>

      <div className="genmax-voice-selected">
        <div className="genmax-voice-selected-main">
          <span className="genmax-voice-kicker">Đang chọn</span>
          <strong>{selected?.name || 'Chưa chọn giọng'}</strong>
          <p className="hint">
            {selected
              ? voiceMeta(selected) || selected.description || selected.voiceId
              : 'Chọn một giọng bên dưới hoặc dán ID'}
          </p>
          {selected ? (
            <code className="genmax-voice-id" title={selected.voiceId}>
              {selected.voiceId}
            </code>
          ) : null}
        </div>
        {selected ? (
          <button
            type="button"
            className="btn"
            disabled={disabled || previewBusy}
            onClick={() => void preview(selected)}
          >
            {playingId === selected.voiceId ? '⏸ Dừng' : previewBusy ? '…' : '▶ Nghe thử'}
          </button>
        ) : null}
      </div>

      <div className="genmax-voice-toolbar">
        <label className="genmax-search-field">
          <span>Tìm giọng</span>
          <input
            type="search"
            value={query}
            disabled={disabled || busy}
            placeholder="Tên, mô tả, gender, language, hoặc một phần ID…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(query);
            }}
            aria-label="Tìm giọng GenMax"
          />
        </label>
        <div className="genmax-add-by-id">
          <label>
            <span>Thêm bằng ID / URL</span>
            <div className="genmax-add-by-id-row">
              <input
                type="text"
                value={customId}
                disabled={disabled}
                placeholder="hpp4J3… hoặc https://…/voices/…"
                onChange={(e) => {
                  setCustomId(e.target.value);
                  setIdMsg(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyCustomId(false);
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={disabled || !customId.trim()}
                onClick={() => void applyCustomId(false)}
              >
                Dùng ID
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={disabled || !customId.trim() || previewBusy}
                title="Gắn ID và nghe thử (gọi TTS ngắn nếu không có sample)"
                onClick={() => void applyCustomId(true)}
              >
                ▶
              </button>
            </div>
          </label>
          {idMsg ? <p className={`hint ${idMsg.type}`}>{idMsg.text}</p> : null}
        </div>
      </div>

      <div className="genmax-voice-list" role="listbox" aria-label="Danh sách giọng GenMax">
        {busy && voices.length === 0 ? (
          <p className="muted pad">Đang tải danh sách giọng…</p>
        ) : filtered.length === 0 ? (
          <p className="muted pad">
            Không thấy giọng khớp. Thử xóa ô tìm, đổi provider, hoặc dán voice ID bên trên.
          </p>
        ) : (
          filtered.map((voice) => {
            const active = voice.voiceId === value;
            const playing = playingId === voice.voiceId;
            return (
              <div
                key={`${voice.backend}-${voice.voiceId}`}
                className={`genmax-voice-row ${active ? 'active' : ''}`}
                role="option"
                aria-selected={active}
              >
                <button
                  type="button"
                  className="genmax-voice-pick"
                  disabled={disabled}
                  onClick={() => onChange(voice)}
                >
                  <strong>{voice.name}</strong>
                  <span>{voiceMeta(voice) || voice.voiceId}</span>
                  {voice.description ? (
                    <em className="genmax-voice-desc">{voice.description}</em>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="btn ghost genmax-voice-play"
                  disabled={disabled || previewBusy}
                  title={voice.previewUrl ? 'Nghe sample' : 'TTS ngắn để nghe thử'}
                  onClick={() => void preview(voice)}
                >
                  {playing ? '⏸' : '▶'}
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="genmax-voice-footer">
        <span>
          {filtered.length}/{voices.length} giọng · {backend}
        </span>
        <span className="hint">Enter ở ô tìm = tìm lại trên GenMax</span>
      </div>
      {error ? <p className="msg error">{error}</p> : null}
    </div>
  );
}
