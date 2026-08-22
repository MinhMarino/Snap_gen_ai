import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenmaxBackend, GenmaxVoice } from '../../shared/types';

const BACKENDS: Array<{ id: GenmaxBackend; label: string; hint: string }> = [
  { id: 'elevenlabs', label: 'ElevenLabs', hint: 'Premade + shared library' },
  { id: 'minimax', label: 'MiniMax', hint: 'System voices' },
  { id: 'capcut', label: 'CapCut', hint: 'Giọng CapCut / VI' },
];

const LANG_FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Tất cả' },
  { id: 'ja', label: 'Japanese' },
  { id: 'vi', label: 'Vietnamese' },
  { id: 'en', label: 'English' },
  { id: 'ko', label: 'Korean' },
  { id: 'zh', label: 'Chinese' },
  { id: 'th', label: 'Thai' },
  { id: 'id', label: 'Indonesian' },
];

/** Cache theo backend + ngôn ngữ — giống GenMax app: đổi filter thì fetch lại. */
const voicesCache = new Map<string, GenmaxVoice[]>();

function cacheKey(backend: GenmaxBackend, language: string): string {
  return `${backend}::${language || 'all'}`;
}

function voiceMeta(v: GenmaxVoice): string {
  return [v.gender, v.language || v.accent, v.age, v.category].filter(Boolean).join(' · ');
}

