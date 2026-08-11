import { useEffect, useMemo, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import type {
  ExportMode,
  GenerateJobResult,
  ImageFamily,
  JobProgress,
  MediaKind,
  ModelOption,
  ProjectKind,
  SceneMediaAsset,
  ScriptDraft,
  VideoFamily,
} from '../../shared/types';
import { resolveProjectKind } from '../../shared/types';
import {
  clampTargetSceneCount,
  DEFAULT_PROJECT_LANGUAGE,
  DEFAULT_SCENE_DENSITY,
  DEFAULT_STYLE_PROMPT,
  defaultFamilyForKind,
  defaultModelIdForKind,
  estimateGenerationCredits,
  estimateScriptSpokenSeconds,
  formatCreditEstimate,
  formatDurationLabel,
  getModelById,
  maxSingleShotDuration,
  planSceneChunks,
  planScenesFromDuration,
  resolveModelId,
  resolveSceneDensity,
  SCENE_DENSITY_OPTIONS,
  type SceneDensityId,
} from '../../shared/models';
import { toLocalMediaUrl } from '../../shared/media-url';
import ModelPicker from '../components/ModelPicker';
import Timeline from '../components/Timeline';
import ExportDialog, { buildExportableScenes } from '../components/ExportDialog';
import GenerateScenesDialog from '../components/GenerateScenesDialog';
import MusicAnimationPanel, {
  type MusicWorkflowStep,
} from '../components/MusicAnimationPanel';
import ProjectVoicePanel from '../components/ProjectVoicePanel';
import StepActivityUI, {
  createLogLine,
  type ActivityLogLevel,
  type StepActivityState,
} from '../components/StepActivityUI';
import type { ProjectVoiceSettings } from '../../shared/types';
import { OPENAI_CHAT_MODELS } from '../../shared/types';
import { DEFAULT_PROJECT_VOICE, resolveProjectChatModel, resolveProjectVoice } from '../../shared/voice';
import {
  canonicalAspectRatio,
  formatOutputFormatLabel,
  inferOutputFormatId,
  type OutputFormatId,
} from '../../shared/output-format';

const DURATION_PRESETS_MIN = [0.5, 1, 2, 3, 5, 10, 15] as const;
const DEFAULT_DURATION_MIN = 1;

function minutesFromSeconds(totalSec: unknown, fallback = DEFAULT_DURATION_MIN): number {
  const sec = Number(totalSec);
  if (!Number.isFinite(sec) || sec <= 0) return fallback;
  return Math.max(0.5, Math.round((sec / 60) * 2) / 2);
}

function sanitizeDurationMinutes(value: unknown, fallback = DEFAULT_DURATION_MIN): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Popup xác nhận số media sẽ gọi API trước khi gen (tránh gen hàng loạt ngoài ý muốn). */
function buildMediaGenerateConfirmMessage(options: {
  mediaKind: MediaKind;
  script: ScriptDraft;
  sceneMedia: SceneMediaAsset[];
  regenerateSceneIds: string[];
  modelId: string;
  family: string;
}): string {
  const { mediaKind, script, sceneMedia, regenerateSceneIds, modelId, family } = options;
  const mediaLabel = mediaKind === 'image' ? 'ảnh' : 'video';
  const total = script.scenes.length;
  const selected = new Set(regenerateSceneIds);
  let overwriteCount = 0;
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    if (!selected.has(scene.id)) continue;
    const asset = sceneMedia.find((a) => a.sceneId === scene.id) ?? sceneMedia[i];
    if (asset?.exists) overwriteCount += 1;
  }
  const newCount = Math.max(0, regenerateSceneIds.length - overwriteCount);
  const keepCount = Math.max(0, total - regenerateSceneIds.length);

  let apiCalls = regenerateSceneIds.length;
  if (mediaKind === 'video') {
    apiCalls = 0;
    for (const scene of script.scenes) {
      if (!selected.has(scene.id)) continue;
      apiCalls += planSceneChunks(modelId, family, scene.duration_hint).chunks.length;
    }
  }

  const splitNote =
    mediaKind === 'video' && apiCalls !== regenerateSceneIds.length
      ? ` (~${apiCalls} lượt gọi API — scene dài được chia thành nhiều shot).`
      : '.';
  const lines = [`Xác nhận tạo ${regenerateSceneIds.length} ${mediaLabel} scene${splitNote}`];

  // Chi phí ước tính theo bảng giá Snapgen — cho biết trước khi tốn credit.
  const estimate = estimateGenerationCredits({
    mediaKind,
    modelId,
    family,
    durations: script.scenes
      .filter((scene) => selected.has(scene.id))
      .map((scene) => scene.duration_hint),
  });
  lines.push(`• Chi phí ước tính: ${formatCreditEstimate(estimate)}`);

  // Chưa có media nào thì đừng nhắc "ghi đè: 0" — chỉ gây hoang mang.
  if (overwriteCount > 0) {
    lines.push(`• Mới: ${newCount}`, `• Ghi đè ${mediaLabel} đã có: ${overwriteCount}`);
  } else {
    lines.push(`• Tất cả ${newCount} scene đều chưa có ${mediaLabel} — không ghi đè gì.`);
  }
  if (keepCount > 0) {
    lines.push(`• Giữ nguyên / không gen: ${keepCount} (tổng ${total} scene)`);
  }
  if (mediaKind === 'image') {
    lines.push(
      '',
      'Ảnh đã có sẽ được loop theo thời lượng scene khi ghép Final — không gen thêm ảnh.'
    );
  }
  lines.push('', 'Tiếp tục?');
  return lines.join('\n');
}

type WorkflowStep = 'script' | 'voice' | 'media' | 'merge';

interface Props {
  projectId: string | null;
  onProjectReady: (id: string) => void;
  onNeedProject: () => void;
}

const WORKFLOW_STEPS: Array<{
  id: WorkflowStep;
  step: number;
  icon: string;
  label: string;
  short: string;
}> = [
  { id: 'script', step: 1, icon: '1', label: 'Tạo script', short: 'Script' },
  { id: 'voice', step: 2, icon: '2', label: 'Tạo voice', short: 'Voice' },
  { id: 'media', step: 3, icon: '3', label: 'Tạo ảnh/video', short: 'Media' },
  { id: 'merge', step: 4, icon: '4', label: 'Ghép Final', short: 'Ghép' },
];

/** music-animation: map lại 4 bước lên cùng WorkflowStep id. */
const MUSIC_WORKFLOW_STEPS: Array<{
  id: WorkflowStep;
  step: number;
  icon: string;
  label: string;
  short: string;
  musicStep: MusicWorkflowStep;
}> = [
  { id: 'script', step: 1, icon: '1', label: 'Input nhạc', short: 'Nhạc', musicStep: 'input' },
  { id: 'voice', step: 2, icon: '2', label: 'Phân cảnh AI', short: 'Phân cảnh', musicStep: 'storyboard' },
  { id: 'media', step: 3, icon: '3', label: 'Tạo video', short: 'Media', musicStep: 'media' },
  { id: 'merge', step: 4, icon: '4', label: 'Ghép nhạc', short: 'Ghép', musicStep: 'merge' },
];

/** audio-only: chỉ script + TTS (ElevenLabs). */
const AUDIO_WORKFLOW_STEPS: Array<{
  id: WorkflowStep;
  step: number;
  icon: string;
  label: string;
  short: string;
}> = [
  { id: 'script', step: 1, icon: '1', label: 'Tạo script', short: 'Script' },
  { id: 'voice', step: 2, icon: '2', label: 'Tạo audio', short: 'Audio' },
];

function workflowStepToMusic(step: WorkflowStep): MusicWorkflowStep {
  return MUSIC_WORKFLOW_STEPS.find((s) => s.id === step)?.musicStep || 'input';
}

function musicStepToWorkflow(step: MusicWorkflowStep): WorkflowStep {
  return MUSIC_WORKFLOW_STEPS.find((s) => s.musicStep === step)?.id || 'script';
}

