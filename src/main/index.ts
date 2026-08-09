import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import { IMAGE_FAMILIES, IMAGE_MODELS, VIDEO_FAMILIES, VIDEO_MODELS } from '../shared/models';
import type {
  ApiKeys,
  AppSettings,
  CreateProjectInput,
  ExportMediaRequest,
  ExportMediaResult,
  GenerateIdeaInput,
  GenerateJobInput,
  LoadMoreUsageHistoryRequest,
  ProjectDraft,
} from '../shared/types';
import { ensureGenmaxApiKey, getKeys, getSettings, saveKeys, saveSettings } from './store';
import { testAccount } from './services/snapgen';
import { generateMusicAnimationScript, generateScript, testOpenAI } from './services/openai';
import {
  clearProjectNarration,
  importExternalNarration,
  remuxProject,
  runGenerateJob,
} from './services/pipeline';
import {
  clearMusicAudio,
  clearMusicCharacters,
  importMusicAudio,
  importMusicCharacters,
  loadCharacterDataUrls,
  resolveMusicAudioPath,
} from './services/music-project';
import { getDurationSafe } from './services/ffmpeg';
import type { GenerateMusicAnimationScriptInput } from '../shared/types';
import {
  clearElevenLabsSession,
  getElevenLabsSessionStatus,
  installElevenLabsApiKeyCapture,
  onElevenLabsSessionChange,
  openElevenLabsApiKeysPage,
  openElevenLabsLogin,
  saveElevenLabsApiKeyManually,
  testElevenLabsSession,
} from './services/elevenlabs-auth';
import { listElevenLabsVoices, previewElevenLabsVoice, addElevenLabsLibraryVoice } from './services/elevenlabs-tts';
import { testQwenTts } from './services/qwen-tts';
import {
  listGenmaxModels,
  listGenmaxVoices,
  previewGenmaxVoice,
  resolveGenmaxBackend,
  testGenmaxApiKey,
} from './services/genmax-tts';
import type { GenmaxBackend } from '../shared/types';
import { ElevenLabsKeyManager } from './services/api-keys/elevenlabs-key-manager';
import { listElevenLabsKeysPublic, getElevenLabsApiKeyPlain } from './services/api-keys/elevenlabs-keys-store';
import { getUsageSnapshot, getUsageHistory, loadMoreUsageHistory } from './services/usage';
import {
  installLocalMediaProtocol,
  registerLocalMediaScheme,
} from './services/local-media';
import { beginJob, endJob, getActiveJob, isJobActive, pauseActiveJob, resumeActiveJob, stopActiveJob } from './job-state';
import type { JobFinishedEvent, JobProgress } from '../shared/types';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
  saveProjectDraft,
} from './services/projects';

// Required before app ready so renderer can load project images/videos.
registerLocalMediaScheme();

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'SnapGen AI Studio',
    backgroundColor: '#0b0c0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