function extractVoiceId(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
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

function previewLanguageFor(voice: GenmaxVoice, filterLang: string): string {
  const fromVoice = String(voice.language || '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  if (fromVoice && fromVoice.length <= 3) return fromVoice;
  if (filterLang) return filterLang;
  return 'en';
}

export default function GenmaxVoicePicker({
  backend,
  value,
  language,
  speed,
  disabled,
  onChange,
  onVoiceResolved,
  onBackendChange,
}: {
  backend: GenmaxBackend;
  value: string;
  /** Ngôn ngữ lời bình (ISO) — lọc thư viện GenMax, vd. ja. */
  language?: string;
  speed?: number;
  disabled?: boolean;
  onChange: (voice: GenmaxVoice) => void;
  onVoiceResolved?: (voice: GenmaxVoice) => void;
  onBackendChange: (backend: GenmaxBackend) => void;
}) {
  const initialLang = String(language || '').trim().toLowerCase();
  const [langFilter, setLangFilter] = useState(initialLang);
  const [voices, setVoices] = useState<GenmaxVoice[]>(
    () => voicesCache.get(cacheKey(backend, initialLang)) || []
  );
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [customId, setCustomId] = useState('');
  const [idMsg, setIdMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadSeq = useRef(0);

  const stopPreview = () => {
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      const src = audioRef.current.src;
      audioRef.current.src = '';
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
    }
    audioRef.current = null;
    setPlayingId(null);
  };

  const dataUrlToObjectUrl = (dataUrl: string): string => {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
    if (!m || !m[2]) return dataUrl;
    try {
      const mime = (m[1] || 'audio/mpeg').trim();
      const binary = atob(m[3]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch {
      return dataUrl;
    }
  };

  const playSrc = (voiceId: string, src: string, playbackRate = 1) =>
    new Promise<void>((resolve, reject) => {
      stopPreview();
      const audio = new Audio();
      audio.preload = 'auto';
      audio.volume = 1;
      audio.playbackRate = Math.min(2, Math.max(0.5, playbackRate || 1));
      audioRef.current = audio;
      setPlayingId(voiceId);
      audio.onended = () => stopPreview();
      audio.onerror = () => {
        stopPreview();
        reject(new Error('Không phát được audio preview (file lỗi hoặc URL hỏng).'));
      };
      audio.src = src;
      void audio
        .play()
        .then(() => resolve())
        .catch((err) => {
          stopPreview();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

  const preview = async (voice: GenmaxVoice) => {
    if (playingId === voice.voiceId) {
      stopPreview();
      return;
    }
    setPreviewBusy(true);
    setError(null);
    try {
      if (voice.previewUrl?.trim()) {
        try {
          await playSrc(voice.voiceId, voice.previewUrl.trim(), speed ?? 1);
          return;
        } catch {
          /* CDN fail → thử qua main */
        }
      }

      const { dataUrl, fromSample } = await window.studio.previewGenmaxVoice({
        voiceId: voice.voiceId,
        backend,
        speed,
        language: previewLanguageFor(voice, langFilter),
        sampleUrl: voice.previewUrl,
      });
      const src = dataUrlToObjectUrl(dataUrl);
      const rate = fromSample ? speed ?? 1 : 1;
      await playSrc(voice.voiceId, src, rate);
    } catch (err) {
      stopPreview();
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').trim();
      setError(msg || raw);
    } finally {
      setPreviewBusy(false);
    }
  };

  const applyLoadedList = (list: GenmaxVoice[]) => {
    setVoices(list);
    if (!value?.trim() && list[0]) onChange(list[0]);
    else {
      const current = list.find((v) => v.voiceId === value);
      if (current) onVoiceResolved?.(current);
    }
  };

  const load = async (opts?: { force?: boolean; remoteSearch?: string }) => {
    const seq = ++loadSeq.current;
    const remoteSearch = opts?.remoteSearch?.trim() || undefined;
    const key = cacheKey(backend, langFilter);
    const cached = voicesCache.get(key);

    if (!opts?.force && !remoteSearch && cached?.length) {
      applyLoadedList(cached);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const list = await window.studio.listGenmaxVoices({
        backend,
        search: remoteSearch,
        language: langFilter || undefined,
        pageSize: 100,
      });
      if (seq !== loadSeq.current) return;
      if (!remoteSearch) voicesCache.set(key, list);
      applyLoadedList(list);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };

  useEffect(() => {
    const next = String(language || '').trim().toLowerCase();
    setLangFilter(next);
  }, [language]);

  useEffect(() => {
    setQuery('');
    setCustomId('');
    setIdMsg(null);
    setError(null);
    stopPreview();
    const key = cacheKey(backend, langFilter);
    const cached = voicesCache.get(key);
    if (cached?.length) {
      setVoices(cached);
      applyLoadedList(cached);
    } else {
      setVoices([]);
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, langFilter]);

  useEffect(() => () => stopPreview(), []);

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

  const langLabel = LANG_FILTERS.find((l) => l.id === langFilter)?.label || langFilter || 'Tất cả';

  return (
    <div className={`genmax-voice-picker ${disabled ? 'disabled' : ''}`}>
      <div className="genmax-voice-head">
        <div>
          <strong>Chọn giọng GenMax</strong>
          <p className="hint">Lọc ngôn ngữ như trên genmax.io — Japanese dùng thư viện shared.</p>
        </div>
        <button
          type="button"
          className="btn ghost"
          disabled={disabled || busy}
          onClick={() => void load({ force: true })}
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

      <div className="genmax-lang-row">
        <label>
          <span>Ngôn ngữ giọng</span>
          <select
            value={langFilter}
            disabled={disabled || busy}
            onChange={(e) => setLangFilter(e.target.value)}
            aria-label="Lọc ngôn ngữ thư viện GenMax"
          >
            {LANG_FILTERS.map((l) => (
              <option key={l.id || 'all'} value={l.id}>
                {l.label}
              </option>
            ))}
            {langFilter && !LANG_FILTERS.some((l) => l.id === langFilter) ? (
              <option value={langFilter}>{langFilter}</option>
            ) : null}
          </select>
        </label>
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
            {playingId === selected.voiceId ? '⏸ Dừng' : previewBusy ? 'Đang tải…' : '▶ Nghe thử'}
          </button>
        ) : null}
      </div>

      <div className="genmax-voice-toolbar">
        <label className="genmax-search-field">
          <span>Tìm giọng</span>
          <input
            type="search"
            value={query}
            disabled={disabled}
            placeholder="Tên, mô tả, gender, hoặc một phần ID…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void load({ force: true, remoteSearch: query });
              }
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
                title="Gắn ID và nghe thử"
                onClick={() => void applyCustomId(true)}
              >
                ▶
              </button>
            </div>
          </label>
          {idMsg ? <p className={`hint ${idMsg.type}`}>{idMsg.text}</p> : null}
        </div>
      </div>

      <div className="genmax-voice-list-wrap">
        {busy ? (
          <div className="genmax-voice-loading" role="status" aria-live="polite">
            <span className="genmax-voice-spinner" />
            <div>
              <strong>Đang tải giọng {langLabel}…</strong>
              <p>Gọi GenMax library (shared voices) — giống app genmax.io</p>
            </div>
          </div>
        ) : null}
        <div className="genmax-voice-list" role="listbox" aria-label="Danh sách giọng GenMax">
          {busy && voices.length === 0 ? (
            <div className="genmax-voice-skeleton" aria-hidden>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="genmax-voice-skel-row">
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="muted pad">
              Không thấy giọng {langLabel !== 'Tất cả' ? langLabel : ''}.
              {query.trim() ? (
                <>
                  {' '}
                  <button type="button" className="btn ghost" onClick={() => setQuery('')}>
                    Xóa ô tìm
                  </button>
                </>
              ) : null}{' '}
              Đổi bộ lọc ngôn ngữ, Enter để tìm thêm, hoặc dán voice ID.
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
                    {playing ? '⏸' : previewBusy && playingId === voice.voiceId ? '…' : '▶'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="genmax-voice-footer">
        <span>
          {filtered.length}/{voices.length} giọng · {backend}
          {langFilter ? ` · ${langFilter}` : ''}
          {busy ? ' · đang tải…' : ''}
        </span>
        <span className="hint">Gõ = lọc nhanh · Enter = tìm trên GenMax</span>
      </div>
      {error ? <p className="msg error">{error}</p> : null}
    </div>
  );
}
