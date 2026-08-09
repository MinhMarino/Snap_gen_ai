import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  ApiKeys,
  AppSettings,
  ConnectionTestResult,
  CreateProjectInput,
  ElevenLabsSessionStatus,
  ElevenLabsVoice,
  GenmaxBackend,
  GenmaxVoice,
  ExportMediaRequest,
  ExportMediaResult,
  GenerateIdeaInput,
  GenerateJobInput,
  GenerateJobResult,
  ImageFamily,
  JobFinishedEvent,
  JobProgress,
  ActiveJobSnapshot,
  ModelOption,
  ProjectDetail,
  ProjectDraft,
  ProjectMeta,
  ScriptDraft,
  LoadMoreUsageHistoryRequest,
  LoadMoreUsageHistoryResult,
  UsageHistorySnapshot,
  UsageSnapshot,
  VideoFamily,
} from '../shared/types';
import type { ProviderApiKeyPublic } from '../shared/provider-api-keys';

const api = {
  getKeys: (): Promise<ApiKeys> => ipcRenderer.invoke(IPC.getKeys),
  saveKeys: (keys: ApiKeys): Promise<boolean> => ipcRenderer.invoke(IPC.saveKeys, keys),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (settings: AppSettings): Promise<boolean> =>
    ipcRenderer.invoke(IPC.saveSettings, settings),
  getModels: (): Promise<{
    videoFamilies: { id: VideoFamily; label: string }[];
    imageFamilies: { id: ImageFamily; label: string }[];
    videoModels: ModelOption[];
    imageModels: ModelOption[];
    families: { id: VideoFamily; label: string }[];
    models: ModelOption[];
  }> => ipcRenderer.invoke(IPC.getModels),
  testSnapgen: (): Promise<ConnectionTestResult> => ipcRenderer.invoke(IPC.testSnapgen),
  testOpenAI: (): Promise<ConnectionTestResult> => ipcRenderer.invoke(IPC.testOpenAI),
  testElevenLabs: (): Promise<ConnectionTestResult> => ipcRenderer.invoke(IPC.testElevenLabs),
  testQwen: (): Promise<ConnectionTestResult> => ipcRenderer.invoke(IPC.testQwen),
  testGenmax: (): Promise<ConnectionTestResult> => ipcRenderer.invoke(IPC.testGenmax),
  listGenmaxVoices: (input?: {
    backend?: GenmaxBackend;
    search?: string;
    page?: number;
    pageSize?: number;
    language?: string;
    gender?: string;
  }): Promise<GenmaxVoice[]> => ipcRenderer.invoke(IPC.genmaxListVoices, input),
  previewGenmaxVoice: (input: {
    voiceId: string;
    backend?: GenmaxBackend;
    modelId?: string;
    language?: string;
    speed?: number;
  }): Promise<{ dataUrl: string }> => ipcRenderer.invoke(IPC.genmaxPreviewVoice, input),
  listGenmaxModels: (input?: {
    backend?: GenmaxBackend;
  }): Promise<Array<{ modelId: string; name: string; description?: string; maxChars?: number }>> =>
    ipcRenderer.invoke(IPC.genmaxListModels, input),
  getUsageQuotas: (): Promise<UsageSnapshot> => ipcRenderer.invoke(IPC.getUsageQuotas),
  getUsageHistory: (): Promise<UsageHistorySnapshot> => ipcRenderer.invoke(IPC.getUsageHistory),
  loadMoreUsageHistory: (
    request: LoadMoreUsageHistoryRequest
  ): Promise<LoadMoreUsageHistoryResult> => ipcRenderer.invoke(IPC.loadMoreUsageHistory, request),
  openElevenLabsLogin: (): Promise<ElevenLabsSessionStatus> =>
    ipcRenderer.invoke(IPC.elevenLabsOpenLogin),
  openElevenLabsApiKeys: (): Promise<ElevenLabsSessionStatus> =>
    ipcRenderer.invoke(IPC.elevenLabsOpenApiKeys),
  saveElevenLabsApiKey: (apiKey: string): Promise<ElevenLabsSessionStatus> =>
    ipcRenderer.invoke(IPC.elevenLabsSaveApiKey, apiKey),
  listElevenLabsApiKeys: (): Promise<ProviderApiKeyPublic[]> =>
    ipcRenderer.invoke(IPC.elevenLabsListApiKeys),
  addElevenLabsApiKey: (input: {
    apiKey: string;
    name?: string;
  }): Promise<ProviderApiKeyPublic[]> => ipcRenderer.invoke(IPC.elevenLabsAddApiKey, input),
  updateElevenLabsApiKey: (input: {
    id: string;
    name?: string;
    apiKey?: string;
    enabled?: boolean;
  }): Promise<ProviderApiKeyPublic[]> => ipcRenderer.invoke(IPC.elevenLabsUpdateApiKey, input),
  deleteElevenLabsApiKey: (id: string): Promise<ProviderApiKeyPublic[]> =>
    ipcRenderer.invoke(IPC.elevenLabsDeleteApiKey, id),
  moveElevenLabsApiKey: (input: {
    id: string;
    direction: 'up' | 'down';
  }): Promise<ProviderApiKeyPublic[]> => ipcRenderer.invoke(IPC.elevenLabsMoveApiKey, input),
  resetElevenLabsApiKeyStatus: (id: string): Promise<ProviderApiKeyPublic[]> =>
    ipcRenderer.invoke(IPC.elevenLabsResetApiKeyStatus, id),
  testElevenLabsApiKey: (id: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.elevenLabsTestApiKey, id),
  revealElevenLabsApiKey: (id: string): Promise<string> =>
    ipcRenderer.invoke(IPC.elevenLabsRevealApiKey, id),
  getElevenLabsSession: (): Promise<ElevenLabsSessionStatus> =>
    ipcRenderer.invoke(IPC.elevenLabsGetSession),
  clearElevenLabsSession: (): Promise<ElevenLabsSessionStatus> =>
    ipcRenderer.invoke(IPC.elevenLabsClearSession),
  listElevenLabsVoices: (): Promise<ElevenLabsVoice[]> =>
    ipcRenderer.invoke(IPC.elevenLabsListVoices),
  previewElevenLabsVoice: (input: {
    voiceId: string;
    modelId?: string;
    language?: string;
  }): Promise<{ dataUrl: string }> => ipcRenderer.invoke(IPC.elevenLabsPreviewVoice, input),
  addElevenLabsLibraryVoice: (input: {
    voiceIdOrUrl: string;
    newName?: string;
  }): Promise<{
    voiceId: string;
    libraryVoiceId: string;
    publicOwnerId: string;
    name: string;
    syncedKeys: number;
    message: string;
    voices: ElevenLabsVoice[];
  }> => ipcRenderer.invoke(IPC.elevenLabsAddLibraryVoice, input),
  onElevenLabsSessionChange: (cb: (status: ElevenLabsSessionStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, status: ElevenLabsSessionStatus) => cb(status);
    ipcRenderer.on(IPC.elevenLabsSessionChanged, listener);
    return () => ipcRenderer.removeListener(IPC.elevenLabsSessionChanged, listener);
  },
  generateScript: (input: GenerateIdeaInput): Promise<ScriptDraft> =>
    ipcRenderer.invoke(IPC.generateScript, input),
  generateMusicAnimationScript: (
    projectId: string,
    input?: Partial<{
      lyricText: string;
      language: string;
      musicDurationSec: number;
      stylePrompt: string;
      openaiChatModel: string;
      songTitle: string;
    }>
  ): Promise<{ script: ScriptDraft; notes: string }> =>
    ipcRenderer.invoke(IPC.generateMusicAnimationScript, projectId, input),
  importMusicAudio: (
    projectId: string
  ): Promise<{
    musicRelativePath: string;
    audioPath: string;
    durationSec: number;
    draft: ProjectDraft;
  } | null> => ipcRenderer.invoke(IPC.importMusicAudio, projectId),
  clearMusicAudio: (
    projectId: string
  ): Promise<{ removed: string[]; draft: ProjectDraft }> =>
    ipcRenderer.invoke(IPC.clearMusicAudio, projectId),
  importMusicCharacters: (
    projectId: string
  ): Promise<{ characterRelativePaths: string[]; draft: ProjectDraft } | null> =>
    ipcRenderer.invoke(IPC.importMusicCharacters, projectId),
  clearMusicCharacters: (
    projectId: string
  ): Promise<{ removed: string[]; draft: ProjectDraft }> =>
    ipcRenderer.invoke(IPC.clearMusicCharacters, projectId),
  startGenerate: (input: GenerateJobInput): Promise<GenerateJobResult> =>
    ipcRenderer.invoke(IPC.startGenerate, input),
  getActiveJob: (): Promise<ActiveJobSnapshot> => ipcRenderer.invoke(IPC.getActiveJob),
  pauseJob: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IPC.pauseJob),
  resumeJob: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IPC.resumeJob),
  stopJob: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IPC.stopJob),
  onJobProgress: (cb: (p: JobProgress) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: JobProgress) => cb(p);
    ipcRenderer.on(IPC.jobProgress, listener);
    return () => ipcRenderer.removeListener(IPC.jobProgress, listener);
  },
  onJobFinished: (cb: (event: JobFinishedEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: JobFinishedEvent) => cb(event);
    ipcRenderer.on(IPC.jobFinished, listener);
    return () => ipcRenderer.removeListener(IPC.jobFinished, listener);
  },
  openPath: (target: string): Promise<string> => ipcRenderer.invoke(IPC.openPath, target),
  showItemInFolder: (target: string): Promise<void> =>
    ipcRenderer.invoke(IPC.showItemInFolder, target),
  exportVideo: (sourcePath: string, suggestedName?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportVideo, sourcePath, suggestedName),
  exportMedia: (request: ExportMediaRequest): Promise<ExportMediaResult | null> =>
    ipcRenderer.invoke(IPC.exportMedia, request),
  remuxProject: (projectId: string): Promise<GenerateJobResult> =>
    ipcRenderer.invoke(IPC.remuxProject, projectId),
  importNarrationAudio: (
    projectId: string
  ): Promise<{
    audioPath: string;
    script: ScriptDraft;
    alignedWithWhisper: boolean;
    durationSec: number;
  } | null> => ipcRenderer.invoke(IPC.importNarrationAudio, projectId),
  clearNarrationAudio: (
    projectId: string
  ): Promise<{ projectId: string; removed: string[] }> =>
    ipcRenderer.invoke(IPC.clearNarrationAudio, projectId),

  listProjects: (): Promise<ProjectMeta[]> => ipcRenderer.invoke(IPC.listProjects),
  getProject: (id: string): Promise<ProjectDetail> => ipcRenderer.invoke(IPC.getProject, id),
  createProject: (input: CreateProjectInput): Promise<ProjectMeta> =>
    ipcRenderer.invoke(IPC.createProject, input),
  renameProject: (id: string, name: string): Promise<ProjectMeta> =>
    ipcRenderer.invoke(IPC.renameProject, id, name),
  deleteProject: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.deleteProject, id),
  saveProjectDraft: (
    id: string,
    draft: ProjectDraft,
    patch?: { name?: string }
  ): Promise<ProjectMeta> => ipcRenderer.invoke(IPC.saveProjectDraft, id, draft, patch),
};

contextBridge.exposeInMainWorld('studio', api);

export type StudioApi = typeof api;
