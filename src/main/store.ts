import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiKeys, AppSettings } from '../shared/types';
import { DEFAULT_QWEN_TTS_MODEL, DEFAULT_RUNPOD_ENDPOINT_ID } from '../shared/types';
import {
  clampGenmaxSpeed,
  coerceSelectableTtsProvider,
  resolveIrodoriSpeedPreset,
} from '../shared/voice';

const DEFAULT_KEYS: ApiKeys = {
  snapgenApiKey: '',
  openaiApiKey: '',
  runpodApiKey: '',
  genmaxApiKey: '',
};

const DEFAULT_SETTINGS: AppSettings = {
  openaiModel: 'gpt-4o-mini',
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiTtsVoice: 'onyx',
  ttsProvider: 'genmax',
  elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  elevenLabsModelId: 'eleven_flash_v2_5',
  qwenTtsModel: DEFAULT_QWEN_TTS_MODEL,
  qwenTtsVoice: 'Ryan',
  qwenLanguageType: 'English',
  qwenRegion: 'singapore',
  qwenSpeedPreset: 'default',
  qwenInstruct: '',
  runpodEndpointId: DEFAULT_RUNPOD_ENDPOINT_ID,
  genmaxBackend: 'elevenlabs',
  genmaxVoiceId: 'hpp4J3VqNfWAUOO0d1Us',
  genmaxModelId: 'eleven_flash_v2_5',
  genmaxSpeed: 1,
  burnSubtitles: false,
  maxConcurrentScenes: 5,
};

export interface ElevenLabsMeta {
  loggedIn: boolean;
  email?: string;
  displayName?: string;
  updatedAt?: string;
  cookieCount?: number;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'studio-store.json');
}

export interface StoredElevenLabsKeyBlob {
  id: string;
  name?: string;
  apiKeyEnc?: string;
  apiKeyPlain?: string;
  priority: number;
  enabled: boolean;
  status?: string;
  lastUsed?: number;
  cooldownUntil?: number;
}

interface StoreFile {
  keysEnc?: string;
  keysPlain?: ApiKeys & { elevenLabsApiKey?: string; dashscopeApiKey?: string };
  settings: AppSettings & { elevenLabsVoiceId?: string };
  elevenLabs?: ElevenLabsMeta;
  /** Auto-captured from in-app browser requests (encrypted when possible). */
  elevenLabsApiKeyEnc?: string;
  elevenLabsApiKeyPlain?: string;
  elevenLabsAuthEnc?: string;
  elevenLabsAuthPlain?: string;
  /** Multi-key failover list (encrypted per key). */
  elevenLabsKeys?: StoredElevenLabsKeyBlob[];
}

function readFile(): StoreFile {
  const p = storePath();
  if (!fs.existsSync(p)) {
    return { settings: { ...DEFAULT_SETTINGS } };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StoreFile;
  } catch {
    return { settings: { ...DEFAULT_SETTINGS } };
  }
}

function writeFile(data: StoreFile): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8');
}

/** Internal store access for KeyManager (multi-key blob). */
export function readStoreFile(): StoreFile {
  return readFile();
}

export function writeStoreFile(data: StoreFile): void {
  writeFile(data);
}

function normalizeApiKeys(parsed: Partial<ApiKeys> & { dashscopeApiKey?: string }): ApiKeys {
  return {
    snapgenApiKey: parsed.snapgenApiKey ?? '',
    openaiApiKey: parsed.openaiApiKey ?? '',
    runpodApiKey: parsed.runpodApiKey || parsed.dashscopeApiKey || '',
    genmaxApiKey: parsed.genmaxApiKey ?? '',
  };
}

export function getKeys(): ApiKeys {
  const data = readFile();
  if (data.keysEnc && safeStorage.isEncryptionAvailable()) {
    try {
      const raw = safeStorage.decryptString(Buffer.from(data.keysEnc, 'base64'));
      const parsed = JSON.parse(raw) as ApiKeys & { dashscopeApiKey?: string };
      return normalizeApiKeys(parsed);
    } catch {
      return { ...DEFAULT_KEYS };
    }
  }
  return normalizeApiKeys((data.keysPlain ?? {}) as Partial<ApiKeys> & { dashscopeApiKey?: string });
}