function toFileUrl(filePath: string): string {
  return toLocalMediaUrl(filePath);
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default function Studio({ projectId, onProjectReady, onNeedProject }: Props) {
  const [activeStep, setActiveStep] = useState<WorkflowStep>('script');
  const [videoFamilies, setVideoFamilies] = useState<{ id: VideoFamily; label: string }[]>([]);
  const [imageFamilies, setImageFamilies] = useState<{ id: ImageFamily; label: string }[]>([]);
  const [videoModels, setVideoModels] = useState<ModelOption[]>([]);
  const [imageModels, setImageModels] = useState<ModelOption[]>([]);
  const [projectName, setProjectName] = useState('Untitled project');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(projectId);
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<MediaKind>('video');
  const [family, setFamily] = useState<string>(defaultFamilyForKind('video'));
  const [modelId, setModelId] = useState(defaultModelIdForKind('video'));
  const [brief, setBrief] = useState('');
  const [stylePrompt, setStylePrompt] = useState(DEFAULT_STYLE_PROMPT);
  const [language, setLanguage] = useState(DEFAULT_PROJECT_LANGUAGE);
  /** Free-text minutes; may be empty while typing. */
  const [durationInput, setDurationInput] = useState(String(DEFAULT_DURATION_MIN));
  /** dense | normal | economy | custom — kiểm soát số ảnh/video. */
  const [sceneDensity, setSceneDensity] = useState<SceneDensityId>(DEFAULT_SCENE_DENSITY);
  const [targetMediaCount, setTargetMediaCount] = useState(20);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [outputFormat, setOutputFormat] = useState<OutputFormatId>('youtube');
  const [resolution, setResolution] = useState('720p');
  const [mode, setMode] = useState('');
  const [script, setScript] = useState<ScriptDraft | null>(null);
  const [openaiChatModel, setOpenaiChatModel] = useState('gpt-4o-mini');
  const [sceneMedia, setSceneMedia] = useState<SceneMediaAsset[]>([]);
  const [selectedScene, setSelectedScene] = useState(0);
  const [previewMode, setPreviewMode] = useState<'scene' | 'final'>('scene');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [result, setResult] = useState<GenerateJobResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(72);
  const [timelineDirty, setTimelineDirty] = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [hasNarration, setHasNarration] = useState(false);
  const [narrationPath, setNarrationPath] = useState<string | null>(null);
  const [narrationPlaying, setNarrationPlaying] = useState(false);
  const narrationAudioRef = useRef<HTMLAudioElement | null>(null);
  const [voice, setVoice] = useState<ProjectVoiceSettings>({ ...DEFAULT_PROJECT_VOICE });
  const [projectKind, setProjectKind] = useState<ProjectKind>('standard');
  const [lyricText, setLyricText] = useState('');
  const [musicRelativePath, setMusicRelativePath] = useState<string | undefined>();
  const [characterRelativePaths, setCharacterRelativePaths] = useState<string[]>([]);
  const [musicStoryNotes, setMusicStoryNotes] = useState('');
  const [musicCastLock, setMusicCastLock] = useState('');
  const [musicDurationSec, setMusicDurationSec] = useState<number | null>(null);
  const [activity, setActivity] = useState<StepActivityState | null>(null);
  const isMusicAnimation = projectKind === 'music-animation';
  const isAudioOnly = projectKind === 'audio-only';
  const railSteps = isMusicAnimation
    ? MUSIC_WORKFLOW_STEPS
    : isAudioOnly
      ? AUDIO_WORKFLOW_STEPS
      : WORKFLOW_STEPS;
  const remuxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remuxRunning = useRef(false);
  const remuxPending = useRef<ScriptDraft | null>(null);
  const generateRunning = useRef(false);
  const lastActivityLogRef = useRef<string>('');

  const startActivity = (input: {
    stepId: string;
    title: string;
    blurb: string;
    showJobControls?: boolean;
    firstLog?: string;
  }) => {
    lastActivityLogRef.current = '';
    setActivity({
      stepId: input.stepId,
      title: input.title,
      blurb: input.blurb,
      percent: 2,
      status: 'running',
      logs: input.firstLog ? [createLogLine(input.firstLog)] : [],
      modalOpen: true,
      dockOpen: true,
      showJobControls: Boolean(input.showJobControls),
      jobProgress: null,
    });
  };

  const pushActivityLog = (text: string, level: ActivityLogLevel = 'info') => {
    const trimmed = text.trim();
    if (!trimmed || trimmed === lastActivityLogRef.current) return;
    lastActivityLogRef.current = trimmed;
    setActivity((prev) =>
      prev
        ? { ...prev, logs: [...prev.logs, createLogLine(trimmed, level)].slice(-80) }
        : prev
    );
  };

  const setActivityPercent = (percent: number) => {
    setActivity((prev) => (prev ? { ...prev, percent: Math.min(100, Math.max(0, percent)) } : prev));
  };

  const finishActivity = (ok: boolean, message: string) => {
    setActivity((prev) =>
      prev
        ? {
            ...prev,
            status: ok ? 'done' : 'error',
            percent: ok ? 100 : prev.percent,
            modalOpen: true,
            dockOpen: true,
            logs: [...prev.logs, createLogLine(message, ok ? 'ok' : 'error')].slice(-80),
          }
        : prev
    );
  };

  const hasSceneMedia = sceneMedia.some((asset) => asset.exists);
  const allScenesHaveMedia = useMemo(() => {
    if (!script?.scenes.length) return false;
    return script.scenes.every((scene, index) => {
      const asset =
        sceneMedia.find((item) => item.sceneId === scene.id) ?? sceneMedia[index];
      return Boolean(asset?.exists);
    });
  }, [script, sceneMedia]);
  const canRemux = Boolean(activeProjectId && script?.scenes.length && hasSceneMedia);

  const models = mediaKind === 'image' ? imageModels : videoModels;
  const families = mediaKind === 'image' ? imageFamilies : videoFamilies;
  const selectedModel = useMemo(
    () => models.find((item) => item.id === modelId),
    [models, modelId]
  );
  const maxShotSec = useMemo(
    () => maxSingleShotDuration(modelId),
    [modelId]
  );
  const targetDurationMin = useMemo(() => {
    if (durationInput === '' || durationInput === '.' || durationInput === ',') {
      return DEFAULT_DURATION_MIN;
    }
    return sanitizeDurationMinutes(
      String(durationInput).replace(',', '.'),
      DEFAULT_DURATION_MIN
    );
  }, [durationInput]);
  const densityBeatSec = useMemo(
    () => SCENE_DENSITY_OPTIONS.find((d) => d.id === sceneDensity)?.beatSec ?? null,
    [sceneDensity]
  );
  const scenePlan = useMemo(() => {
    const durationSec =
      isMusicAnimation && musicDurationSec && musicDurationSec > 0
        ? musicDurationSec
        : targetDurationMin * 60;
    return planScenesFromDuration(durationSec, {
      targetSceneCount: sceneDensity === 'custom' ? targetMediaCount : undefined,
      typicalBeatSec: densityBeatSec ?? undefined,
      mediaKind,
    });
  }, [
    isMusicAnimation,
    musicDurationSec,
    targetDurationMin,
    sceneDensity,
    targetMediaCount,
    densityBeatSec,
    mediaKind,
  ]);

  useEffect(() => {
    if (sceneDensity === 'custom') return;
    setTargetMediaCount(scenePlan.sceneCountHint);
  }, [sceneDensity, scenePlan.sceneCountHint]);
  const setTargetDurationMin = (minutes: number) => {
    setDurationInput(String(sanitizeDurationMinutes(minutes)));
  };
  const onDurationInputChange = (raw: string) => {
    // Allow empty / intermediate values while typing (e.g. "", "0", "12.")
    if (raw === '' || raw === '.' || raw === ',') {
      setDurationInput('');
      return;
    }
    if (!/^\d*[.,]?\d*$/.test(raw)) return;
    setDurationInput(raw);
  };
  const onDurationInputBlur = () => {
    const parsed = sanitizeDurationMinutes(
      String(durationInput).replace(',', '.'),
      0.5
    );
    setDurationInput(String(parsed));
  };
  // Recover if an older draft path wrote "NaN" into the field.
  useEffect(() => {
    if (/^nan$/i.test(durationInput.trim())) {
      setDurationInput(String(DEFAULT_DURATION_MIN));
    }
  }, [durationInput]);
  const currentScene = script?.scenes[selectedScene] ?? null;
  const currentAsset =
    sceneMedia.find((asset) => asset.sceneId === currentScene?.id) ??
    sceneMedia[selectedScene] ??
    null;
  const totalDuration = useMemo(
    () => script?.scenes.reduce((sum, scene) => sum + scene.duration_hint, 0) ?? 0,
    [script]
  );
  const sceneOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const scene of script?.scenes ?? []) {
      offsets.push(acc);
      acc += scene.duration_hint;
    }
    return offsets;
  }, [script]);
  const playableSrc =
    previewMode === 'final' && result
      ? result.videoPath
      : previewMode === 'scene' && currentAsset?.exists && currentAsset.kind === 'video'
        ? currentAsset.path
        : null;
  const sceneTotal = script?.scenes.length ?? 0;
  const canStepScene = sceneTotal > 1;

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const stepScene = (delta: number) => {
    if (!sceneTotal) return;
    const next = Math.min(sceneTotal - 1, Math.max(0, selectedScene + delta));
    if (next === selectedScene) return;
    setSelectedScene(next);
    if (previewMode === 'final' && videoRef.current) {
      videoRef.current.currentTime = Math.min(
        Math.max(0, sceneOffsets[next] ?? 0),
        Math.max(0, (videoRef.current.duration || totalDuration) - 0.05)
      );
    }
  };

  const videoEvents = {
    ref: videoRef,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) =>
      setCurrentTime(event.currentTarget.currentTime),
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => {
      const value = event.currentTarget.duration;
      setMediaDuration(Number.isFinite(value) ? value : 0);
      setCurrentTime(0);
    },
  };

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setMediaDuration(0);
  }, [playableSrc]);

  // `timeupdate` only fires a few times per second, which makes the playhead
  // stutter; sample the element directly while it plays.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 33) return;
      last = now;
      const video = videoRef.current;
      if (video) setCurrentTime(video.currentTime);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // The rendered clips can drift a little from their planned duration, so map
  // playback progress proportionally onto the timeline the user sees.
  const playheadTime = useMemo(() => {
    if (!playableSrc || mediaDuration <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, currentTime / mediaDuration));
    if (previewMode === 'final') return ratio * totalDuration;
    const sceneDuration = script?.scenes[selectedScene]?.duration_hint ?? 0;
    return (sceneOffsets[selectedScene] ?? 0) + ratio * sceneDuration;
  }, [
    playableSrc,
    mediaDuration,
    currentTime,
    previewMode,
    totalDuration,
    script,
    selectedScene,
    sceneOffsets,
  ]);

  const seekToTimelineTime = (seconds: number) => {
    if (!script?.scenes.length) return;
    let elapsed = 0;
    let index = script.scenes.length - 1;
    for (let i = 0; i < script.scenes.length; i++) {
      const duration = script.scenes[i].duration_hint;
      if (seconds < elapsed + duration) {
        index = i;
        break;
      }
      elapsed += duration;
    }
    const video = videoRef.current;
    if (previewMode === 'final' && video && totalDuration > 0) {
      const ratio = Math.min(1, Math.max(0, seconds / totalDuration));
      video.currentTime = ratio * (video.duration || totalDuration);
      setSelectedScene(index);
      return;
    }
    setSelectedScene(index);
  };

  useEffect(() => {
    void (async () => {
      const data = await window.studio.getModels();
      setVideoFamilies(data.videoFamilies);
      setImageFamilies(data.imageFamilies);
      setVideoModels(data.videoModels);
      setImageModels(data.imageModels);
    })();
  }, []);

  useEffect(
    () =>
      window.studio.onJobProgress((p) => {
        setProgress(p);
        setActivity((prev) => {
          if (!prev || prev.status !== 'running' || !prev.showJobControls) return prev;
          const msg = (p.message || '').trim();
          const shouldLog = Boolean(msg) && msg !== lastActivityLogRef.current;
          if (shouldLog) lastActivityLogRef.current = msg;
          return {
            ...prev,
            // Pipeline đã map % đúng (audio-only: theo chunk 0–100; full job: band TTS/media).
            percent: Math.min(100, Math.max(prev.percent, p.percent ?? prev.percent)),
            jobProgress: p,
            logs: shouldLog
              ? [...prev.logs, createLogLine(msg, p.phase === 'error' ? 'error' : 'info')].slice(-80)
              : prev.logs,
          };
        });
      }),
    []
  );

  /** Quay lại project đang gen nền → gắn lại progress (không mất UI). */
  const attachRunningJob = async (id: string) => {
    const job = await window.studio.getActiveJob();
    if (!job.active || job.projectId !== id) return false;
    setBusy(true);
    if (job.progress) setProgress(job.progress);
    startActivity({
      stepId: 'resume',
      title: 'Tiếp tục job đang chạy',
      blurb: 'Gắn lại tiến độ từ main process.',
      showJobControls: true,
      firstLog: job.progress?.message || 'Đang khôi phục tiến độ…',
    });
    if (job.progress) {
      setActivity((prev) =>
        prev
          ? {
              ...prev,
              percent: job.progress?.percent ?? prev.percent,
              jobProgress: job.progress,
            }
          : prev
      );
    }
    return true;
  };

  useEffect(() => {
    return window.studio.onJobFinished((event) => {
      const id = activeProjectId || projectId;
      if (!id || event.projectId !== id) return;
      void (async () => {
        try {
          const refreshed = await window.studio.getProject(id);
          setSceneMedia(refreshed.sceneMedia);
          setHasNarration(Boolean(refreshed.audioPath));
          setNarrationPath(refreshed.audioPath);
          if (refreshed.draft?.script) setScript(refreshed.draft.script);
          if (event.ok && event.result) {
            setResult(event.result);
            setPreviewMode('final');
            setPreviewKey((v) => v + 1);
            setToast({ type: 'ok', text: 'Generate hoàn tất (chạy nền).' });
            finishActivity(true, 'Generate hoàn tất.');
          } else if (!event.ok) {
            setError(event.error || 'Job thất bại.');
            setToast({ type: 'error', text: event.error || 'Job thất bại.' });
            finishActivity(false, event.error || 'Job thất bại.');
          }
        } finally {
          setBusy(false);
          setProgress(
            event.ok
              ? { phase: 'done', message: 'Hoàn tất!', percent: 100 }
              : {
                  phase: 'error',
                  message: event.error || 'Lỗi',
                  percent: 100,
                  error: event.error,
                }
          );
        }
      })();
    });
  }, [activeProjectId, projectId]);

  useEffect(() => {
    return () => {
      if (remuxTimer.current) clearTimeout(remuxTimer.current);
      narrationAudioRef.current?.pause();
      narrationAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      void window.studio.getSettings().then((s) => {
        setVoice(resolveProjectVoice(null, s));
        setOpenaiChatModel(resolveProjectChatModel(null, s.openaiModel));
      });
      return;
    }
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const detail = await window.studio.getProject(projectId);
        setSceneMedia(detail.sceneMedia);
        setHasNarration(Boolean(detail.audioPath));
        setNarrationPath(detail.audioPath);
        setProjectDir(detail.projectDir);
        setNarrationPlaying(false);
        if (narrationAudioRef.current) {
          narrationAudioRef.current.pause();
          narrationAudioRef.current = null;
        }
        setActiveProjectId(detail.meta.id);
        setProjectName(detail.meta.name);
        const draft = detail.draft;
        if (draft) {
          setBrief(draft.brief);
          setLanguage(draft.language);
          setTargetDurationMin(minutesFromSeconds(draft.targetDurationSec));
          setMediaKind(draft.mediaKind ?? 'video');
          {
            const density = resolveSceneDensity(draft.sceneDensity);
            setSceneDensity(density);
            const planned = planScenesFromDuration(draft.targetDurationSec || 60, {
              targetSceneCount: draft.targetMediaCount,
              typicalBeatSec:
                SCENE_DENSITY_OPTIONS.find((d) => d.id === density)?.beatSec ?? undefined,
              mediaKind: draft.mediaKind ?? 'video',
            });
            setTargetMediaCount(
              draft.targetMediaCount && draft.targetMediaCount > 0
                ? clampTargetSceneCount(draft.targetDurationSec || 60, draft.targetMediaCount)
                : planned.sceneCountHint
            );
          }
          setFamily(draft.family);
          setModelId(resolveModelId(draft.model));
          setAspectRatio(draft.aspectRatio);
          setOutputFormat(inferOutputFormatId(draft.aspectRatio, draft.outputFormat));
          setResolution(draft.resolution);
          setMode(draft.mode ?? '');
          setStylePrompt(draft.stylePrompt?.trim() ? draft.stylePrompt : DEFAULT_STYLE_PROMPT);
          setScript(draft.script);
          setVoice(resolveProjectVoice(draft));
          setOpenaiChatModel(
            resolveProjectChatModel(draft.openaiChatModel, undefined)
          );
          const kind = resolveProjectKind(draft.projectKind ?? detail.meta.projectKind);
          setProjectKind(kind);
          setLyricText(draft.lyricText || '');
          setMusicRelativePath(draft.musicRelativePath);
          setCharacterRelativePaths(draft.characterRelativePaths || []);
          setMusicStoryNotes(draft.musicStoryNotes || '');
          setMusicCastLock(draft.musicCastLock || '');
          if (kind === 'music-animation' && detail.audioPath) {
            // duration sẽ cập nhật khi import; ước từ draft nếu có
            setMusicDurationSec(draft.targetDurationSec || null);
          }
          if (kind === 'music-animation') {
            if (!detail.audioPath || !(draft.lyricText || '').trim()) setActiveStep('script');
            else if (!draft.script?.scenes.length) setActiveStep('voice');
            else if (!detail.sceneMedia.every((a) => a.exists)) setActiveStep('media');
            else setActiveStep('merge');
          } else if (kind === 'audio-only') {
            if (!draft.script?.scenes.length) setActiveStep('script');
            else setActiveStep('voice');
          } else if (draft.script) {
            if (!detail.audioPath) setActiveStep('voice');
            else if (!detail.sceneMedia.every((a) => a.exists)) setActiveStep('media');
            else setActiveStep('merge');
          }
        } else {
          const s = await window.studio.getSettings();
          setVoice(resolveProjectVoice(null, s));
          setOpenaiChatModel(resolveProjectChatModel(null, s.openaiModel));
        }
        if (detail.videoPath) {
          setResult({
            projectId: detail.meta.id,
            projectName: detail.meta.name,
            projectDir: detail.projectDir,
            videoPath: detail.videoPath,
            srtPath: detail.srtPath ?? detail.videoPath.replace(/\.mp4$/i, '.srt'),
            audioPath: detail.audioPath ?? '',
            title: draft?.script?.title ?? detail.meta.name,
          });
        } else {
          setResult(null);
        }
        const stillRunning = await attachRunningJob(detail.meta.id);
        if (!stillRunning) {
          // Badge "Đang gen" cũ nhưng job đã chết → UI không kẹt Generate tắt.
          setBusy(false);
          if (detail.meta.status === 'generating') {
            setToast({
              type: 'error',
              text: 'Job trước đã dừng. Bấm Generate nếu cần chạy lại.',
            });
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    })();
  }, [projectId]);

  useEffect(() => {
    if (!script?.scenes.length) setSelectedScene(0);
    else if (selectedScene >= script.scenes.length) setSelectedScene(script.scenes.length - 1);
  }, [script, selectedScene]);

  // Migrate deprecated Snapgen image models (e.g. imagen-4 → nano-banana-2).
  useEffect(() => {
    const resolved = resolveModelId(modelId);
    if (resolved !== modelId) {
      setModelId(resolved);
      const selected = models.find((item) => item.id === resolved);
      if (selected) {
        setFamily(selected.family);
        setAspectRatio(selected.defaultAspectRatio);
        setOutputFormat(inferOutputFormatId(selected.defaultAspectRatio));
        setResolution(selected.defaultResolution);
      }
      return;
    }
    if (models.length && !models.some((item) => item.id === modelId)) {
      const fallback =
        models.find((item) => item.family === family) || models[0];
      if (fallback) {
        setModelId(fallback.id);
        setFamily(fallback.family);
        setAspectRatio(fallback.defaultAspectRatio);
        setOutputFormat(inferOutputFormatId(fallback.defaultAspectRatio));
        setResolution(fallback.defaultResolution);
      }
    }
  }, [modelId, models, family]);

  const applyKindDefaults = (kind: MediaKind) => {
    setMediaKind(kind);
    const preferredId = defaultModelIdForKind(kind);
    const preferredFamily = defaultFamilyForKind(kind);
    const pool = kind === 'image' ? imageModels : videoModels;
    const preferred =
      pool.find((item) => item.id === preferredId) ||
      pool.find((item) => item.family === preferredFamily) ||
      pool[0] ||
      getModelById(preferredId);
    if (preferred) {
      setFamily(preferred.family);
      setModelId(preferred.id);
      setAspectRatio(preferred.defaultAspectRatio);
      setOutputFormat(inferOutputFormatId(preferred.defaultAspectRatio));
      setResolution(preferred.defaultResolution);
      setMode(preferred.extraFields?.mode?.[0] ?? '');
      return;
    }
    setFamily(preferredFamily);
    setModelId(preferredId);
    setAspectRatio('16:9');
    setOutputFormat('youtube');
    setResolution(kind === 'image' ? '1K' : '720p');
    setMode('');
  };

  const onFamilyChange = (nextFamily: VideoFamily | ImageFamily) => {
    setFamily(nextFamily);
    const first = models.find((item) => item.family === nextFamily);
    if (!first) return;
    setModelId(first.id);
    setAspectRatio(first.defaultAspectRatio);
    setOutputFormat(inferOutputFormatId(first.defaultAspectRatio));
    setResolution(first.defaultResolution);
    setMode(first.extraFields?.mode?.[0] ?? '');
  };

  const applyAspectRatio = (next: string, formatHint?: string | null) => {
    setAspectRatio(next);
    setOutputFormat(inferOutputFormatId(next, formatHint ?? outputFormat));
  };

  const onModelChange = (id: string) => {
    setModelId(id);
    const selected = models.find((item) => item.id === id);
    if (!selected) return;
    applyAspectRatio(selected.defaultAspectRatio);
    setResolution(selected.defaultResolution);
    setMode(selected.extraFields?.mode?.[0] ?? '');
  };

  const draftPayload = (
    nextScript: ScriptDraft | null = script,
    voiceOverride?: ProjectVoiceSettings
  ) => ({
    projectKind,
    brief,
    language,
    sceneCount: nextScript?.scenes.length ?? scenePlan.sceneCountHint,
    targetMediaCount: clampTargetSceneCount(
      isMusicAnimation && musicDurationSec && musicDurationSec > 0
        ? musicDurationSec
        : scenePlan.targetDurationSec,
      targetMediaCount
    ),
    sceneDensity,
    targetDurationSec:
      isMusicAnimation && musicDurationSec && musicDurationSec > 0
        ? Math.round(musicDurationSec)
        : scenePlan.targetDurationSec,
    family: family as VideoFamily | ImageFamily,
    model: modelId,
    aspectRatio,
    outputFormat,
    resolution,
    mode: mode || undefined,
    script: nextScript,
    mediaKind,
    stylePrompt,
    openaiChatModel,
    lyricText,
    musicRelativePath,
    characterRelativePaths,
    musicStoryNotes,
    ...(voiceOverride ?? voice),
  });

  /** Lưu giọng (và draft) theo đúng projectId — không phụ thuộc Settings toàn app. */
  const persistProjectVoice = async (nextVoice: ProjectVoiceSettings): Promise<string | null> => {
    const name = projectName.trim() || 'Untitled project';
    const payload = draftPayload(script, nextVoice);

    if (activeProjectId) {
      await window.studio.saveProjectDraft(activeProjectId, payload, { name });
      return activeProjectId;
    }

    // Chưa có dự án: tạo ngay để gắn giọng, tránh mất khi thoát Studio.
    const meta = await window.studio.createProject({
      name,
      projectKind,
      brief,
      language,
      sceneCount: scenePlan.sceneCountHint,
      targetDurationSec: scenePlan.targetDurationSec,
      family: family as VideoFamily | ImageFamily,
      model: modelId,
      aspectRatio,
      resolution,
      mode: mode || undefined,
      mediaKind,
      stylePrompt,
      openaiChatModel,
      ...nextVoice,
    });
    setActiveProjectId(meta.id);
    onProjectReady(meta.id);
    const created = await window.studio.getProject(meta.id);
    setProjectDir(created.projectDir);
    return meta.id;
  };

  const persistProjectChatModel = async (nextModel: string): Promise<void> => {
    const name = projectName.trim() || 'Untitled project';
    if (activeProjectId) {
      await window.studio.saveProjectDraft(
        activeProjectId,
        { ...draftPayload(script), openaiChatModel: nextModel },
        { name }
      );
      return;
    }
    const meta = await window.studio.createProject({
      name,
      projectKind,
      brief,
      language,
      sceneCount: scenePlan.sceneCountHint,
      targetDurationSec: scenePlan.targetDurationSec,
      family: family as VideoFamily | ImageFamily,
      model: modelId,
      aspectRatio,
      resolution,
      mode: mode || undefined,
      mediaKind,
      stylePrompt,
      openaiChatModel: nextModel,
      ...voice,
    });
    setActiveProjectId(meta.id);
    onProjectReady(meta.id);
    void window.studio.getProject(meta.id).then((created) => {
      setProjectDir(created.projectDir);
    });
  };

  const onVoiceChange = (next: ProjectVoiceSettings) => {
    setVoice(next);
    void (async () => {
      try {
        await persistProjectVoice(next);
      } catch (err) {
        setToast({
          type: 'error',
          text: err instanceof Error ? err.message : 'Không lưu được giọng dự án.',
        });
      }
    })();
  };

  const ensureProject = async (voiceOverride?: ProjectVoiceSettings): Promise<string> => {
    const name = projectName.trim() || 'Untitled project';
    const v = voiceOverride ?? voice;
    if (activeProjectId) {
      await window.studio.renameProject(activeProjectId, name);
      await window.studio.saveProjectDraft(activeProjectId, draftPayload(script, v), { name });
      return activeProjectId;
    }
    const meta = await window.studio.createProject({
      name,
      projectKind,
      brief,
      language,
      sceneCount: scenePlan.sceneCountHint,
      targetDurationSec: scenePlan.targetDurationSec,
      family: family as VideoFamily | ImageFamily,
      model: modelId,
      aspectRatio,
      resolution,
      mode: mode || undefined,
      mediaKind,
      stylePrompt,
      openaiChatModel,
      ...v,
    });
    setActiveProjectId(meta.id);
    onProjectReady(meta.id);
    const created = await window.studio.getProject(meta.id);
    setProjectDir(created.projectDir);
    return meta.id;
  };

  const persistScript = async (nextScript: ScriptDraft) => {
    setScript(nextScript);
    if (activeProjectId) {
      await window.studio.saveProjectDraft(activeProjectId, draftPayload(nextScript), {
        name: projectName.trim() || 'Untitled project',
      });
    }
  };

  const updateScene = (patch: Partial<ScriptDraft['scenes'][number]>) => {
    if (!script || !currentScene) return;
    const scenes = script.scenes.map((scene, index) =>
      index === selectedScene ? { ...scene, ...patch } : scene
    );
    const next = {
      ...script,
      scenes,
      narration: scenes.map((scene) => scene.narration_segment).join(' '),
    };
    void persistScript(next);
    if (patch.duration_hint != null && result) {
      scheduleRemux(next);
    }
  };

  const applyTimeline = async (nextScript: ScriptDraft) => {
    if (!activeProjectId) return;
    // Remux only needs the scene clips plus narration on disk — a previous
    // final.mp4 is not required.
    if (!hasSceneMedia) {
      setToast({
        type: 'error',
        text: 'Chưa có clip nào để ghép. Hãy Generate trước.',
      });
      return;
    }
    if (remuxTimer.current) {
      clearTimeout(remuxTimer.current);
      remuxTimer.current = null;
    }
    // Two ffmpeg runs would write the same final.mp4 and work/ files at once,
    // so queue the newest script instead of starting a second pass.
    if (remuxRunning.current) {
      remuxPending.current = nextScript;
      return;
    }
    remuxRunning.current = true;
    setBusy(true);
    setTimelineDirty(true);
    setError(null);
    setProgress({
      phase: 'merge',
      message: 'Đang ghép lại video bằng FFmpeg (không gọi API)...',
      percent: 80,
    });
    startActivity({
      stepId: 'remux',
      title: 'Ghép lại timeline',
      blurb: 'FFmpeg local — không gọi TTS / Snapgen.',
      showJobControls: true,
      firstLog: 'Bắt đầu remux FFmpeg…',
    });
    setActivityPercent(80);
    try {
      pushActivityLog('Lưu draft timeline…');
      await window.studio.saveProjectDraft(activeProjectId, draftPayload(nextScript), {
        name: projectName.trim() || 'Untitled project',
      });
      pushActivityLog('Đang ghép final.mp4…');
      const remuxed = await window.studio.remuxProject(activeProjectId);
      setResult(remuxed);
      const refreshed = await window.studio.getProject(activeProjectId);
      setSceneMedia(refreshed.sceneMedia);
      if (refreshed.draft?.script) {
        setScript(refreshed.draft.script);
        const totalSec =
          refreshed.draft.targetDurationSec ||
          refreshed.draft.script.scenes.reduce((sum, scene) => sum + scene.duration_hint, 0);
        if (totalSec > 0) {
          setTargetDurationMin(minutesFromSeconds(totalSec));
        }
      }
      setPreviewMode('final');
      setPreviewKey((value) => value + 1);
      setTimelineDirty(false);
      setToast({ type: 'ok', text: 'Đã ghép lại video theo timeline (FFmpeg local).' });
      finishActivity(true, 'Remux xong.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setToast({ type: 'error', text: message });
      finishActivity(false, message);
    } finally {
      remuxRunning.current = false;
      setBusy(false);
      setProgress(null);
      const queued = remuxPending.current;
      if (queued) {
        remuxPending.current = null;
        void applyTimeline(queued);
      }
    }
  };

  const scheduleRemux = (nextScript: ScriptDraft) => {
    if (!activeProjectId) return;
    setTimelineDirty(true);
    if (!hasSceneMedia) return;
    if (remuxTimer.current) clearTimeout(remuxTimer.current);
    remuxTimer.current = setTimeout(() => {
      void applyTimeline(nextScript);
    }, 450);
  };

  const reorderScenes = (from: number, to: number) => {
    if (!script || from === to) return;
    const scenes = [...script.scenes];
    const [moved] = scenes.splice(from, 1);
    scenes.splice(to, 0, moved);
    const next = {
      ...script,
      scenes,
      narration: scenes.map((scene) => scene.narration_segment).join(' '),
    };
    setSelectedScene(to);
    setScript(next);
    scheduleRemux(next);
  };

  /** Live preview while dragging the clip edge — no remux yet. */
  const changeSceneDuration = (index: number, duration: number) => {
    if (!script) return;
    const scenes = script.scenes.map((scene, i) =>
      i === index ? { ...scene, duration_hint: Math.max(1, duration) } : scene
    );
    setScript({ ...script, scenes });
    setTimelineDirty(true);
  };

  /** Fired when the user releases the resize handle — persist + remux. */
  const commitSceneDuration = (index: number, duration: number) => {
    if (!script) return;
    const scenes = script.scenes.map((scene, i) =>
      i === index ? { ...scene, duration_hint: Math.max(1, duration) } : scene
    );
    const next = { ...script, scenes };
    setScript(next);
    scheduleRemux(next);
  };

  const exportVideo = async () => {
    const hasScenes = buildExportableScenes(script, sceneMedia).length > 0;
    if (!result && !hasScenes) {
      setToast({ type: 'error', text: 'Chưa có media để lưu. Hãy Generate trước.' });
      return;
    }
    setExportOpen(true);
  };

  const confirmExport = async (payload: { mode: ExportMode; selectedSceneIds: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      const baseName = projectName.trim() || result?.title || 'snapgen';
      if (payload.mode === 'final') {
        if (!result?.videoPath) {
          throw new Error('Chưa có bản Final để lưu.');
        }
        const saved = await window.studio.exportMedia({
          mode: 'final',
          final: {
            sourcePath: result.videoPath,
            suggestedName: baseName,
          },
        });
        if (saved) {
          setToast({ type: 'ok', text: `Đã lưu Final: ${saved.path}` });
          setExportOpen(false);
        }
        return;
      }

      const exportable = buildExportableScenes(script, sceneMedia);
      const chosen = exportable.filter((item) => payload.selectedSceneIds.includes(item.sceneId));
      if (!chosen.length) {
        throw new Error('Chọn ít nhất một phân cảnh.');
      }

      const saved = await window.studio.exportMedia({
        mode: 'scenes',
        scenes: chosen.map((item) => {
          const ext = item.kind === 'image' ? 'png' : 'mp4';
          const index = String(item.index + 1).padStart(2, '0');
          return {
            sourcePath: item.path,
            fileName: `${baseName}-scene-${index}.${ext}`,
          };
        }),
      });
      if (saved) {
        setToast({
          type: 'ok',
          text: `Đã lưu ${saved.files?.length ?? chosen.length} phân cảnh vào: ${saved.path}`,
        });
        setExportOpen(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setToast({ type: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const createScript = async () => {
    if (!brief.trim()) {
      setError('Nhập brief / chủ đề trước.');
      return;
    }
    setBusy(true);
    setError(null);
    startActivity({
      stepId: 'script',
      title: 'Bước — Tạo kịch bản',
      blurb: 'ChatGPT đang viết narration + chia scene theo thời lượng mục tiêu.',
      firstLog: 'Bắt đầu tạo kịch bản…',
    });
    const tick = window.setInterval(() => {
      setActivity((prev) => {
        if (!prev || prev.status !== 'running' || prev.stepId !== 'script') return prev;
        return { ...prev, percent: Math.min(88, prev.percent + 3) };
      });
    }, 900);
    try {
      pushActivityLog('Đang chuẩn bị / lưu dự án…');
      setActivityPercent(8);
      const id = await ensureProject();
      pushActivityLog(`Dự án sẵn sàng · model ${openaiChatModel}`);
      setActivityPercent(18);
      const mediaTarget = clampTargetSceneCount(
        scenePlan.targetDurationSec,
        scenePlan.sceneCountHint
      );
      pushActivityLog(
        `Gọi ChatGPT viết kịch bản (~${formatDurationLabel(scenePlan.targetDurationSec)}, ~${mediaTarget} ${mediaKind === 'image' ? 'ảnh' : 'video'}, ${language})…`
      );
      const draft = await window.studio.generateScript({
        brief: brief.trim(),
        language,
        targetDurationSec: scenePlan.targetDurationSec,
        sceneCount: mediaTarget,
        family: family as VideoFamily | ImageFamily,
        model: modelId,
        aspectRatio,
        resolution,
        maxShotSec,
        mediaKind,
        stylePrompt: stylePrompt.trim() || undefined,
        openaiChatModel,
      });
      setActivityPercent(82);
      pushActivityLog(
        `Nhận ${draft.scenes.length} scene (mục tiêu ~${mediaTarget}) — đang lưu draft…`
      );
      setScript(draft);
      setSelectedScene(0);
      await window.studio.saveProjectDraft(id, draftPayload(draft), {
        name: projectName.trim() || 'Untitled project',
      });
      const spoken = estimateScriptSpokenSeconds(draft.scenes);
      const chapterCount = new Set(
        draft.scenes.map((s) => (s.chapter || '').trim()).filter(Boolean)
      ).size;
      const summary = `Script sẵn sàng: ${chapterCount ? `${chapterCount} chapter · ` : ''}${draft.scenes.length} scene · lời ~${formatDurationLabel(spoken)} (mục tiêu ${formatDurationLabel(scenePlan.targetDurationSec)}).`;
      setToast({ type: 'ok', text: summary });
      pushActivityLog(summary, 'ok');
      finishActivity(true, 'Tạo kịch bản xong.');
      setActiveStep('voice');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      finishActivity(false, message);
    } finally {
      window.clearInterval(tick);
      setBusy(false);
    }
  };

  /**
   * mode cho bước media:
   *  create   → tự hỏi phạm vi nếu đã có media (bù cảnh thiếu / ghi đè hết)
   *  missing  → chỉ gen cảnh còn thiếu, không hỏi
   *  recreate → ghi đè toàn bộ, không hỏi
   */
  const runStepAction = async (
    step: WorkflowStep,
    mode: 'create' | 'recreate' | 'missing' = 'create'
  ) => {
    if (step === 'script') {
      await createScript();
      return;
    }
    if (!script) {
      setActiveStep('script');
      setError('Hãy tạo kịch bản trước.');
      return;
    }
    if (step === 'voice') {
      await confirmGenerate({
        regenerateSceneIds: [],
        refreshNarration: true,
        step: 'audio',
        clearNarrationFirst: mode === 'recreate' || hasNarration,
      });
      return;
    }
    if (isAudioOnly && (step === 'media' || step === 'merge')) {
      setActiveStep('voice');
      setError('Dự án chỉ audio — không tạo ảnh/video hay ghép Final.');
      return;
    }
    if (step === 'media') {
      const allIds = script.scenes.map((scene) => scene.id);
      const missing = script.scenes
        .filter((scene, index) => {
          const asset =
            sceneMedia.find((item) => item.sceneId === scene.id) ?? sceneMedia[index];
          return !asset?.exists;
        })
        .map((scene) => scene.id);
      const existingCount = allIds.length - missing.length;
      const mediaWord = mediaKind === 'image' ? 'ảnh' : 'video';

      let ids: string[];
      let asked = false;

      if (mode === 'recreate') {
        ids = allIds;
      } else if (mode === 'missing') {
        ids = missing.length ? missing : allIds;
      } else if (existingCount > 0) {
        // Đã có media → phải hỏi rõ: bù cảnh thiếu hay ghi đè hết.
        // window.confirm chỉ có OK/Cancel nên dùng hộp thoại nhiều nút của Electron.
        const canFillMissing = missing.length > 0;
        const buttons = canFillMissing
          ? [
              `Chỉ tạo ${missing.length} cảnh còn thiếu`,
              `Ghi đè toàn bộ ${allIds.length} cảnh`,
              'Hủy',
            ]
          : [`Ghi đè toàn bộ ${allIds.length} cảnh`, 'Hủy'];
        const choice = await window.studio.showChoiceDialog({
          title: `Tạo ${mediaWord} scene`,
          message: canFillMissing
            ? `Đã có ${existingCount}/${allIds.length} cảnh, còn thiếu ${missing.length}.`
            : `Cả ${allIds.length} cảnh đều đã có ${mediaWord}.`,
          detail: canFillMissing
            ? `«Chỉ tạo cảnh còn thiếu» giữ nguyên ${existingCount} cảnh đã xong — không tốn credit gen lại.`
            : `Ghi đè sẽ gen lại toàn bộ ${allIds.length} cảnh và tốn credit như lần đầu.`,
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
        });
        if (choice === buttons.length - 1) return;
        ids = canFillMissing && choice === 0 ? missing : allIds;
        asked = true;
      } else {
        ids = allIds;
      }

      await confirmGenerate({
        regenerateSceneIds: ids,
        refreshNarration: false,
        step: 'media',
        // Đã chọn phạm vi ở hộp thoại trên rồi → không hỏi lần hai.
        skipConfirm: asked,
      });
      return;
    }
    // merge
    if (!hasNarration && !narrationPath) {
      setActiveStep('voice');
      setError('Chưa có voiceover — làm bước 2 trước.');
      return;
    }
    if (!allScenesHaveMedia) {
      setActiveStep('media');
      setError('Chưa đủ ảnh/video scene — làm bước 3 trước.');
      return;
    }
    await confirmGenerate({
      regenerateSceneIds: [],
      refreshNarration: false,
      step: 'remux',
    });
  };

  const clearNarrationAudio = async () => {
    try {
      const id = await ensureProject();
      if (typeof window.studio.clearNarrationAudio !== 'function') {
        throw new Error('App chưa reload handler xóa voice — đóng app và chạy lại npm run dev.');
      }
      const result = await window.studio.clearNarrationAudio(id);
      setHasNarration(false);
      setNarrationPath(null);
      if (narrationAudioRef.current) {
        narrationAudioRef.current.pause();
        narrationAudioRef.current = null;
      }
      setNarrationPlaying(false);
      setToast({
        type: 'ok',
        text:
          result.removed.length > 0
            ? 'Đã xóa voice. Bấm «Tạo voice» để tạo lại.'
            : 'Không còn file voice để xóa.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setToast({
        type: 'error',
        text: message.includes('No handler')
          ? 'Main chưa có handler xóa voice — đóng cửa sổ app rồi chạy lại npm run dev.'
          : message,
      });
    }
  };

  const confirmGenerate = async (payload: {
    regenerateSceneIds: string[];
    refreshNarration: boolean;
    step?: 'audio' | 'media' | 'remux';
    clearNarrationFirst?: boolean;
    /** true khi người gọi đã hỏi xác nhận rồi — tránh hiện 2 hộp thoại liên tiếp. */
    skipConfirm?: boolean;
  }) => {
    if (!script || generateRunning.current) return;
    const step = payload.step || 'media';

    if (step === 'media' && payload.regenerateSceneIds.length === 0) {
      setToast({
        type: 'error',
        text: 'Chưa chọn scene nào để tạo. Dùng «Chọn scene nâng cao…» hoặc chọn scene thiếu.',
      });
      return;
    }

    // Xác nhận số lượng trước khi gọi Snapgen (ảnh/video).
    if (step === 'media' && !payload.skipConfirm) {
      const ok = window.confirm(
        buildMediaGenerateConfirmMessage({
          mediaKind,
          script,
          sceneMedia,
          regenerateSceneIds: payload.regenerateSceneIds,
          modelId,
          family,
        })
      );
      if (!ok) return;
    }

    generateRunning.current = true;
    setBusy(true);
    setError(null);
    setProgress({ phase: 'idle', message: 'Đang chuẩn bị pipeline...', percent: 0 });
    const stepMeta =
      step === 'audio'
        ? {
            title: 'Bước 1 — Tạo audio',
            blurb: 'TTS voiceover + subtitle. Có thể thu nhỏ popup, theo dõi dock dưới.',
          }
        : step === 'media'
          ? {
              title: `Bước 2 — Tạo ${mediaKind === 'image' ? 'ảnh' : 'video'}`,
              blurb: 'Snapgen render từng scene. Theo dõi log + thanh tiến độ ở dock dưới.',
            }
          : {
              title: 'Bước 3 — Ghép Final',
              blurb: 'FFmpeg ghép clip/ảnh + narration thành final.mp4.',
            };
    startActivity({
      stepId: step,
      title: stepMeta.title,
      blurb: stepMeta.blurb,
      showJobControls: true,
      firstLog: 'Đang chuẩn bị pipeline…',
    });
    try {
      const id = await ensureProject();
      pushActivityLog('Đã lưu draft dự án');
      await window.studio.saveProjectDraft(id, draftPayload(script), {
        name: projectName.trim() || 'Untitled project',
      });
      if (payload.clearNarrationFirst || (payload.step === 'audio' && payload.refreshNarration)) {
        pushActivityLog('Xóa narration cũ trước khi gọi TTS API…', 'warn');
        const cleared = await window.studio.clearNarrationAudio(id);
        setHasNarration(false);
        setNarrationPath(null);
        pushActivityLog(
          cleared.removed.length
            ? `Đã xóa: ${cleared.removed.join(', ')}`
            : 'Không còn file narration cũ.',
          'ok'
        );
      }
      const generated = await window.studio.startGenerate({
        projectId: id,
        projectName: projectName.trim() || 'Untitled project',
        script,
        family: family as VideoFamily | ImageFamily,
        model: modelId,
        aspectRatio,
        resolution,
        mode: mode || undefined,
        brief,
        language,
        mediaKind,
        stylePrompt: stylePrompt.trim() || undefined,
        regenerateSceneIds: payload.regenerateSceneIds,
        refreshNarration: payload.refreshNarration,
        // Bước 1/2 tách riêng — không tự ghép Final (bước 3 hoặc nút Ghép lại).
        skipMerge: payload.step === 'audio' || payload.step === 'media',
        ...voice,
      });
      setResult(generated);
      setHasNarration(Boolean(generated.audioPath));
      setNarrationPath(generated.audioPath || null);
      setProjectDir(generated.projectDir || null);
      const refreshed = await window.studio.getProject(id);
      setSceneMedia(refreshed.sceneMedia);
      if (refreshed.audioPath) setNarrationPath(refreshed.audioPath);
      if (refreshed.projectDir) setProjectDir(refreshed.projectDir);
      if (refreshed.draft?.script) {
        setScript(refreshed.draft.script);
        const totalSec =
          refreshed.draft.targetDurationSec ||
          refreshed.draft.script.scenes.reduce((sum, scene) => sum + scene.duration_hint, 0);
        if (totalSec > 0) {
          setTargetDurationMin(minutesFromSeconds(totalSec));
        }
      }
      setPreviewMode('scene');
      setPreviewKey((value) => value + 1);
      setProgress(null);
      setGenerateOpen(false);
      const mediaLabel = mediaKind === 'image' ? 'ảnh' : 'video';
      const stepToast =
        payload.step === 'audio'
          ? isAudioOnly
            ? 'Đã xong audio. Mở narration.mp3 trong thư mục dự án khi cần.'
            : 'Đã xong bước voice. Sang bước Media để tạo ảnh/video.'
          : payload.step === 'remux'
            ? 'Đã ghép lại Final.'
            : payload.step === 'media'
              ? generated.stopped
                ? `Đã dừng. Xong ${generated.scenesCompleted ?? 0}/${generated.scenesTotal ?? '?'} ${mediaLabel} — tiếp tục bước 2 khi sẵn sàng.`
                : `Đã xong bước 2 (${payload.regenerateSceneIds.length} ${mediaLabel}). Sang bước 3 để ghép Final.`
              : null;
      const okText =
        stepToast ||
        (generated.stopped
          ? `Đã dừng. Xong ${generated.scenesCompleted ?? 0}/${generated.scenesTotal ?? '?'} scene — Generate lại scene còn thiếu khi sẵn sàng.`
          : payload.regenerateSceneIds.length === 0
            ? payload.refreshNarration
              ? 'Đã tạo lại voiceover.'
              : 'Đã ghép lại Final với narration hiện có.'
            : payload.regenerateSceneIds.length === 1
              ? `Đã tạo lại ${mediaLabel} scene.`
              : `Đã generate ${payload.regenerateSceneIds.length} scene.`);
      setToast({ type: 'ok', text: okText });
      finishActivity(true, okText);
      if (payload.step === 'audio') {
        if (!isAudioOnly) setActiveStep('media');
      } else if (payload.step === 'media' && !generated.stopped) setActiveStep('merge');
      else if (payload.step === 'remux') setActiveStep('merge');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setProgress({ phase: 'error', message: 'Generate thất bại', error: message });
      setToast({ type: 'error', text: message });
      finishActivity(false, message);
    } finally {
      generateRunning.current = false;
      setBusy(false);
    }
  };

  const regenerateOneScene = (sceneId: string, sceneIndex: number) => {
    if (!script || busy || generateRunning.current) return;
    setSelectedScene(sceneIndex);
    setPreviewMode('scene');
    setActiveStep('media');
    void confirmGenerate({
      regenerateSceneIds: [sceneId],
      // Regen 1 scene: giữ VO; ghép Final lại nếu đã đủ clip (không skipMerge).
      refreshNarration: false,
      step: 'media',
    });
  };

  const importNarrationFromFile = async () => {
    if (!script || busy || generateRunning.current) return;
    setBusy(true);
    setError(null);
    try {
      const id = await ensureProject();
      await window.studio.saveProjectDraft(id, draftPayload(script), {
        name: projectName.trim() || 'Untitled project',
      });
      const imported = await window.studio.importNarrationAudio(id);
      if (!imported) {
        setBusy(false);
        return;
      }
      setScript(imported.script);
      setHasNarration(true);
      setNarrationPath(imported.audioPath);
      const refreshed = await window.studio.getProject(id);
      setSceneMedia(refreshed.sceneMedia);
      if (refreshed.audioPath) setNarrationPath(refreshed.audioPath);
      setPreviewKey((value) => value + 1);
      setGenerateOpen(false);
      setToast({
        type: 'ok',
        text: imported.alignedWithWhisper
          ? `Đã import audio (~${Math.round(imported.durationSec)}s) và căn timeline bằng Whisper.`
          : `Đã import audio (~${Math.round(imported.durationSec)}s). Timeline chia theo tỉ lệ chữ (chưa Whisper).`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setToast({ type: 'error', text: message });
    } finally {
      setBusy(false);
    }
  };

  const resolvedNarrationPath = narrationPath || result?.audioPath || null;

  const togglePlayNarration = async () => {
    if (!resolvedNarrationPath) return;
    const url = toFileUrl(resolvedNarrationPath);
    let audio = narrationAudioRef.current;
    if (!audio || audio.dataset.srcPath !== resolvedNarrationPath) {
      audio?.pause();
      audio = new Audio(url);
      audio.dataset.srcPath = resolvedNarrationPath;
      audio.onended = () => setNarrationPlaying(false);
      audio.onpause = () => setNarrationPlaying(false);
      audio.onplay = () => setNarrationPlaying(true);
      narrationAudioRef.current = audio;
    }
    if (narrationPlaying && !audio.paused) {
      audio.pause();
      setNarrationPlaying(false);
      return;
    }
    try {
      await audio.play();
      setNarrationPlaying(true);
    } catch (err) {
      setToast({
        type: 'error',
        text: err instanceof Error ? err.message : 'Không phát được narration.',
      });
    }
  };

  const mediaLabel = mediaKind === 'image' ? 'ảnh' : 'video';
  const musicInputDone = Boolean(
    (hasNarration || resolvedNarrationPath || musicRelativePath) && lyricText.trim()
  );
  const step1Done = isMusicAnimation ? musicInputDone : Boolean(script?.scenes.length);
  const step2Done = isMusicAnimation
    ? Boolean(script?.scenes.length)
    : Boolean(hasNarration || resolvedNarrationPath);
  const step3Done = isAudioOnly ? step2Done : allScenesHaveMedia;
  const step4Done = isAudioOnly
    ? step2Done
    : Boolean(result?.videoPath) && !timelineDirty;
  const stepDone: Record<WorkflowStep, boolean> = {
    script: step1Done,
    voice: step2Done,
    media: step3Done,
    merge: step4Done,
  };

  const persistMusicDraft = async (patch?: {
    lyricText?: string;
    musicRelativePath?: string | undefined;
    characterRelativePaths?: string[];
    musicStoryNotes?: string;
    musicCastLock?: string;
  }) => {
    if (patch?.lyricText !== undefined) setLyricText(patch.lyricText);
    if (patch && 'musicRelativePath' in patch) setMusicRelativePath(patch.musicRelativePath);
    if (patch?.characterRelativePaths) setCharacterRelativePaths(patch.characterRelativePaths);
    if (patch?.musicStoryNotes !== undefined) setMusicStoryNotes(patch.musicStoryNotes);
    if (patch?.musicCastLock !== undefined) setMusicCastLock(patch.musicCastLock);
    const id = await ensureProject();
    await window.studio.saveProjectDraft(id, {
      ...draftPayload(script),
      lyricText: patch?.lyricText ?? lyricText,
      musicRelativePath:
        patch && 'musicRelativePath' in patch ? patch.musicRelativePath : musicRelativePath,
      characterRelativePaths: patch?.characterRelativePaths ?? characterRelativePaths,
      musicStoryNotes: patch?.musicStoryNotes ?? musicStoryNotes,
      musicCastLock: patch?.musicCastLock ?? musicCastLock,
      projectKind: 'music-animation',
    });
    return id;
  };

  const runMusicImportAudio = async () => {
    try {
      const id = await ensureProject();
      const result = await window.studio.importMusicAudio(id);
      if (!result) return;
      setMusicRelativePath(result.musicRelativePath);
      setMusicDurationSec(result.durationSec || null);
      setHasNarration(true);
      setNarrationPath(result.audioPath);
      setProjectKind('music-animation');
      setToast({ type: 'ok', text: `Đã import nhạc (~${Math.round(result.durationSec)}s).` });
    } catch (err) {
      setToast({ type: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const runMusicAnalyze = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await persistMusicDraft({ lyricText });
      startActivity({
        stepId: 'script',
        title: 'Phân tích lyric',
        blurb: 'ChatGPT lập storyboard theo beat nhạc.',
        firstLog: 'Đang gửi lyric + độ dài nhạc…',
      });
      const mediaTarget = clampTargetSceneCount(
        musicDurationSec && musicDurationSec > 0
          ? musicDurationSec
          : scenePlan.targetDurationSec,
        scenePlan.sceneCountHint
      );
      pushActivityLog(`Mục tiêu ~${mediaTarget} shot (~${formatDurationLabel(scenePlan.typicalBeatSec)}/scene)…`);
      const result = await window.studio.generateMusicAnimationScript(id, {
        lyricText,
        language,
        stylePrompt,
        openaiChatModel,
        songTitle: projectName,
        sceneCount: mediaTarget,
      });
      setScript(result.script);
      setMusicStoryNotes(result.notes || '');
      setMusicCastLock(result.castLock || '');
      pushActivityLog(`Đã tạo ${result.script.scenes.length} scene (mục tiêu ~${mediaTarget}).`, 'ok');
      finishActivity(true, 'Phân cảnh xong');
      setActiveStep('voice');
      setToast({
        type: 'ok',
        text: `Đã phân cảnh ${result.script.scenes.length} shot (mục tiêu ~${mediaTarget}).`,
      });
    } catch (err) {
      finishActivity(false, err instanceof Error ? err.message : String(err));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const missingMediaIds =
    script?.scenes
      .filter((scene, index) => {
        const asset =
          sceneMedia.find((item) => item.sceneId === scene.id) ?? sceneMedia[index];
        return !asset?.exists;
      })
      .map((scene) => scene.id) ?? [];

  const renderLeftPanel = () => {
    if (isMusicAnimation) {
      return (
        <MusicAnimationPanel
          step={workflowStepToMusic(activeStep)}
          draft={{
            ...draftPayload(script),
            lyricText,
            musicRelativePath,
            characterRelativePaths,
            musicStoryNotes,
            musicCastLock,
            projectKind: 'music-animation',
          }}
          script={script}
          sceneMedia={sceneMedia}
          sceneStatuses={progress?.sceneStatuses}
          mediaKind={mediaKind}
          families={families}
          models={models}
          family={family}
          modelId={modelId}
          aspectRatio={aspectRatio}
          outputFormat={outputFormat}
          resolution={resolution}
          mode={mode}
          onFamilyChange={onFamilyChange}
          onModelChange={onModelChange}
          onAspectRatioChange={(v) => applyAspectRatio(v, outputFormat)}
          onOutputFormatChange={(v) => setOutputFormat(v as typeof outputFormat)}
          onResolutionChange={setResolution}
          onModeChange={setMode}
          audioPath={resolvedNarrationPath || narrationPath}
          musicDurationSec={musicDurationSec}
          step3Done={step3Done}
          step4Done={step4Done}
          busy={busy}
          sceneDensity={sceneDensity}
          targetMediaCount={targetMediaCount}
          sceneCountHint={scenePlan.sceneCountHint}
          typicalBeatSec={scenePlan.typicalBeatSec}
          sceneCountMin={scenePlan.sceneCountMin}
          sceneCountMax={scenePlan.sceneCountMax}
          onSceneDensityChange={setSceneDensity}
          onTargetMediaCountChange={(n) =>
            setTargetMediaCount(
              clampTargetSceneCount(
                musicDurationSec && musicDurationSec > 0
                  ? musicDurationSec
                  : scenePlan.targetDurationSec,
                n
              )
            )
          }
          onLyricChange={(v) => {
            setLyricText(v);
            void persistMusicDraft({ lyricText: v }).catch(() => undefined);
          }}
          onImportMusic={() => void runMusicImportAudio()}
          onClearMusic={() => {
            void (async () => {
              const id = await ensureProject();
              await window.studio.clearMusicAudio(id);
              setMusicRelativePath(undefined);
              setMusicDurationSec(null);
              setHasNarration(false);
              setNarrationPath(null);
            })();
          }}
          onImportCharacters={() => {
            void (async () => {
              const id = await ensureProject();
              const result = await window.studio.importMusicCharacters(id);
              if (!result) return;
              setCharacterRelativePaths(result.characterRelativePaths);
              setToast({ type: 'ok', text: `Đã thêm ${result.characterRelativePaths.length} ảnh nhân vật.` });
            })();
          }}
          onClearCharacters={() => {
            void (async () => {
              const id = await ensureProject();
              await window.studio.clearMusicCharacters(id);
              setCharacterRelativePaths([]);
            })();
          }}
          // Panel nhạc chỉ có 1 nút → để hộp thoại hỏi phạm vi (thiếu / ghi đè).
          onCastLockChange={(v) => {
            setMusicCastLock(v);
            void persistMusicDraft({ musicCastLock: v }).catch(() => undefined);
          }}
          onAnalyze={() => void runMusicAnalyze()}
          onGenerateMedia={() => void runStepAction('media', 'create')}
          onRegenerateScenes={(ids) => {
            if (!ids.length) return;
            setActiveStep('media');
            void confirmGenerate({
              regenerateSceneIds: ids,
              refreshNarration: false,
              step: 'media',
            });
          }}
          onMerge={() => void runStepAction('merge', step4Done ? 'recreate' : 'create')}
          onGoStep={(s) => setActiveStep(musicStepToWorkflow(s))}
        />
      );
    }

    if (activeStep === 'script') {
      return (
        <>
          <div className="editor-panel-heading">
            <div>
              <span className="panel-kicker">BƯỚC 1</span>
              <h2>{isAudioOnly ? 'Viết kịch bản audio' : 'Tạo script'}</h2>
            </div>
            <span className={`step-status-badge ${step1Done ? 'done' : ''}`}>
              {step1Done ? 'Đã có' : 'Chưa'}
            </span>
          </div>

          {isAudioOnly ? (
            <p className="media-note">
              Dự án chỉ audio: ChatGPT viết lời thoại → bước 2 tạo giọng ElevenLabs. Không gen
              ảnh/video.
            </p>
          ) : (
          <div className="media-switch">
            <button
              type="button"
              className={mediaKind === 'video' ? 'active' : ''}
              onClick={() => applyKindDefaults('video')}
            >
              Video
            </button>
            <button
              type="button"
              className={mediaKind === 'image' ? 'active' : ''}
              onClick={() => applyKindDefaults('image')}
            >
              Image
            </button>
          </div>
          )}

          <div className="field compact-field">
            <label htmlFor="brief">Mô tả video</label>
            <textarea
              id="brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="Colors for kids: red apple, blue ball, yellow sun..."
            />
          </div>
          <div className="field compact-field">
            <label htmlFor="style">Visual style</label>
            <textarea
              id="style"
              className="small-textarea"
              value={stylePrompt}
              onChange={(event) => setStylePrompt(event.target.value)}
              placeholder="Simple Pingpong-style kids learning cartoon..."
            />
          </div>
          <div className="field compact-field">
            <label htmlFor="language">Language (script / TTS)</label>
            <input
              id="language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder="English"
            />
            <small className="field-hint">
              Script & voiceover language. Visuals stay English, no on-screen text.
            </small>
          </div>
          <div className="field compact-field duration-field">
            <div className="duration-field-head">
              <label htmlFor="target-duration">Thời lượng</label>
              <span className="duration-field-live">
                {formatDurationLabel(scenePlan.targetDurationSec)} · ~{scenePlan.sceneCountHint}{' '}
                {mediaLabel}
              </span>
            </div>
            <div className="duration-presets" role="group" aria-label="Preset thời lượng">
              {DURATION_PRESETS_MIN.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className={`chip-btn ${
                    Math.abs(targetDurationMin - minutes) < 0.001 && durationInput !== ''
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => setTargetDurationMin(minutes)}
                >
                  {minutes < 1 ? '30s' : `${minutes}p`}
                </button>
              ))}
            </div>
            <div className="duration-custom">
              <div className="duration-input-wrap">
                <input
                  id="target-duration"
                  type="text"
                  inputMode="decimal"
                  value={durationInput}
                  onChange={(event) => onDurationInputChange(event.target.value)}
                  onBlur={onDurationInputBlur}
                  placeholder="1"
                />
                <span className="duration-unit">phút</span>
              </div>
            </div>
          </div>

          <div className="field compact-field duration-field scene-density-field">
            <div className="duration-field-head">
              <label>
                {isAudioOnly ? 'Cách chia đoạn lời' : `Số ${mediaLabel} / cách chia scene`}
              </label>
              <span className="duration-field-live">
                ~{scenePlan.sceneCountHint} {isAudioOnly ? 'đoạn' : mediaLabel} · ~
                {formatDurationLabel(scenePlan.typicalBeatSec)}/đoạn
              </span>
            </div>
            <div className="duration-presets" role="group" aria-label="Mật độ scene">
              {SCENE_DENSITY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`chip-btn ${sceneDensity === opt.id ? 'active' : ''}`}
                  title={opt.hint}
                  onClick={() => setSceneDensity(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="duration-custom scene-count-custom">
              <div className="duration-input-wrap">
                <input
                  id="target-media-count"
                  type="number"
                  min={scenePlan.sceneCountMin}
                  max={scenePlan.sceneCountMax}
                  value={targetMediaCount}
                  onChange={(event) => {
                    setSceneDensity('custom');
                    const n = Number(event.target.value);
                    if (!Number.isFinite(n)) return;
                    setTargetMediaCount(
                      clampTargetSceneCount(scenePlan.targetDurationSec, n)
                    );
                  }}
                />
                <span className="duration-unit">{isAudioOnly ? 'đoạn' : mediaLabel}</span>
              </div>
              <p className="hint scene-density-hint">
                {isAudioOnly
                  ? 'Chia đoạn chỉ để cấu trúc kịch bản — TTS vẫn đọc liền mạch một file audio.'
                  : `10 phút + Tiết kiệm ≈ 20 ${mediaLabel} (thay vì ~100). Ảnh dài sẽ loop khi ghép Final.`}
                {!isAudioOnly &&
                mediaKind === 'video' &&
                scenePlan.typicalBeatSec > maxShotSec * 1.5
                  ? ` Video dài hơn ${maxShotSec}s/scene có thể tốn nhiều shot API — cân nhắc Image nếu chỉ cần slideshow.`
                  : ''}
              </p>
            </div>
          </div>

          {!isAudioOnly ? (
            <ModelPicker
              mediaKind={mediaKind}
              families={families}
              models={models}
              family={family}
              modelId={modelId}
              aspectRatio={aspectRatio}
              outputFormat={outputFormat}
              resolution={resolution}
              mode={mode}
              onFamilyChange={onFamilyChange}
              onModelChange={onModelChange}
              onAspectRatioChange={(v) => applyAspectRatio(v, outputFormat)}
              onOutputFormatChange={setOutputFormat}
              onResolutionChange={setResolution}
              onModeChange={setMode}
            />
          ) : null}

          <div className="field compact-field">
            <label htmlFor="script-chat-model">Model viết kịch bản</label>
            <select
              id="script-chat-model"
              value={openaiChatModel}
              onChange={(event) => {
                const next = event.target.value;
                setOpenaiChatModel(next);
                void (async () => {
                  try {
                    await persistProjectChatModel(next);
                  } catch (err) {
                    setToast({
                      type: 'error',
                      text: err instanceof Error ? err.message : 'Không lưu được model kịch bản.',
                    });
                  }
                })();
              }}
            >
              {OPENAI_CHAT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!OPENAI_CHAT_MODELS.some((m) => m.id === openaiChatModel) && (
                <option value={openaiChatModel}>{openaiChatModel}</option>
              )}
            </select>
          </div>

          <div className="step-actions">
            <button
              type="button"
              className="editor-primary full-width"
              disabled={busy}
              onClick={() => void runStepAction('script', step1Done ? 'recreate' : 'create')}
            >
              <span>✦</span>
              {busy && activity?.stepId === 'script'
                ? 'Đang tạo script…'
                : step1Done
                  ? 'Tạo lại script'
                  : 'Tạo script'}
            </button>
            {step1Done ? (
              <button
                type="button"
                className="editor-secondary full-width"
                disabled={busy}
                onClick={() => setActiveStep('voice')}
              >
                Tiếp bước 2 — Voice →
              </button>
            ) : null}
          </div>

          {script ? (
            <div className="step-scene-summary">
              <div className="editor-panel-heading compact">
                <div>
                  <span className="panel-kicker">SCENES</span>
                  <h3>{script.scenes.length} scene</h3>
                </div>
              </div>
              <div className="scene-list compact">
                {script.scenes.map((scene, index) => (
                  <button
                    key={scene.id}
                    type="button"
                    className={`scene-list-item ${selectedScene === index ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedScene(index);
                      setPreviewMode('scene');
                    }}
                  >
                    <span className="scene-thumb">
                      <span>{String(index + 1).padStart(2, '0')}</span>
                    </span>
                    <span className="scene-list-copy">
                      <strong>
                        Scene {index + 1}
                        {scene.chapter ? ` · ${scene.chapter}` : ''}
                      </strong>
                      <small>{scene.narration_segment || scene.visual_prompt || '…'}</small>
                    </span>
                    <span className="scene-duration">{scene.duration_hint}s</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      );
    }

    if (activeStep === 'voice') {
      return (
        <>
          <div className="editor-panel-heading">
            <div>
              <span className="panel-kicker">BƯỚC 2</span>
              <h2>{isAudioOnly ? 'Tạo audio (ElevenLabs)' : 'Tạo voice'}</h2>
            </div>
            <span className={`step-status-badge ${step2Done ? 'done' : ''}`}>
              {step2Done ? 'Đã có' : 'Chưa'}
            </span>
          </div>
          {!step1Done ? (
            <div className="empty-panel">
              <span>♫</span>
              <strong>Chưa có script</strong>
              <p>Hoàn thành bước 1 trước khi tạo voiceover.</p>
              <button type="button" className="editor-secondary" onClick={() => setActiveStep('script')}>
                ← Về bước 1
              </button>
            </div>
          ) : (
            <>
              <p className="media-note">
                {isAudioOnly
                  ? 'Chọn giọng ElevenLabs (hoặc GenMax) → tạo file narration.mp3. Đây là bước cuối của dự án chỉ audio.'
                  : 'Chọn giọng → tạo voice. Muốn làm lại: xóa voice rồi tạo lại.'}
              </p>
              <ProjectVoicePanel
                value={voice}
                disabled={busy}
                preferElevenLabs={isAudioOnly}
                onChange={onVoiceChange}
              />
              <div className="step-actions">
                {!step2Done ? (
                  <button
                    type="button"
                    className="editor-primary full-width"
                    disabled={busy}
                    onClick={() => void runStepAction('voice', 'create')}
                  >
                    <span>♫</span>
                    {busy && activity?.stepId === 'audio'
                      ? 'Đang tạo audio…'
                      : isAudioOnly
                        ? 'Tạo audio'
                        : 'Tạo voice'}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn danger full-width"
                      disabled={busy}
                      onClick={() => void clearNarrationAudio()}
                    >
                      Xóa audio
                    </button>
                    <button
                      type="button"
                      className="editor-primary full-width"
                      disabled={busy}
                      onClick={() => void runStepAction('voice', 'recreate')}
                    >
                      <span>↻</span>
                      Tạo lại audio
                    </button>
                    {narrationPath || resolvedNarrationPath ? (
                      <button
                        type="button"
                        className="editor-secondary full-width"
                        disabled={busy}
                        onClick={() => {
                          const p = narrationPath || resolvedNarrationPath;
                          if (p) void window.studio.showItemInFolder(p);
                        }}
                      >
                        Hiện file audio trong Finder
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              <div className="external-narration-box">
                <p className="media-note">Hoặc tự TTS ngoài app rồi import.</p>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !script?.scenes.length}
                    onClick={() => {
                      const text = (script?.scenes || [])
                        .map((s) => (s.narration_segment || '').replace(/\s+/g, ' ').trim())
                        .filter(Boolean)
                        .join(' ');
                      if (!text) {
                        setToast({ type: 'error', text: 'Kịch bản chưa có narration.' });
                        return;
                      }
                      void navigator.clipboard.writeText(text).then(
                        () =>
                          setToast({
                            type: 'ok',
                            text: `Đã copy ${text.length.toLocaleString()} ký tự.`,
                          }),
                        () => setToast({ type: 'error', text: 'Không copy được clipboard.' })
                      );
                    }}
                  >
                    Copy narration
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !script?.scenes.length}
                    onClick={() => void importNarrationFromFile()}
                  >
                    Import audio…
                  </button>
                </div>
              </div>
              {resolvedNarrationPath ? (
                <div className="narration-player">
                  <button
                    type="button"
                    className="editor-secondary full-width"
                    onClick={() => void togglePlayNarration()}
                  >
                    <span>{narrationPlaying ? 'Ⅱ' : '▶'}</span>
                    {narrationPlaying ? 'Tạm dừng' : 'Nghe lại narration'}
                  </button>
                  <p className="hint">{fileName(resolvedNarrationPath)}</p>
                </div>
              ) : null}
              {step2Done && !isAudioOnly ? (
                <button
                  type="button"
                  className="editor-secondary full-width"
                  disabled={busy}
                  onClick={() => setActiveStep('media')}
                >
                  Tiếp bước 3 — Media →
                </button>
              ) : null}
            </>
          )}
        </>
      );
    }

    if (activeStep === 'media') {
      const readyCount = sceneMedia.filter((a) => a.exists).length;
      return (
        <>
          <div className="editor-panel-heading">
            <div>
              <span className="panel-kicker">BƯỚC 3</span>
              <h2>Tạo {mediaLabel}</h2>
            </div>
            <span className={`step-status-badge ${step3Done ? 'done' : ''}`}>
              {readyCount}/{script?.scenes.length ?? 0}
            </span>
          </div>
          {!step1Done ? (
            <div className="empty-panel">
              <span>▧</span>
              <strong>Chưa có script</strong>
              <p>Hoàn thành bước 1 trước.</p>
              <button type="button" className="editor-secondary" onClick={() => setActiveStep('script')}>
                ← Về bước 1
              </button>
            </div>
          ) : (
            <>
              <p className="media-note">
                {!step2Done
                  ? 'Nên có voice (bước 2) để khớp thời lượng. Vẫn có thể tạo media theo duration_hint.'
                  : `Trước khi gọi Snapgen, app sẽ hỏi xác nhận số ${mediaLabel}. Dùng «Chọn scene nâng cao…» để gen từng phần / giữ ảnh cũ để loop.`}
              </p>
              <div className="step-actions">
                <button
                  type="button"
                  className="editor-primary full-width"
                  disabled={busy}
                  onClick={() =>
                    void runStepAction(
                      'media',
                      missingMediaIds.length > 0 ? 'missing' : 'recreate'
                    )
                  }
                >
                  <span>▧</span>
                  {busy && activity?.stepId === 'media'
                    ? `Đang tạo ${mediaLabel}…`
                    : missingMediaIds.length > 0
                      ? `Tạo ${missingMediaIds.length} ${mediaLabel} còn thiếu`
                      : `Tạo lại toàn bộ ${mediaLabel}`}
                </button>
                {readyCount > 0 ? (
                  <button
                    type="button"
                    className="editor-secondary full-width"
                    disabled={busy}
                    onClick={() => void runStepAction('media', 'recreate')}
                  >
                    Tạo lại tất cả scene
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn ghost full-width"
                  disabled={busy || !script}
                  onClick={() => setGenerateOpen(true)}
                >
                  Chọn scene nâng cao…
                </button>
              </div>
              {script ? (
                <div className="media-grid">
                  {script.scenes.map((scene, index) => {
                    const asset =
                      sceneMedia.find((item) => item.sceneId === scene.id) ?? sceneMedia[index];
                    const exists = Boolean(asset?.exists);
                    const thumbUrl =
                      exists && asset?.kind === 'image' ? toFileUrl(asset.path) : null;
                    return (
                      <div
                        key={scene.id}
                        className={`media-card ${selectedScene === index ? 'active' : ''}`}
                      >
                        <button
                          type="button"
                          className="media-card-select"
                          onClick={() => {
                            setSelectedScene(index);
                            setPreviewMode('scene');
                          }}
                        >
                          <span className={`media-card-preview ${thumbUrl ? 'has-media' : ''}`}>
                            {thumbUrl ? <img src={thumbUrl} alt="" /> : <span>{exists ? '▶' : '·'}</span>}
                            <small>{String(index + 1).padStart(2, '0')}</small>
                          </span>
                          <span className="media-card-copy">
                            <strong>Scene {index + 1}</strong>
                            <small>
                              {scene.duration_hint}s · {exists ? `đã có ${mediaLabel}` : 'chưa có'}
                            </small>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="media-card-regen"
                          disabled={busy}
                          onClick={() => regenerateOneScene(scene.id, index)}
                        >
                          ↻ Tạo lại
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {step3Done ? (
                <button
                  type="button"
                  className="editor-secondary full-width"
                  disabled={busy}
                  onClick={() => setActiveStep('merge')}
                >
                  Tiếp bước 4 — Ghép →
                </button>
              ) : null}
            </>
          )}
        </>
      );
    }

    // merge
    return (
      <>
        <div className="editor-panel-heading">
          <div>
            <span className="panel-kicker">BƯỚC 4</span>
            <h2>Ghép Final</h2>
          </div>
          <span className={`step-status-badge ${step4Done ? 'done' : ''}`}>
            {step4Done ? 'Sẵn sàng' : 'Chưa'}
          </span>
        </div>
        <p className="media-note">
          Ghép voiceover + {mediaLabel} từng scene thành final.mp4 (FFmpeg, không tốn TTS/Snapgen).
        </p>
        <ul className="merge-checklist">
          <li className={step1Done ? 'ok' : ''}>1. Script {step1Done ? '✓' : '—'}</li>
          <li className={step2Done ? 'ok' : ''}>2. Voice {step2Done ? '✓' : '—'}</li>
          <li className={step3Done ? 'ok' : ''}>
            3. Media {step3Done ? '✓' : `${sceneMedia.filter((a) => a.exists).length}/${script?.scenes.length ?? 0}`}
          </li>
        </ul>
        <div className="step-actions">
          <button
            type="button"
            className="editor-primary full-width"
            disabled={busy || !step2Done || !step3Done}
            onClick={() => void runStepAction('merge', result?.videoPath ? 'recreate' : 'create')}
          >
            <span>▣</span>
            {busy && activity?.stepId === 'remux'
              ? 'Đang ghép…'
              : result?.videoPath
                ? 'Ghép lại Final'
                : 'Ghép Final'}
          </button>
          {canRemux && script ? (
            <button
              type="button"
              className="editor-secondary full-width"
              disabled={busy}
              onClick={() => void applyTimeline(script)}
            >
              {timelineDirty ? 'Ghép lại theo timeline ●' : 'Ghép lại theo timeline'}
            </button>
          ) : null}
          {result?.videoPath ? (
            <button
              type="button"
              className="editor-secondary full-width"
              onClick={() => {
                setPreviewMode('final');
                setPreviewKey((v) => v + 1);
              }}
            >
              Xem Final
            </button>
          ) : null}
        </div>
        {(!step2Done || !step3Done) && (
          <p className="hint">
            {!step2Done ? 'Thiếu bước 2 (voice). ' : ''}
            {!step3Done ? 'Thiếu bước 3 (media).' : ''}
          </p>
        )}
      </>
    );
  };


  return (
    <div className={`editor-page${activity?.dockOpen ? ' has-activity-dock' : ''}`}>
      <header className="editor-commandbar">
        <div className="editor-command-left">
          <button type="button" className="icon-button" onClick={onNeedProject} title="Back to projects">
            ‹
          </button>
          <input
            className="project-title-input"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            aria-label="Project name"
          />
          <span className="save-state">Saved</span>
        </div>
        <div className="editor-history">
          <button type="button" className="icon-button" title="Undo" disabled>
            ↶
          </button>
          <button type="button" className="icon-button" title="Redo" disabled>
            ↷
          </button>
          <span className="history-divider" />
          <button type="button" className="icon-button" title="Keyboard shortcuts">
            ⌨
          </button>
        </div>
        <div className="editor-command-right">
          <button
            type="button"
            className="editor-secondary"
            disabled={!projectDir && !result?.projectDir}
            title={projectDir || result?.projectDir || 'Chưa có thư mục dự án'}
            onClick={() => {
              const dir = projectDir || result?.projectDir;
              if (!dir) return;
              void window.studio.openPath(dir).then((err) => {
                if (err) setToast({ type: 'error', text: err });
              });
            }}
          >
            Mở folder
          </button>
          {canRemux && (
            <button
              type="button"
              className={`editor-secondary remux-button ${timelineDirty ? 'dirty' : ''}`.trim()}
              disabled={busy}
              onClick={() => script && void applyTimeline(script)}
              title="Ghép lại final.mp4 từ các clip hiện có bằng FFmpeg (không tốn API)"
            >
              {busy ? 'Đang ghép...' : timelineDirty ? 'Ghép lại video ●' : 'Ghép lại video'}
            </button>
          )}
          {!isAudioOnly ? (
            <button
              type="button"
              className="editor-secondary"
              disabled={busy || (!result && !hasSceneMedia)}
              onClick={() => void exportVideo()}
            >
              Lưu video...
            </button>
          ) : (
            <button
              type="button"
              className="editor-secondary"
              disabled={busy || !(narrationPath || resolvedNarrationPath)}
              onClick={() => {
                const p = narrationPath || resolvedNarrationPath;
                if (p) void window.studio.showItemInFolder(p);
              }}
            >
              Hiện audio...
            </button>
          )}
          <button
            type="button"
            className="editor-primary"
            disabled={busy}
            onClick={() => void runStepAction(activeStep, stepDone[activeStep] ? 'recreate' : 'create')}
            title={railSteps.find((s) => s.id === activeStep)?.label}
          >
            <span>✦</span>
            {busy
              ? 'Đang chạy…'
              : stepDone[activeStep]
                ? `Tạo lại · ${railSteps.find((s) => s.id === activeStep)?.short}`
                : railSteps.find((s) => s.id === activeStep)?.label}
          </button>
        </div>
      </header>

      <div className="editor-workspace">
        <aside
          className="tool-rail"
          aria-label={isAudioOnly ? 'Các bước tạo audio' : 'Các bước tạo video'}
        >
          {railSteps.map((item) => {
            const done = stepDone[item.id];
            const locked = isMusicAnimation
              ? (item.id === 'voice' && !musicInputDone) ||
                (item.id === 'media' && !script?.scenes.length) ||
                (item.id === 'merge' && (!script?.scenes.length || !step3Done))
              : isAudioOnly
                ? item.id === 'voice' && !step1Done
                : (item.id === 'voice' && !step1Done) ||
                  (item.id === 'media' && !step1Done) ||
                  (item.id === 'merge' && (!step2Done || !step3Done));
            return (
              <button
                type="button"
                key={item.id}
                className={[
                  activeStep === item.id ? 'active' : '',
                  done ? 'done' : '',
                  locked ? 'locked' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setActiveStep(item.id)}
                title={item.label}
              >
                <span className="tool-icon step-num">{done ? '✓' : item.icon}</span>
                <small>{item.short}</small>
              </button>
            );
          })}
        </aside>

        <aside className="asset-panel">{renderLeftPanel()}</aside>

        <main className="viewer-panel">
          <div className="viewer-toolbar">
            <div className="preview-mode-switch">
              <button
                type="button"
                className={previewMode === 'scene' ? 'active' : ''}
                disabled={!currentAsset?.exists}
                onClick={() => setPreviewMode('scene')}
              >
                Scene {selectedScene + 1}
              </button>
              <button
                type="button"
                className={previewMode === 'final' ? 'active' : ''}
                disabled={!result && !hasSceneMedia}
                onClick={() => {
                  setPreviewMode('final');
                  setPreviewKey((value) => value + 1);
                  if (activeProjectId) {
                    void window.studio.getProject(activeProjectId).then((detail) => {
                      if (!detail.videoPath) return;
                      setResult((prev) =>
                        prev
                          ? { ...prev, videoPath: detail.videoPath! }
                          : {
                              projectId: detail.meta.id,
                              projectName: detail.meta.name,
                              projectDir: detail.projectDir,
                              videoPath: detail.videoPath!,
                              srtPath: detail.srtPath ?? detail.videoPath!.replace(/\.mp4$/i, '.srt'),
                              audioPath: detail.audioPath ?? '',
                              title: detail.draft?.script?.title ?? detail.meta.name,
                            }
                      );
                      setPreviewKey((value) => value + 1);
                    });
                  }
                }}
              >
                Final
              </button>
            </div>
            <div>
              <button
                type="button"
                className="viewer-chip"
                title={aspectRatio}
              >
                {formatOutputFormatLabel(outputFormat, aspectRatio)}
              </button>
              <button type="button" className="viewer-chip">Fit</button>
              <button type="button" className="icon-button">•••</button>
            </div>
          </div>
          <div className="viewer-stage">
            <div
              className={`preview-canvas ratio-${canonicalAspectRatio(aspectRatio).replace(':', '-')}`}
            >
              {previewMode === 'scene' && currentAsset?.exists && currentAsset.kind === 'video' ? (
                <video
                  key={`${currentAsset.path}-${selectedScene}-${previewKey}`}
                  className="editor-video"
                  controls
                  src={toFileUrl(currentAsset.path)}
                  {...videoEvents}
                />
              ) : previewMode === 'scene' && currentAsset?.exists ? (
                <img
                  key={`${currentAsset.path}-${selectedScene}-${previewKey}`}
                  className="editor-video editor-image"
                  src={toFileUrl(currentAsset.path)}
                  alt={`Scene ${selectedScene + 1}`}
                />
              ) : previewMode === 'final' && result ? (
                <video
                  key={`${result.videoPath}-${previewKey}`}
                  className="editor-video"
                  controls
                  src={toFileUrl(result.videoPath)}
                  {...videoEvents}
                />
              ) : previewMode === 'final' ? (
                <div className="viewer-empty">
                  <div className="empty-play">▶</div>
                  <strong>Chưa có video Final</strong>
                  <p>Bấm Generate hoặc Ghép lại video để tạo final.mp4.</p>
                </div>
              ) : currentScene ? (
                <div className="scene-preview-placeholder">
                  <span className="preview-index">SCENE {selectedScene + 1}</span>
                  <div className="preview-orb" />
                  <h3>{script?.title}</h3>
                  <p>{currentScene.visual_prompt}</p>
                  <span className="preview-style">{stylePrompt || 'AI visual preview'}</span>
                </div>
              ) : (
                <div className="viewer-empty">
                  <div className="empty-play">▶</div>
                  <strong>Your preview will appear here</strong>
                  <p>Describe an idea and generate a storyboard to begin.</p>
                </div>
              )}
            </div>
          </div>
          <div className="playback-controls">
            <span>{formatTime(playableSrc ? currentTime : 0)}</span>
            <div>
              <button
                type="button"
                className="icon-button"
                title="Scene trước"
                disabled={!canStepScene || selectedScene === 0}
                onClick={() => stepScene(-1)}
              >
                |◀
              </button>
              <button
                type="button"
                className="play-button"
                title={playing ? 'Tạm dừng' : 'Phát'}
                disabled={!playableSrc}
                onClick={togglePlay}
              >
                {playing ? 'Ⅱ' : '▶'}
              </button>
              <button
                type="button"
                className="icon-button"
                title="Scene kế tiếp"
                disabled={!canStepScene || selectedScene >= sceneTotal - 1}
                onClick={() => stepScene(1)}
              >
                ▶|
              </button>
            </div>
            <span>{formatTime(playableSrc && mediaDuration ? mediaDuration : totalDuration)}</span>
          </div>
        </main>

        <aside className="inspector-panel">
          <div className="inspector-tabs">
            <button type="button" className="active">Basic</button>
            <button type="button">AI</button>
          </div>
          {currentScene ? (
            <div className="inspector-content">
              <div className="inspector-section">
                <div className="inspector-title">
                  <strong>Scene {selectedScene + 1}</strong>
                  <span>{currentScene.duration_hint.toFixed(1)}s</span>
                </div>
                <div className="field compact-field">
                  <label>Visual prompt</label>
                  <textarea
                    value={currentScene.visual_prompt}
                    onChange={(event) => updateScene({ visual_prompt: event.target.value })}
                  />
                </div>
                <div className="field compact-field">
                  <label>Narration</label>
                  <textarea
                    className="small-textarea"
                    value={currentScene.narration_segment}
                    onChange={(event) => updateScene({ narration_segment: event.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="editor-secondary full-width scene-regen-action"
                  disabled={busy}
                  onClick={() => regenerateOneScene(currentScene.id, selectedScene)}
                >
                  <span>↻</span>
                  {busy
                    ? 'Đang tạo...'
                    : currentAsset?.exists
                      ? `Tạo lại ${mediaKind === 'image' ? 'ảnh' : 'video'} scene này`
                      : `Tạo ${mediaKind === 'image' ? 'ảnh' : 'video'} scene này`}
                </button>
              </div>
              <div className="inspector-section">
                <div className="inspector-title">
                  <strong>Timing</strong>
                </div>
                <div className="property-row">
                  <label>Duration</label>
                  <div className="property-input">
                    <input
                      type="number"
                      min={1}
                      max={180}
                      step={0.1}
                      value={Number(currentScene.duration_hint.toFixed(1))}
                      onChange={(event) =>
                        updateScene({
                          duration_hint: Math.min(
                            180,
                            Math.max(1, Number(event.target.value) || 1)
                          ),
                        })
                      }
                    />
                    <span>s</span>
                  </div>
                </div>
                <p className="hint">
                  Thời lượng tính theo nội dung lời thoại và tổng video. Sửa Narration rồi
                  tạo lại voiceover để khớp độ dài thực tế.
                </p>
                {selectedModel &&
                  currentScene.duration_hint > Math.max(...selectedModel.durations) && (
                    <p className="hint">
                      Cảnh dài hơn giới hạn model ({Math.max(...selectedModel.durations)}s) →
                      hệ thống auto-extend / chia đoạn trong cảnh này. Scene kế tiếp (Veo/Grok/
                      Seedance/Kling) nối liền mạch qua video-extend ref_history.
                    </p>
                  )}
              </div>
              <div className="inspector-section">
                <div className="inspector-title">
                  <strong>Project style</strong>
                </div>
                <div className="field compact-field">
                  <textarea
                    className="small-textarea"
                    value={stylePrompt}
                    onChange={(event) => setStylePrompt(event.target.value)}
                    placeholder="No style guide"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="inspector-empty">
              <span>◇</span>
              <strong>Nothing selected</strong>
              <p>Select a scene on the timeline to edit its properties.</p>
            </div>
          )}
        </aside>

        <section className="timeline-panel">
          <div className="timeline-toolbar">
            <div className="timeline-tools">
              <button type="button" className="icon-button active" title="Select / kéo thả">
                ↖
              </button>
              <button
                type="button"
                className="icon-button"
                title={
                  resolvedNarrationPath
                    ? narrationPlaying
                      ? 'Tạm dừng narration'
                      : 'Nghe lại toàn bộ narration'
                    : 'Chưa có narration'
                }
                disabled={!resolvedNarrationPath}
                onClick={() => void togglePlayNarration()}
              >
                {narrationPlaying ? 'Ⅱ' : '♫'}
              </button>
              <span className="timeline-hint">
                Kéo clip để đổi thứ tự · Kéo cạnh phải để đổi thời lượng · Thả ra sẽ ghép lại video (FFmpeg)
              </span>
            </div>
            <div className="timeline-status">
              <span>{script?.scenes.length ?? 0} scenes</span>
              <span>·</span>
              <span>{formatTime(totalDuration)}</span>
              {timelineDirty && (
                <span className="dirty-dot">
                  ● {busy ? 'đang ghép lại...' : 'chưa ghép lại'}
                </span>
              )}
            </div>
            <div className="timeline-zoom">
              <span>−</span>
              <input
                type="range"
                min={45}
                max={120}
                value={timelineZoom}
                onChange={(event) => setTimelineZoom(Number(event.target.value))}
              />
              <span>＋</span>
            </div>
          </div>
          <Timeline
            script={script}
            selectedScene={selectedScene}
            timelineZoom={timelineZoom}
            playheadTime={playheadTime}
            onSelect={(index) => {
              setSelectedScene(index);
              setActiveStep('media');
              setPreviewMode('scene');
            }}
            onReorder={reorderScenes}
            onDurationChange={changeSceneDuration}
            onDurationCommit={commitSceneDuration}
            onSeek={seekToTimelineTime}
          />
        </section>
      </div>

      {(error || toast) && (
        <div className={`editor-toast ${toast?.type === 'ok' ? 'ok' : 'error'}`}>
          <span>{toast?.type === 'ok' ? '✓' : '!'}</span>
          <p>{toast?.text || error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setToast(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      <ExportDialog
        open={exportOpen}
        script={script}
        sceneMedia={sceneMedia}
        hasFinal={Boolean(result?.videoPath)}
        projectName={projectName.trim() || result?.title || 'Untitled project'}
        busy={busy}
        onClose={() => setExportOpen(false)}
        onConfirm={(payload) => void confirmExport(payload)}
      />

      {script && (
        <GenerateScenesDialog
          open={generateOpen}
          script={script}
          sceneMedia={sceneMedia}
          hasNarration={hasNarration || Boolean(resolvedNarrationPath)}
          mediaKind={mediaKind}
          busy={busy}
          progress={progress}
          onClose={() => setGenerateOpen(false)}
          onConfirm={(payload) => void confirmGenerate(payload)}
          onImportNarration={() => importNarrationFromFile()}
          onClearNarration={() => clearNarrationAudio()}
        />
      )}

      <StepActivityUI
        activity={activity}
        onMinimize={() =>
          setActivity((prev) => (prev ? { ...prev, modalOpen: false, dockOpen: true } : prev))
        }
        onExpand={() =>
          setActivity((prev) => (prev ? { ...prev, modalOpen: true, dockOpen: true } : prev))
        }
        onDismiss={() => setActivity(null)}
      />
    </div>
  );
}