function registerIpc(): void {
  // Forge rebuilds main without always restarting Electron; clear first so
  // handlers can be re-registered safely after `rs`.
  for (const channel of Object.values(IPC)) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(IPC.getKeys, () => getKeys());
  ipcMain.handle(IPC.saveKeys, (_e, keys: ApiKeys) => {
    saveKeys(keys);
    return true;
  });
  ipcMain.handle(IPC.getSettings, () => getSettings());
  ipcMain.handle(IPC.saveSettings, (_e, settings: AppSettings) => {
    saveSettings(settings);
    return true;
  });
  ipcMain.handle(IPC.getModels, () => ({
    videoFamilies: VIDEO_FAMILIES,
    imageFamilies: IMAGE_FAMILIES,
    videoModels: VIDEO_MODELS,
    imageModels: IMAGE_MODELS,
    families: VIDEO_FAMILIES,
    models: [...VIDEO_MODELS, ...IMAGE_MODELS],
  }));

  ipcMain.handle(IPC.testSnapgen, async () => testAccount(getKeys().snapgenApiKey));
  ipcMain.handle(IPC.testOpenAI, async () => testOpenAI(getKeys().openaiApiKey));
  ipcMain.handle(IPC.testElevenLabs, async () => testElevenLabsSession());
  ipcMain.handle(IPC.testQwen, async () => {
    const keys = getKeys();
    const settings = getSettings();
    return testQwenTts({
      apiKey: keys.runpodApiKey,
      endpointId: settings.runpodEndpointId,
      voice: settings.qwenTtsVoice,
      languageType: settings.qwenLanguageType,
    });
  });
  ipcMain.handle(IPC.testGenmax, async () => testGenmaxApiKey(getKeys().genmaxApiKey));
  ipcMain.handle(
    IPC.genmaxListVoices,
    async (
      _e,
      input?: {
        backend?: GenmaxBackend;
        search?: string;
        page?: number;
        pageSize?: number;
        language?: string;
        gender?: string;
      }
    ) => {
      const key = getKeys().genmaxApiKey;
      if (!key?.trim()) throw new Error('Chưa có GenMax API key.');
      return listGenmaxVoices({
        apiKey: key,
        backend: resolveGenmaxBackend(input?.backend || getSettings().genmaxBackend),
        search: input?.search,
        page: input?.page,
        pageSize: input?.pageSize,
        language: input?.language,
        gender: input?.gender,
      });
    }
  );
  ipcMain.handle(
    IPC.genmaxPreviewVoice,
    async (
      _e,
      input: {
        voiceId: string;
        backend?: GenmaxBackend;
        modelId?: string;
        language?: string;
        speed?: number;
      }
    ) => {
      const key = getKeys().genmaxApiKey;
      if (!key?.trim()) throw new Error('Chưa có GenMax API key.');
      const settings = getSettings();
      return previewGenmaxVoice({
        apiKey: key,
        voiceId: input.voiceId,
        backend: resolveGenmaxBackend(input.backend || settings.genmaxBackend),
        modelId: input.modelId || settings.genmaxModelId,
        language: input.language,
        speed: input.speed ?? settings.genmaxSpeed,
      });
    }
  );
  ipcMain.handle(IPC.genmaxListModels, async (_e, input?: { backend?: GenmaxBackend }) => {
    const key = getKeys().genmaxApiKey;
    if (!key?.trim()) throw new Error('Chưa có GenMax API key.');
    return listGenmaxModels(
      key,
      resolveGenmaxBackend(input?.backend || getSettings().genmaxBackend)
    );
  });
  ipcMain.handle(IPC.getUsageQuotas, async () => getUsageSnapshot());
  ipcMain.handle(IPC.getUsageHistory, async () => getUsageHistory());
  ipcMain.handle(IPC.loadMoreUsageHistory, async (_e, request: LoadMoreUsageHistoryRequest) =>
    loadMoreUsageHistory(request)
  );
  ipcMain.handle(IPC.elevenLabsOpenLogin, async () => openElevenLabsLogin(mainWindow));
  ipcMain.handle(IPC.elevenLabsOpenApiKeys, async () => openElevenLabsApiKeysPage(mainWindow));
  ipcMain.handle(IPC.elevenLabsSaveApiKey, async (_e, apiKey: string) =>
    saveElevenLabsApiKeyManually(apiKey)
  );
  ipcMain.handle(IPC.elevenLabsListApiKeys, () => listElevenLabsKeysPublic());
  ipcMain.handle(
    IPC.elevenLabsAddApiKey,
    (_e, input: { apiKey: string; name?: string }) => {
      ElevenLabsKeyManager.addKey(input.apiKey, input.name);
      return listElevenLabsKeysPublic();
    }
  );
  ipcMain.handle(
    IPC.elevenLabsUpdateApiKey,
    (
      _e,
      input: { id: string; name?: string; apiKey?: string; enabled?: boolean }
    ) => ElevenLabsKeyManager.update(input.id, input)
  );
  ipcMain.handle(IPC.elevenLabsDeleteApiKey, (_e, id: string) =>
    ElevenLabsKeyManager.remove(id)
  );
  ipcMain.handle(
    IPC.elevenLabsMoveApiKey,
    (_e, input: { id: string; direction: 'up' | 'down' }) =>
      ElevenLabsKeyManager.move(input.id, input.direction)
  );
  ipcMain.handle(IPC.elevenLabsResetApiKeyStatus, (_e, id: string) =>
    ElevenLabsKeyManager.resetStatus(id)
  );
  ipcMain.handle(IPC.elevenLabsTestApiKey, async (_e, id: string) =>
    ElevenLabsKeyManager.testKey(id)
  );
  ipcMain.handle(IPC.elevenLabsRevealApiKey, (_e, id: string) => {
    const key = getElevenLabsApiKeyPlain(id);
    if (!key) throw new Error('Không tìm thấy API key.');
    return key;
  });
  ipcMain.handle(IPC.elevenLabsGetSession, async () => getElevenLabsSessionStatus());
  ipcMain.handle(IPC.elevenLabsClearSession, async () => clearElevenLabsSession());
  let listVoicesInFlight: Promise<unknown> | null = null;
  ipcMain.handle(IPC.elevenLabsListVoices, async () => {
    if (listVoicesInFlight) return listVoicesInFlight;
    listVoicesInFlight = listElevenLabsVoices().finally(() => {
      listVoicesInFlight = null;
    });
    return listVoicesInFlight;
  });
  ipcMain.handle(
    IPC.elevenLabsPreviewVoice,
    async (_e, input: { voiceId: string; modelId?: string; language?: string }) =>
      previewElevenLabsVoice(input)
  );
  ipcMain.handle(
    IPC.elevenLabsAddLibraryVoice,
    async (_e, input: { voiceIdOrUrl: string; newName?: string }) =>
      addElevenLabsLibraryVoice(input)
  );

  onElevenLabsSessionChange((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.elevenLabsSessionChanged, status);
      }
    }
  });

  ipcMain.handle(IPC.generateScript, async (_e, input: GenerateIdeaInput) => {
    const keys = getKeys();
    const settings = getSettings();
    if (!keys.openaiApiKey) throw new Error('Thiếu OpenAI API key.');
    const chatModel =
      (input.openaiChatModel || '').trim() || settings.openaiModel || 'gpt-4o-mini';
    return generateScript(keys.openaiApiKey, chatModel, input);
  });

  ipcMain.handle(
    IPC.generateMusicAnimationScript,
    async (_e, projectId: string, input?: Partial<GenerateMusicAnimationScriptInput>) => {
      const keys = getKeys();
      const settings = getSettings();
      if (!keys.openaiApiKey) throw new Error('Thiếu OpenAI API key.');
      const detail = getProject(projectId);
      const draft = detail.draft;
      if (!draft) throw new Error('Dự án chưa có draft.');
      const lyricText = String(input?.lyricText ?? draft.lyricText ?? '').trim();
      if (!lyricText) throw new Error('Chưa có lyric / script lời bài hát.');
      const musicPath = resolveMusicAudioPath(projectId);
      if (!musicPath) throw new Error('Chưa tải file nhạc. Import audio trước.');
      const musicDurationSec =
        input?.musicDurationSec && input.musicDurationSec > 0
          ? input.musicDurationSec
          : await getDurationSafe(musicPath, draft.targetDurationSec || 60);
      const chatModel =
        (input?.openaiChatModel || draft.openaiChatModel || '').trim() ||
        settings.openaiModel ||
        'gpt-4o-mini';
      const images = loadCharacterDataUrls(projectId);
      const result = await generateMusicAnimationScript(
        keys.openaiApiKey,
        chatModel,
        {
          lyricText,
          language: input?.language || draft.language || 'Tiếng Việt',
          musicDurationSec,
          sceneCount:
            input?.sceneCount ||
            draft.targetMediaCount ||
            (draft.script?.scenes?.length ? undefined : draft.sceneCount) ||
            undefined,
          family: input?.family || draft.family,
          model: input?.model || draft.model,
          aspectRatio: input?.aspectRatio || draft.aspectRatio,
          resolution: input?.resolution || draft.resolution,
          mediaKind: input?.mediaKind || draft.mediaKind || 'video',
          stylePrompt: input?.stylePrompt ?? draft.stylePrompt,
          openaiChatModel: chatModel,
          characterBrief: input?.characterBrief,
          songTitle: input?.songTitle || detail.meta.name,
        },
        images
      );
      saveProjectDraft(projectId, {
        ...draft,
        projectKind: 'music-animation',
        lyricText,
        script: result.script,
        sceneCount: result.script.scenes.length,
        targetDurationSec: Math.round(musicDurationSec),
        musicStoryNotes: result.notes,
      });
      return result;
    }
  );

  ipcMain.handle(IPC.importMusicAudio, async (_e, projectId: string) => {
    const pick = await dialog.showOpenDialog(mainWindow!, {
      title: 'Chọn file nhạc / audio bài hát',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    return importMusicAudio({ projectId, sourcePath: pick.filePaths[0] });
  });

  ipcMain.handle(IPC.clearMusicAudio, (_e, projectId: string) => clearMusicAudio(projectId));

  ipcMain.handle(IPC.importMusicCharacters, async (_e, projectId: string) => {
    const pick = await dialog.showOpenDialog(mainWindow!, {
      title: 'Chọn ảnh nhân vật (optional)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (pick.canceled || !pick.filePaths.length) return null;
    return importMusicCharacters({ projectId, sourcePaths: pick.filePaths });
  });

  ipcMain.handle(IPC.clearMusicCharacters, (_e, projectId: string) =>
    clearMusicCharacters(projectId)
  );

  ipcMain.handle(IPC.startGenerate, async (_e, input: GenerateJobInput) => {
    if (isJobActive()) throw new Error('Đang có job chạy. Đợi hoàn tất.');
    beginJob({
      projectId: input.projectId,
      projectName: input.projectName,
      kind: 'generate',
    });
    try {
      const result = await runGenerateJob(input);
      const finished: JobFinishedEvent = {
        projectId: result.projectId,
        kind: 'generate',
        ok: true,
        result,
      };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.jobFinished, finished);
      }
      return result;
    } catch (err) {
      const finished: JobFinishedEvent = {
        projectId: input.projectId || null,
        kind: 'generate',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.jobFinished, finished);
      }
      throw err;
    } finally {
      endJob();
    }
  });

  ipcMain.handle(IPC.importNarrationAudio, async (_e, projectId: string) => {
    const pick = await dialog.showOpenDialog(mainWindow!, {
      title: 'Chọn file audio narration tự tạo',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    return importExternalNarration({ projectId, sourcePath: pick.filePaths[0] });
  });

  ipcMain.removeHandler(IPC.clearNarrationAudio);
  ipcMain.handle(IPC.clearNarrationAudio, (_e, projectId: string) => {
    return clearProjectNarration(String(projectId || ''));
  });

  ipcMain.handle(IPC.remuxProject, async (_e, projectId: string) => {
    if (isJobActive()) throw new Error('Đang có job chạy. Đợi hoàn tất.');
    const detail = getProject(projectId);
    beginJob({
      projectId,
      projectName: detail.meta.name,
      kind: 'remux',
    });
    try {
      const result = await remuxProject(projectId);
      const finished: JobFinishedEvent = {
        projectId,
        kind: 'remux',
        ok: true,
        result,
      };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.jobFinished, finished);
      }
      return result;
    } catch (err) {
      const finished: JobFinishedEvent = {
        projectId,
        kind: 'remux',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.jobFinished, finished);
      }
      throw err;
    } finally {
      endJob();
    }
  });

  ipcMain.handle(IPC.getActiveJob, () => getActiveJob());

  const emitJobProgressNow = () => {
    const snap = getActiveJob();
    if (!snap.progress) return;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.jobProgress, snap.progress as JobProgress);
    }
  };

  ipcMain.handle(IPC.pauseJob, () => {
    const result = pauseActiveJob();
    emitJobProgressNow();
    return result;
  });
  ipcMain.handle(IPC.resumeJob, () => {
    const result = resumeActiveJob();
    emitJobProgressNow();
    return result;
  });
  ipcMain.handle(IPC.stopJob, () => {
    const result = stopActiveJob();
    emitJobProgressNow();
    return result;
  });

  ipcMain.handle(IPC.listProjects, () => listProjects());
  ipcMain.handle(IPC.getProject, (_e, id: string) => getProject(id));
  ipcMain.handle(IPC.createProject, (_e, input: CreateProjectInput) => createProject(input));
  ipcMain.handle(IPC.renameProject, (_e, id: string, name: string) => renameProject(id, name));
  ipcMain.handle(IPC.deleteProject, (_e, id: string) => deleteProject(id));
  ipcMain.handle(
    IPC.saveProjectDraft,
    (_e, id: string, draft: ProjectDraft, patch?: { name?: string }) =>
      saveProjectDraft(id, draft, patch)
  );

  ipcMain.handle(IPC.openPath, async (_e, target: string) => shell.openPath(target));
  ipcMain.handle(IPC.showItemInFolder, (_e, target: string) => {
    shell.showItemInFolder(target);
  });

  ipcMain.handle(
    IPC.exportVideo,
    async (_e, sourcePath: string, suggestedName?: string) => {
      const result = await exportFinalFile(sourcePath, suggestedName);
      return result?.path ?? null;
    }
  );

  ipcMain.handle(
    IPC.exportMedia,
    async (_e, request: ExportMediaRequest): Promise<ExportMediaResult | null> => {
      if (request.mode === 'final') {
        if (!request.final?.sourcePath) {
          throw new Error('Thiếu đường dẫn video final.');
        }
        return exportFinalFile(request.final.sourcePath, request.final.suggestedName);
      }

      const scenes = request.scenes ?? [];
      if (!scenes.length) {
        throw new Error('Chưa chọn phân cảnh nào để lưu.');
      }

      const settings = getSettings();
      const pick = await dialog.showOpenDialog(mainWindow!, {
        title: 'Chọn thư mục lưu các phân cảnh',
        defaultPath: settings.lastExportDir || app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (pick.canceled || !pick.filePaths[0]) return null;

      const fs = await import('node:fs/promises');
      const destDir = pick.filePaths[0];
      const written: string[] = [];
      for (const item of scenes) {
        const dest = path.join(destDir, sanitizeFileName(item.fileName));
        await fs.copyFile(item.sourcePath, dest);
        written.push(dest);
      }
      saveSettings({ ...settings, lastExportDir: destDir });
      return { mode: 'scenes', path: destDir, files: written };
    }
  );
}

function sanitizeFileName(name: string): string {
  const cleaned =
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'export';
  return cleaned;
}

async function exportFinalFile(
  sourcePath: string,
  suggestedName?: string
): Promise<ExportMediaResult | null> {
  const settings = getSettings();
  const safeName = sanitizeFileName(suggestedName || 'final');
  const defaultPath = settings.lastExportDir
    ? path.join(settings.lastExportDir, `${safeName}.mp4`)
    : path.join(app.getPath('documents'), `${safeName}.mp4`);

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Chọn nơi lưu video final',
    defaultPath,
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (result.canceled || !result.filePath) return null;

  const fs = await import('node:fs/promises');
  await fs.copyFile(sourcePath, result.filePath);
  saveSettings({
    ...settings,
    lastExportDir: path.dirname(result.filePath),
  });
  return { mode: 'final', path: result.filePath };
}

app.whenReady().then(() => {
  installLocalMediaProtocol();
  installElevenLabsApiKeyCapture();
  // Bootstrap GenMax key: GENMAX_API_KEY env, hoặc file userData/.genmax-key (một lần).
  {
    const bootstrapFile = path.join(app.getPath('userData'), '.genmax-key');
    let bootKey = (process.env.GENMAX_API_KEY || '').trim();
    if (!bootKey && fs.existsSync(bootstrapFile)) {
      try {
        bootKey = fs.readFileSync(bootstrapFile, 'utf8').trim();
        fs.rmSync(bootstrapFile, { force: true });
      } catch {
        bootKey = '';
      }
    }
    if (bootKey) ensureGenmaxApiKey(bootKey);
  }
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