/** Ghi GenMax key nếu chưa có (bootstrap từ user / env — không ghi đè key đã lưu). */
export function ensureGenmaxApiKey(apiKey: string): boolean {
  const key = apiKey.trim();
  if (!key) return false;
  const current = getKeys();
  if (current.genmaxApiKey?.trim()) return false;
  saveKeys({ ...current, genmaxApiKey: key });
  return true;
}

export function saveKeys(keys: ApiKeys): void {
  const data = readFile();
  const clean: ApiKeys = {
    snapgenApiKey: keys.snapgenApiKey,
    openaiApiKey: keys.openaiApiKey,
    runpodApiKey: keys.runpodApiKey ?? '',
    genmaxApiKey: keys.genmaxApiKey ?? '',
  };
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(JSON.stringify(clean)).toString('base64');
    data.keysEnc = enc;
    delete data.keysPlain;
  } else {
    data.keysPlain = clean;
    delete data.keysEnc;
  }
  writeFile(data);
}

export function getSettings(): AppSettings {
  const data = readFile();
  const merged = { ...DEFAULT_SETTINGS, ...data.settings };
  const rawProvider =
    merged.ttsProvider === 'elevenlabs' ||
    merged.ttsProvider === 'openai' ||
    merged.ttsProvider === 'qwen' ||
    merged.ttsProvider === 'genmax'
      ? merged.ttsProvider
      : DEFAULT_SETTINGS.ttsProvider;
  const provider = coerceSelectableTtsProvider(rawProvider);
  const qwenRegion = 'singapore' as const;
  const genmaxBackend =
    merged.genmaxBackend === 'minimax' || merged.genmaxBackend === 'capcut'
      ? merged.genmaxBackend
      : 'elevenlabs';
  return {
    openaiModel: merged.openaiModel || DEFAULT_SETTINGS.openaiModel,
    openaiTtsModel: merged.openaiTtsModel || DEFAULT_SETTINGS.openaiTtsModel,
    openaiTtsVoice: merged.openaiTtsVoice || DEFAULT_SETTINGS.openaiTtsVoice,
    ttsProvider: provider,
    elevenLabsVoiceId: merged.elevenLabsVoiceId || DEFAULT_SETTINGS.elevenLabsVoiceId,
    elevenLabsModelId: merged.elevenLabsModelId || DEFAULT_SETTINGS.elevenLabsModelId,
    qwenTtsModel: DEFAULT_QWEN_TTS_MODEL,
    qwenTtsVoice: merged.qwenTtsVoice || DEFAULT_SETTINGS.qwenTtsVoice,
    qwenLanguageType: merged.qwenLanguageType || DEFAULT_SETTINGS.qwenLanguageType,
    qwenRegion,
    qwenSpeedPreset: resolveIrodoriSpeedPreset(
      merged.qwenSpeedPreset || DEFAULT_SETTINGS.qwenSpeedPreset
    ),
    qwenInstruct: String(merged.qwenInstruct || '').trim(),
    runpodEndpointId:
      String(merged.runpodEndpointId || '').trim() || DEFAULT_RUNPOD_ENDPOINT_ID,
    genmaxBackend,
    genmaxVoiceId: merged.genmaxVoiceId || DEFAULT_SETTINGS.genmaxVoiceId,
    genmaxModelId: merged.genmaxModelId || DEFAULT_SETTINGS.genmaxModelId,
    genmaxSpeed: clampGenmaxSpeed(
      merged.genmaxSpeed ?? DEFAULT_SETTINGS.genmaxSpeed,
      genmaxBackend
    ),
    burnSubtitles: Boolean(merged.burnSubtitles),
    lastExportDir: merged.lastExportDir || '',
    maxConcurrentScenes: Math.max(
      1,
      Math.min(
        12,
        Number(merged.maxConcurrentScenes) || DEFAULT_SETTINGS.maxConcurrentScenes || 5
      )
    ),
  };
}

