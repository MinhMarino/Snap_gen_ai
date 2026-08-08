import { useEffect, useState } from 'react';
import type {
  ApiKeys,
  AppSettings,
  ElevenLabsSessionStatus,
  UsageHistorySnapshot,
  UsageSnapshot,
} from '../../shared/types';
import {
  DEFAULT_QWEN_TTS_MODEL,
  DEFAULT_RUNPOD_ENDPOINT_ID,
  ELEVENLABS_TTS_MODELS,
  OPENAI_CHAT_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  QWEN_TTS_LANGUAGE_TYPES,
} from '../../shared/types';
import type { TtsProvider } from '../../shared/types';
import { pickQwenVoiceForLanguage } from '../../shared/voice';
import UsageQuotaPanel from '../components/UsageQuotaPanel';
import UsageHistoryPanel from '../components/UsageHistoryPanel';
import ElevenLabsApiKeysPanel from '../components/ElevenLabsApiKeysPanel';
import QwenVoicePicker from '../components/QwenVoicePicker';
import SecretInput from '../components/SecretInput';

function parseTtsProvider(value: string): TtsProvider {
  if (value === 'elevenlabs' || value === 'qwen') return value;
  return 'openai';
}

export default function Settings() {
  const [keys, setKeys] = useState<ApiKeys>({
    snapgenApiKey: '',
    openaiApiKey: '',
    runpodApiKey: '',
  });
  const [settings, setSettings] = useState<AppSettings>({
    openaiModel: 'gpt-4o-mini',
    openaiTtsModel: 'gpt-4o-mini-tts',
    openaiTtsVoice: 'onyx',
    ttsProvider: 'openai',
    elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
    elevenLabsModelId: 'eleven_flash_v2_5',
    qwenTtsModel: DEFAULT_QWEN_TTS_MODEL,
    qwenTtsVoice: 'Ryan',
    qwenLanguageType: 'English',
    qwenRegion: 'singapore',
    runpodEndpointId: DEFAULT_RUNPOD_ENDPOINT_ID,
    burnSubtitles: false,
    maxConcurrentScenes: 5,
  });
  const [elevenLabs, setElevenLabs] = useState<ElevenLabsSessionStatus>({
    loggedIn: false,
    cookieCount: 0,
  });
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [history, setHistory] = useState<UsageHistorySnapshot | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** api_key = chỉ dán key ngoài (không cần tài khoản). account = đăng nhập web tuỳ chọn. */
  const [elevenLabsMode, setElevenLabsMode] = useState<'api_key' | 'account'>(() => {
    try {
      const saved = localStorage.getItem('snapgen.elevenLabsMode');
      return saved === 'account' ? 'account' : 'api_key';
    } catch {
      return 'api_key';
    }
  });

  const elevenLabsReady = !!elevenLabs.hasApiCredential || elevenLabs.loggedIn;

  const refreshUsage = async () => {
    setUsageBusy(true);
    try {
      setUsage(await window.studio.getUsageQuotas());
      setUsageError(null);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setUsageError(
        text.includes('No handler') || text.includes('usage:getQuotas')
          ? 'Main chưa reload — gõ rs trong terminal Forge rồi bấm Làm mới.'
          : text
      );
    } finally {
      setUsageBusy(false);
    }
  };

  const refreshHistory = async () => {
    setHistoryBusy(true);
    try {
      setHistory(await window.studio.getUsageHistory());
      setHistoryError(null);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setHistoryError(
        text.includes('No handler') || text.includes('usage:getHistory')
          ? 'Main chưa reload — gõ rs trong terminal Forge rồi bấm Làm mới.'
          : text
      );
    } finally {
      setHistoryBusy(false);
    }
  };

  const loadVoices = async (force = false) => {
    if (!force && voicesLoaded) return;
    try {
      const list = await window.studio.listElevenLabsVoices();
      setVoicesLoaded(true);
      setMsg({ type: 'ok', text: `Đã tải ${list.length} giọng ElevenLabs (chọn trong dự án → Giọng đọc).` });
    } catch (err) {
      setVoicesLoaded(false);
      setMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void (async () => {
      setKeys(await window.studio.getKeys());
      const nextSettings = await window.studio.getSettings();
      setSettings(nextSettings);
      const session = await window.studio.getElevenLabsSession();
      setElevenLabs(session);
      if (session.loggedIn && session.hasApiCredential) {
        await loadVoices(true);
      }
      await refreshUsage();
      await refreshHistory();
    })();
    return window.studio.onElevenLabsSessionChange((status) => {
      setElevenLabs((prev) => {
        const same =
          prev.loggedIn === status.loggedIn &&
          prev.hasApiCredential === status.hasApiCredential &&
          prev.email === status.email &&
          prev.cookieCount === status.cookieCount;
        return same ? prev : status;
      });
      if (!status.loggedIn) {
        setVoicesLoaded(false);
      }
      // Do NOT auto-spam listVoices on every session sync event.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveAll = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await window.studio.saveKeys(keys);
      await window.studio.saveSettings(settings);
      setMsg({
        type: 'ok',
        text: 'Đã lưu API keys và settings trên máy (encrypted nếu hệ thống hỗ trợ).',
      });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const test = async (kind: 'snapgen' | 'openai' | 'elevenlabs' | 'qwen') => {
    setBusy(true);
    setMsg(
      kind === 'qwen'
        ? {
            type: 'ok',
            text: 'Đang kiểm tra Irodori… (health + TTS ngắn, cold start có thể 30–180s)',
          }
        : null
    );
    try {
      if (kind !== 'elevenlabs') {
        const keysToSave =
          kind === 'qwen'
            ? {
                ...keys,
                runpodApiKey: keys.runpodApiKey.replace(/^bearer\s+/i, '').trim(),
              }
            : keys;
        if (kind === 'qwen' && keysToSave.runpodApiKey !== keys.runpodApiKey) {
          setKeys(keysToSave);
        }
        await window.studio.saveKeys(keysToSave);
      }
      if (kind === 'qwen') {
        await window.studio.saveSettings({
          ...settings,
          runpodEndpointId:
            settings.runpodEndpointId?.trim() || DEFAULT_RUNPOD_ENDPOINT_ID,
        });
      }
      const res =
        kind === 'snapgen'
          ? await window.studio.testSnapgen()
          : kind === 'openai'
            ? await window.studio.testOpenAI()
            : kind === 'qwen'
              ? await window.studio.testQwen()
              : await window.studio.testElevenLabs();
      if (kind === 'elevenlabs') {
        setElevenLabs(await window.studio.getElevenLabsSession());
        if (res.ok) await loadVoices(true);
      }
      setMsg({ type: res.ok ? 'ok' : 'error', text: res.message });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const loginElevenLabs = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const status = await window.studio.openElevenLabsLogin();
      setElevenLabs(status);
      if (status.loggedIn) {
        await loadVoices(true);
        setSettings((prev) => ({ ...prev, ttsProvider: 'elevenlabs' }));
      }
      setMsg({
        type: 'ok',
        text: status.loggedIn
          ? `Đã lưu session ElevenLabs${status.email ? ` (${status.email})` : ''}. Có thể chọn giọng bên dưới.`
          : 'Đã mở trình duyệt ElevenLabs. Đăng nhập xong app sẽ tự lưu cookies/session.',
      });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const logoutElevenLabs = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const status = await window.studio.clearElevenLabsSession();
      setElevenLabs(status);
      setVoicesLoaded(false);
      if (settings.ttsProvider === 'elevenlabs') {
        setSettings((prev) => ({ ...prev, ttsProvider: 'openai' }));
      }
      setMsg({ type: 'ok', text: 'Đã xóa cookies/session ElevenLabs trên máy (danh sách API Keys vẫn giữ).' });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const openApiKeysPage = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const status = await window.studio.openElevenLabsApiKeys();
      setElevenLabs(status);
      setMsg({
        type: 'ok',
        text: 'Đã mở trang API Keys. Bấm Create Key (free), copy key, rồi thêm vào danh sách bên dưới.',
      });
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel settings-panel">
      <div className="panel-hero">
        <p className="eyebrow">Cấu hình</p>
        <h1>API &amp; Voice</h1>
        <p className="sub">
          Chọn nguồn giọng đọc và theo dõi số dư Snapgen / ElevenLabs ngay bên dưới.
        </p>
      </div>

      <UsageQuotaPanel
        snapshot={usage}
        busy={usageBusy || busy}
        error={usageError}
        onRefresh={() => void refreshUsage()}
      />

      <UsageHistoryPanel
        snapshot={history}
        busy={historyBusy || busy}
        error={historyError}
        onRefresh={() => void refreshHistory()}
        onSnapshotChange={setHistory}
      />

      <section className="settings-block">
        <h2>API Keys</h2>
        <div className="field">
          <label htmlFor="snapgen">Snapgen API Key</label>
          <SecretInput
            id="snapgen"
            value={keys.snapgenApiKey}
            onChange={(v) => setKeys({ ...keys, snapgenApiKey: v })}
            placeholder="sk_..."
          />
        </div>
        <div className="field">
          <label htmlFor="openai">OpenAI API Key</label>
          <SecretInput
            id="openai"
            value={keys.openaiApiKey}
            onChange={(v) => setKeys({ ...keys, openaiApiKey: v })}
            placeholder="sk-..."
          />
          <p className="hint">Vẫn cần OpenAI để viết kịch bản (ChatGPT), kể cả khi voice dùng ElevenLabs/Irodori.</p>
        </div>
        <div className="field">
          <label htmlFor="runpod">RunPod API Key (Irodori TTS)</label>
          <SecretInput
            id="runpod"
            value={keys.runpodApiKey}
            onChange={(v) => setKeys({ ...keys, runpodApiKey: v })}
            placeholder="rp_..."
          />
          <p className="hint">
            Key từ{' '}
            <a href="https://console.runpod.io/user/settings?tab=api-keys" target="_blank" rel="noreferrer">
              RunPod Console → API Keys
            </a>
            . Dùng Bearer gọi endpoint Irodori (Qwen3-TTS 1.7B).
          </p>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="runpod-endpoint">RunPod Endpoint ID</label>
            <input
              id="runpod-endpoint"
              type="text"
              value={settings.runpodEndpointId || DEFAULT_RUNPOD_ENDPOINT_ID}
              onChange={(e) =>
                setSettings({ ...settings, runpodEndpointId: e.target.value.trim() })
              }
              placeholder={DEFAULT_RUNPOD_ENDPOINT_ID}
            />
          </div>
          <div className="session-card-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void test('qwen')}>
              {busy ? 'Đang kiểm tra…' : 'Kiểm tra Irodori TTS'}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Cần key RunPod dạng <code>rp_…</code>. Key <code>IRODORI_API_KEYS</code> không dùng được ở đây.
          </p>
        </div>
      </section>

      <section className="settings-block" id="elevenlabs">
        <h2>ElevenLabs</h2>
        <div className="el-mode-switch" role="tablist" aria-label="Cách kết nối ElevenLabs">
          <button
            type="button"
            role="tab"
            aria-selected={elevenLabsMode === 'api_key'}
            className={`el-mode-btn ${elevenLabsMode === 'api_key' ? 'active' : ''}`}
            onClick={() => {
              setElevenLabsMode('api_key');
              try {
                localStorage.setItem('snapgen.elevenLabsMode', 'api_key');
              } catch {
                /* ignore */
              }
            }}
          >
            API key bên ngoài
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={elevenLabsMode === 'account'}
            className={`el-mode-btn ${elevenLabsMode === 'account' ? 'active' : ''}`}
            onClick={() => {
              setElevenLabsMode('account');
              try {
                localStorage.setItem('snapgen.elevenLabsMode', 'account');
              } catch {
                /* ignore */
              }
            }}
          >
            Tài khoản web
          </button>
        </div>

        {elevenLabsMode === 'api_key' ? (
          <>
            <p className="settings-note">
              <strong>Không cần tài khoản trong app.</strong> Có sẵn API key từ nguồn ngoài (account
              khác, mua, share…) → dán <code>sk_…</code> / <code>xi_…</code> vào ô bên dưới là dùng
              TTS ngay. Không đăng nhập ElevenLabs.
            </p>
            <div className={`session-card ${elevenLabs.hasApiCredential ? 'ok' : ''}`}>
              <div className="session-card-main">
                <span className={`session-dot ${elevenLabs.hasApiCredential ? 'on' : ''}`} />
                <div>
                  <strong>
                    {elevenLabs.hasApiCredential
                      ? 'Sẵn sàng — đang dùng API key'
                      : 'Chưa có API key'}
                  </strong>
                  <p>
                    {elevenLabs.hasApiCredential
                      ? 'Add key → Test → chọn giọng trong dự án. Hết quota thì thêm key khác.'
                      : 'Dán API key bên dưới rồi bấm + Add API Key.'}
                  </p>
                </div>
              </div>
              <div className="session-card-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void test('elevenlabs')}
                >
                  Kiểm tra
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !elevenLabs.hasApiCredential}
                  onClick={() => void loadVoices(true)}
                >
                  Tải danh sách giọng
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="settings-note">
              Đăng nhập web ElevenLabs (tuỳ chọn) — dùng khi muốn bắt key từ trình duyệt trong app
              hoặc dùng session web. Vẫn có thể Add API key thủ công bên dưới.
            </p>
            <div className={`session-card ${elevenLabsReady ? 'ok' : ''}`}>
              <div className="session-card-main">
                <span className={`session-dot ${elevenLabsReady ? 'on' : ''}`} />
                <div>
                  <strong>
                    {elevenLabs.hasApiCredential
                      ? 'Sẵn sàng (đã có API key)'
                      : elevenLabs.loggedIn
                        ? 'Đã đăng nhập web (chưa có API key)'
                        : 'Chưa cấu hình'}
                  </strong>
                  <p>
                    {elevenLabs.hasApiCredential
                      ? [
                          elevenLabs.email || elevenLabs.displayName || 'Có API key',
                          elevenLabs.loggedIn ? 'đã login web' : 'không cần login web',
                        ].join(' · ')
                      : 'Đăng nhập web hoặc Add API key bên dưới.'}
                  </p>
                </div>
              </div>
              <div className="session-card-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void openApiKeysPage()}
                >
                  Mở trang API Keys
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void loginElevenLabs()}
                >
                  Đăng nhập web
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void test('elevenlabs')}
                >
                  Kiểm tra
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !elevenLabsReady}
                  onClick={() => void loadVoices(true)}
                >
                  Tải danh sách giọng
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !elevenLabsReady}
                  onClick={() => void logoutElevenLabs()}
                >
                  Xóa session / key
                </button>
              </div>
            </div>
          </>
        )}

        <ElevenLabsApiKeysPanel
          mode={elevenLabsMode}
          disabled={busy}
          onChanged={() => {
            void window.studio.getElevenLabsSession().then(setElevenLabs);
          }}
        />
      </section>

      <section className="settings-block">
        <h2>Voiceover (mặc định dự án mới)</h2>
        <p className="settings-note">
          Chọn giọng trong từng dự án: Studio → tab <strong>Giọng đọc</strong> (hoặc khối
          «Giọng đọc theo dự án» trong AI Create). Phần dưới chỉ là mặc định khi tạo dự án mới.
        </p>
        <div className="field">
          <label htmlFor="tts-provider">Nguồn giọng mặc định</label>
          <select
            id="tts-provider"
            value={settings.ttsProvider}
            onChange={(e) =>
              setSettings({
                ...settings,
                ttsProvider: parseTtsProvider(e.target.value),
              })
            }
          >
            <option value="openai">OpenAI TTS</option>
            <option value="elevenlabs" disabled={!elevenLabsReady}>
              ElevenLabs {!elevenLabsReady ? '(cần API key)' : ''}
            </option>
            <option value="qwen" disabled={!keys.runpodApiKey?.trim()}>
              Irodori TTS (Qwen3) {!keys.runpodApiKey?.trim() ? '(cần RunPod key)' : ''}
            </option>
          </select>
        </div>
        {settings.ttsProvider === 'elevenlabs' ? (
          <div className="field">
            <label htmlFor="el-model-default">ElevenLabs model mặc định</label>
            <select
              id="el-model-default"
              value={settings.elevenLabsModelId}
              onChange={(e) =>
                setSettings({ ...settings, elevenLabsModelId: e.target.value })
              }
            >
              {ELEVENLABS_TTS_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
        ) : settings.ttsProvider === 'qwen' ? (
          <>
            <div className="field">
              <label htmlFor="qwen-lang">Language type mặc định</label>
              <select
                id="qwen-lang"
                value={settings.qwenLanguageType}
                onChange={(e) => {
                  const qwenLanguageType = e.target.value;
                  setSettings({
                    ...settings,
                    qwenLanguageType,
                    qwenTtsVoice: pickQwenVoiceForLanguage(
                      qwenLanguageType,
                      settings.qwenTtsVoice
                    ),
                  });
                }}
              >
                {QWEN_TTS_LANGUAGE_TYPES.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </div>
            <QwenVoicePicker
              languageType={settings.qwenLanguageType || 'Auto'}
              value={settings.qwenTtsVoice}
              selectId="qwen-voice"
              label="Voice mặc định"
              onChange={(qwenTtsVoice) => setSettings({ ...settings, qwenTtsVoice })}
            />
          </>
        ) : (
          <div className="grid-2">
            <div className="field">
              <label htmlFor="tts-model">OpenAI TTS model mặc định</label>
              <select
                id="tts-model"
                value={settings.openaiTtsModel}
                onChange={(e) => setSettings({ ...settings, openaiTtsModel: e.target.value })}
              >
                {OPENAI_TTS_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="tts-voice">OpenAI TTS voice mặc định</label>
              <select
                id="tts-voice"
                value={settings.openaiTtsVoice}
                onChange={(e) => setSettings({ ...settings, openaiTtsVoice: e.target.value })}
              >
                {OPENAI_TTS_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="omodel">Model viết kịch bản mặc định (dự án mới)</label>
          <select
            id="omodel"
            value={
              OPENAI_CHAT_MODELS.some((m) => m.id === settings.openaiModel)
                ? settings.openaiModel
                : '__custom__'
            }
            onChange={(e) => {
              const value = e.target.value;
              if (value === '__custom__') return;
              setSettings({ ...settings, openaiModel: value });
            }}
          >
            {OPENAI_CHAT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {!OPENAI_CHAT_MODELS.some((m) => m.id === settings.openaiModel) && (
              <option value="__custom__">{settings.openaiModel} (tùy chỉnh)</option>
            )}
          </select>
          <input
            className="mt-2"
            value={settings.openaiModel}
            onChange={(e) => setSettings({ ...settings, openaiModel: e.target.value.trim() })}
            placeholder="Hoặc gõ model id tùy chỉnh, vd gpt-4o"
            aria-label="OpenAI chat model id mặc định"
          />
          <p className="hint">
            Chỉ áp dụng khi tạo dự án mới. Mỗi dự án đổi riêng trong Studio → AI Create.
          </p>
        </div>
      </section>

      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.burnSubtitles}
          onChange={(e) => setSettings({ ...settings, burnSubtitles: e.target.checked })}
        />
        <span>Burn-in subtitle vào video cuối</span>
      </label>

      <div className="field">
        <label htmlFor="max-concurrent-scenes">Số scene generate song song</label>
        <input
          id="max-concurrent-scenes"
          type="number"
          min={1}
          max={12}
          value={settings.maxConcurrentScenes ?? 5}
          onChange={(e) =>
            setSettings({
              ...settings,
              maxConcurrentScenes: Math.max(
                1,
                Math.min(12, Number(e.target.value) || 5)
              ),
            })
          }
        />
        <p className="hint">
          Worker pool Snapgen (mặc định 5). Tăng để nhanh hơn; quá cao có thể bị rate-limit.
        </p>
      </div>

      <div className="row-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void saveAll()}>
          Lưu
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void test('snapgen')}>
          Test Snapgen
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void test('openai')}>
          Test OpenAI
        </button>
      </div>

      {msg && <div className={`msg ${msg.type === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
    </div>
  );
}
