import { useEffect, useState } from 'react';
import type {
  ElevenLabsSessionStatus,
  ElevenLabsVoice,
  ProjectVoiceSettings,
  TtsProvider,
} from '../../shared/types';
import {
  ELEVENLABS_TTS_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  QWEN_TTS_LANGUAGE_TYPES,
} from '../../shared/types';
import {
  buildIrodoriInstruct,
  IRODORI_SPEED_PRESETS,
  pickQwenVoiceForLanguage,
  resolveIrodoriSpeedPreset,
  type IrodoriSpeedPreset,
} from '../../shared/voice';
import ElevenLabsVoicePicker from './ElevenLabsVoicePicker';
import GenmaxVoicePicker from './GenmaxVoicePicker';
import QwenVoicePicker from './QwenVoicePicker';

function parseTtsProvider(value: string): TtsProvider {
  if (value === 'elevenlabs' || value === 'qwen' || value === 'genmax') return value;
  return 'openai';
}

export default function ProjectVoicePanel({
  value,
  disabled,
  onChange,
}: {
  value: ProjectVoiceSettings;
  disabled?: boolean;
  onChange: (next: ProjectVoiceSettings) => void;
}) {
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [voicesBusy, setVoicesBusy] = useState(false);
  const [addVoiceInput, setAddVoiceInput] = useState('');
  const [addVoiceBusy, setAddVoiceBusy] = useState(false);
  const [addVoiceMsg, setAddVoiceMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(
    null
  );
  const [elevenLabs, setElevenLabs] = useState<ElevenLabsSessionStatus>({
    loggedIn: false,
    cookieCount: 0,
    hasApiCredential: false,
  });
  const [qwenReady, setQwenReady] = useState(false);
  const [genmaxReady, setGenmaxReady] = useState(false);

  const elevenLabsReady = elevenLabs.loggedIn || elevenLabs.hasApiCredential;

  const addLibraryById = async () => {
    const raw = addVoiceInput.trim();
    if (!raw) return;
    setAddVoiceBusy(true);
    setAddVoiceMsg(null);
    try {
      const result = await window.studio.addElevenLabsLibraryVoice({ voiceIdOrUrl: raw });
      setVoices(result.voices);
      patch({
        elevenLabsVoiceId: result.voiceId,
        elevenLabsPublicOwnerId: result.publicOwnerId,
        elevenLabsOriginalVoiceId: result.libraryVoiceId,
        elevenLabsVoiceName: result.name,
      });
      setAddVoiceInput('');
      setAddVoiceMsg({ type: 'ok', text: result.message });
    } catch (err) {
      setAddVoiceMsg({
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAddVoiceBusy(false);
    }
  };

  useEffect(() => {
    void window.studio.getElevenLabsSession().then(setElevenLabs);
    void window.studio.getKeys().then((k) => {
      setQwenReady(Boolean(k.runpodApiKey?.trim()));
      setGenmaxReady(Boolean(k.genmaxApiKey?.trim()));
    });
    return window.studio.onElevenLabsSessionChange(setElevenLabs);
  }, []);

  useEffect(() => {
    if (!elevenLabsReady) {
      setVoices([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setVoicesBusy(true);
      try {
        const list = await window.studio.listElevenLabsVoices();
        if (cancelled) return;
        setVoices(list);
        // Chỉ gán mặc định khi chưa có voiceId — không ghi đè giọng Library user đã chọn.
        if (list.length && !value.elevenLabsVoiceId?.trim()) {
          const premade =
            list.find((v) => (v.category || '').toLowerCase() === 'premade') || list[0];
          if (premade) onChange({ ...value, elevenLabsVoiceId: premade.voiceId });
        }
      } catch {
        if (!cancelled) setVoices([]);
      } finally {
        if (!cancelled) setVoicesBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elevenLabsReady, value.ttsProvider]);

  const patch = (partial: Partial<ProjectVoiceSettings>) => onChange({ ...value, ...partial });

  return (
    <div className="project-voice-panel">
      <div className="field">
        <label htmlFor="project-tts-provider">Nguồn giọng đọc</label>
        <select
          id="project-tts-provider"
          value={value.ttsProvider}
          disabled={disabled}
          onChange={(e) => patch({ ttsProvider: parseTtsProvider(e.target.value) })}
        >
          <option value="openai">OpenAI TTS</option>
          <option value="elevenlabs" disabled={!elevenLabsReady}>
            ElevenLabs {!elevenLabsReady ? '(cần API key ở Settings)' : ''}
          </option>
          <option value="qwen" disabled={!qwenReady}>
            Irodori TTS {!qwenReady ? '(cần RunPod key ở Settings)' : ''}
          </option>
          <option value="genmax" disabled={!genmaxReady}>
            GenMax TTS {!genmaxReady ? '(cần GenMax key ở Settings)' : ''}
          </option>
        </select>
      </div>

      {value.ttsProvider === 'elevenlabs' ? (
        <>
          <div className="field">
            <div className="field-row-between">
              <label>ElevenLabs voice</label>
              <button
                type="button"
                className="btn ghost"
                disabled={disabled || voicesBusy || !elevenLabsReady}
                onClick={() => {
                  void (async () => {
                    setVoicesBusy(true);
                    try {
                      setVoices(await window.studio.listElevenLabsVoices());
                    } finally {
                      setVoicesBusy(false);
                    }
                  })();
                }}
              >
                {voicesBusy ? 'Đang tải…' : 'Tải lại giọng'}
              </button>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              Settings → ElevenLabs → «API key bên ngoài» → dán key là dùng (không cần tài khoản).
              Dán Voice ID/URL → Add theo ID. Library Free API có thể bị chặn — ưu tiên premade.
            </p>
            <div className="el-add-voice-by-id">
              <input
                type="text"
                value={addVoiceInput}
                disabled={disabled || !elevenLabsReady || addVoiceBusy}
                placeholder="Voice ID hoặc URL… (vd. j210dv0vWm7fCknyQpbA)"
                onChange={(e) => setAddVoiceInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addLibraryById();
                  }
                }}
                aria-label="Voice ID hoặc URL ElevenLabs Library"
              />
              <button
                type="button"
                className="btn primary"
                disabled={
                  disabled || !elevenLabsReady || addVoiceBusy || !addVoiceInput.trim()
                }
                onClick={() => void addLibraryById()}
              >
                {addVoiceBusy ? 'Đang Add…' : 'Add theo ID'}
              </button>
            </div>
            {addVoiceMsg ? (
              <p className={`hint ${addVoiceMsg.type === 'ok' ? 'ok' : 'error'}`}>
                {addVoiceMsg.text}
              </p>
            ) : null}
            <ElevenLabsVoicePicker
              voices={voices}
              value={value.elevenLabsVoiceId}
              modelId={value.elevenLabsModelId}
              disabled={disabled || !elevenLabsReady || voices.length === 0}
              onChange={(voiceId) => {
                const v = voices.find((item) => item.voiceId === voiceId);
                patch({
                  elevenLabsVoiceId: voiceId,
                  elevenLabsPublicOwnerId: v?.publicOwnerId,
                  elevenLabsOriginalVoiceId: v?.originalVoiceId || voiceId,
                  elevenLabsVoiceName: v?.name,
                });
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="project-el-model">ElevenLabs model</label>
            <select
              id="project-el-model"
              value={value.elevenLabsModelId}
              disabled={disabled}
              onChange={(e) => patch({ elevenLabsModelId: e.target.value })}
            >
              {ELEVENLABS_TTS_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : value.ttsProvider === 'qwen' ? (
        <>
          <div className="field">
            <label htmlFor="project-qwen-lang">Language type</label>
            <select
              id="project-qwen-lang"
              value={value.qwenLanguageType || 'Auto'}
              disabled={disabled}
              onChange={(e) => {
                const qwenLanguageType = e.target.value;
                patch({
                  qwenLanguageType,
                  qwenTtsVoice: pickQwenVoiceForLanguage(qwenLanguageType, value.qwenTtsVoice),
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
            languageType={value.qwenLanguageType || 'Auto'}
            value={value.qwenTtsVoice}
            disabled={disabled}
            selectId="project-qwen-voice"
            onChange={(qwenTtsVoice) => patch({ qwenTtsVoice })}
          />
          <div className="field">
            <label>Tốc độ nói</label>
            <div className="irodori-speed-presets" role="group" aria-label="Preset tốc độ">
              {IRODORI_SPEED_PRESETS.map((preset) => {
                const active =
                  resolveIrodoriSpeedPreset(value.qwenSpeedPreset) === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`irodori-speed-btn ${active ? 'active' : ''}`}
                    disabled={disabled}
                    onClick={() =>
                      patch({ qwenSpeedPreset: preset.id as IrodoriSpeedPreset })
                    }
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              CustomVoice không có speed số — app gửi qua <code>instruct</code>.
            </p>
          </div>
          <div className="field">
            <label htmlFor="project-qwen-instruct">Instruct (phong cách / cảm xúc)</label>
            <textarea
              id="project-qwen-instruct"
              className="irodori-instruct-input"
              rows={2}
              disabled={disabled}
              value={value.qwenInstruct || ''}
              placeholder='VD: Speak cheerfully. / 用温柔的语气说'
              onChange={(e) => patch({ qwenInstruct: e.target.value })}
            />
            {buildIrodoriInstruct(value.qwenSpeedPreset, value.qwenInstruct) ? (
              <p className="hint irodori-instruct-preview">
                Sẽ gửi: {buildIrodoriInstruct(value.qwenSpeedPreset, value.qwenInstruct)}
              </p>
            ) : (
              <p className="hint">Để trống = không gửi instruct (giọng speaker mặc định).</p>
            )}
          </div>
        </>
      ) : value.ttsProvider === 'genmax' ? (
        <>
          <GenmaxVoicePicker
            backend={value.genmaxBackend || 'elevenlabs'}
            value={value.genmaxVoiceId}
            disabled={disabled || !genmaxReady}
            onBackendChange={(genmaxBackend) => patch({ genmaxBackend })}
            onChange={(voice) =>
              patch({
                genmaxVoiceId: voice.voiceId,
                genmaxVoiceName: voice.name,
                genmaxBackend: voice.backend,
              })
            }
          />
          <div className="field">
            <label htmlFor="project-genmax-model">Model ID</label>
            <input
              id="project-genmax-model"
              type="text"
              disabled={disabled}
              value={value.genmaxModelId || ''}
              placeholder={
                value.genmaxBackend === 'minimax'
                  ? 'speech-2.8-turbo'
                  : value.genmaxBackend === 'capcut'
                    ? 'capcut'
                    : 'eleven_flash_v2_5'
              }
              onChange={(e) => patch({ genmaxModelId: e.target.value.trim() })}
            />
            <p className="hint">ElevenLabs: eleven_flash_v2_5 · MiniMax: speech-2.8-turbo · CapCut: capcut</p>
          </div>
        </>
      ) : (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="project-tts-model">OpenAI TTS model</label>
            <select
              id="project-tts-model"
              value={value.openaiTtsModel}
              disabled={disabled}
              onChange={(e) => patch({ openaiTtsModel: e.target.value })}
            >
              {OPENAI_TTS_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="project-tts-voice">OpenAI TTS voice</label>
            <select
              id="project-tts-voice"
              value={value.openaiTtsVoice}
              disabled={disabled}
              onChange={(e) => patch({ openaiTtsVoice: e.target.value })}
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
    </div>
  );
}