export function saveSettings(settings: AppSettings): void {
  const data = readFile();
  data.settings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    runpodEndpointId:
      String(settings.runpodEndpointId || '').trim() || DEFAULT_RUNPOD_ENDPOINT_ID,
  };
  writeFile(data);
}

export function getElevenLabsMeta(): ElevenLabsMeta {
  const data = readFile();
  return {
    loggedIn: Boolean(data.elevenLabs?.loggedIn),
    email: data.elevenLabs?.email,
    displayName: data.elevenLabs?.displayName,
    updatedAt: data.elevenLabs?.updatedAt,
    cookieCount: data.elevenLabs?.cookieCount ?? 0,
  };
}

export function saveElevenLabsMeta(meta: ElevenLabsMeta): void {
  const data = readFile();
  data.elevenLabs = {
    loggedIn: Boolean(meta.loggedIn),
    email: meta.email,
    displayName: meta.displayName,
    updatedAt: meta.updatedAt || new Date().toISOString(),
    cookieCount: meta.cookieCount ?? 0,
  };
  writeFile(data);
}

/** API key captured from the logged-in ElevenLabs web session (not typed by user). */
export function getCapturedElevenLabsApiKey(): string {
  const data = readFile();
  if (data.elevenLabsApiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(data.elevenLabsApiKeyEnc, 'base64'));
    } catch {
      return '';
    }
  }
  return data.elevenLabsApiKeyPlain ?? '';
}

export function saveCapturedElevenLabsApiKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key || key.length < 8) return;
  const existing = getCapturedElevenLabsApiKey();
  if (existing === key) return;

  const data = readFile();
  if (safeStorage.isEncryptionAvailable()) {
    data.elevenLabsApiKeyEnc = safeStorage.encryptString(key).toString('base64');
    delete data.elevenLabsApiKeyPlain;
  } else {
    data.elevenLabsApiKeyPlain = key;
    delete data.elevenLabsApiKeyEnc;
  }
  writeFile(data);
}

export function getCapturedElevenLabsAuthorization(): string {
  const data = readFile();
  if (data.elevenLabsAuthEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(data.elevenLabsAuthEnc, 'base64'));
    } catch {
      return '';
    }
  }
  return data.elevenLabsAuthPlain ?? '';
}

export function saveCapturedElevenLabsAuthorization(authorization: string): void {
  let value = authorization.trim();
  if (!value || value.length < 8) return;
  if (!/^bearer\s+/i.test(value) && !/^basic\s+/i.test(value)) {
    value = `Bearer ${value}`;
  }
  const existing = getCapturedElevenLabsAuthorization();
  if (existing === value) return;

  const data = readFile();
  if (safeStorage.isEncryptionAvailable()) {
    data.elevenLabsAuthEnc = safeStorage.encryptString(value).toString('base64');
    delete data.elevenLabsAuthPlain;
  } else {
    data.elevenLabsAuthPlain = value;
    delete data.elevenLabsAuthEnc;
  }
  writeFile(data);
}

export function clearCapturedElevenLabsApiKey(): void {
  const data = readFile();
  delete data.elevenLabsApiKeyEnc;
  delete data.elevenLabsApiKeyPlain;
  delete data.elevenLabsAuthEnc;
  delete data.elevenLabsAuthPlain;
  writeFile(data);
}

export function hasCapturedElevenLabsCredential(): boolean {
  const data = readFile();
  if (data.elevenLabsKeys?.some((k) => Boolean(k.apiKeyEnc || k.apiKeyPlain))) {
    return true;
  }
  const key = getCapturedElevenLabsApiKey().trim();
  // Only a real API key unlocks api.elevenlabs.io. JWT/session alone is not enough.
  return /^(sk_|xi_)/i.test(key);
}

export function getProjectsRoot(): string {
  const root = path.join(app.getPath('userData'), 'projects');
  fs.mkdirSync(root, { recursive: true });
  return root;
}
