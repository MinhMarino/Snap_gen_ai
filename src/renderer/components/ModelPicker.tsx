import type { ImageFamily, MediaKind, ModelOption, VideoFamily } from '../../shared/types';
import {
  OUTPUT_FORMAT_PRESETS,
  getOutputFormatPreset,
  inferOutputFormatId,
  resolveAspectRatioForModel,
  type OutputFormatId,
} from '../../shared/output-format';

interface Props {
  mediaKind: MediaKind;
  families: { id: string; label: string }[];
  models: ModelOption[];
  family: string;
  modelId: string;
  aspectRatio: string;
  /** Optional: nhớ preset khi nhiều format cùng 9:16. */
  outputFormat?: string;
  resolution: string;
  mode: string;
  onFamilyChange: (f: VideoFamily | ImageFamily) => void;
  onModelChange: (id: string) => void;
  onAspectRatioChange: (v: string) => void;
  onOutputFormatChange?: (formatId: OutputFormatId) => void;
  onResolutionChange: (v: string) => void;
  onModeChange: (v: string) => void;
}

export default function ModelPicker(props: Props) {
  const familyModels = props.models.filter((m) => m.family === props.family && m.kind === props.mediaKind);
  const selected = familyModels.find((m) => m.id === props.modelId) ?? familyModels[0];
  const modes = selected?.extraFields?.mode ?? [];
  const modelAspectRatios = selected?.aspectRatios ?? [];
  /** Kling: không có param resolution — mode quyết định 720p/1080p. */
  const resolutionFromMode = selected?.resolutionFromMode;

  const selectedFormatId = inferOutputFormatId(props.aspectRatio, props.outputFormat);

  const onModeChange = (nextMode: string) => {
    props.onModeChange(nextMode);
    // Giữ resolution hiển thị đúng với mode vừa chọn, khỏi hứa 1080p rồi API xuất 720p.
    const derived = resolutionFromMode?.[nextMode];
    if (derived && derived !== props.resolution) props.onResolutionChange(derived);
  };

  const onFormatChange = (formatId: string) => {
    const preset = getOutputFormatPreset(formatId);
    if (!preset) return;
    const resolved = resolveAspectRatioForModel(preset.aspectRatio, modelAspectRatios);
    props.onOutputFormatChange?.(preset.id);
    props.onAspectRatioChange(resolved);
  };

  return (
    <div className="model-picker">
      <div className="grid-2">
        <div className="field">
          <label htmlFor="family">{props.mediaKind === 'image' ? 'Image family' : 'Video family'}</label>
          <select
            id="family"
            value={props.family}
            onChange={(e) => props.onFamilyChange(e.target.value as VideoFamily | ImageFamily)}
          >
            {props.families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={props.modelId}
            onChange={(e) => props.onModelChange(e.target.value)}
          >
            {familyModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="output-format">Output Format</label>
          <select
            id="output-format"
            value={selectedFormatId}
            onChange={(e) => onFormatChange(e.target.value)}
          >
            {OUTPUT_FORMAT_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.icon} {preset.label}
              </option>
            ))}
          </select>
          <p className="hint muted-hint">
            Pipeline dùng aspect ratio {resolveAspectRatioForModel(
              getOutputFormatPreset(selectedFormatId)?.aspectRatio || '16:9',
              modelAspectRatios
            )}
          </p>
        </div>
        <div className="field">
          <label htmlFor="res">Resolution</label>
          <select
            id="res"
            value={props.resolution}
            disabled={Boolean(resolutionFromMode)}
            onChange={(e) => props.onResolutionChange(e.target.value)}
          >
            {(selected?.resolutions ?? []).map((r) => (
              <option key={r} value={r}>
                {selected?.resolutionLabels?.[r] ?? r}
              </option>
            ))}
          </select>
          {resolutionFromMode && (
            <p className="hint muted-hint">
              Model không có tham số resolution — chọn Mode để đổi (1080p = professional).
            </p>
          )}
        </div>
      </div>

      {modes.length > 0 && (
        <div className="field">
          <label htmlFor="mode">Mode</label>
          <select id="mode" value={props.mode} onChange={(e) => onModeChange(e.target.value)}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {resolutionFromMode?.[m] ? `${m} — ${resolutionFromMode[m]}` : m}
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="hint">
        {props.mediaKind === 'image'
          ? `Thời lượng mỗi slide gợi ý: ${(selected?.durations ?? []).join(', ')}s — ảnh sẽ ghép thành slideshow theo narration.`
          : `Mỗi lần gen tối đa ${Math.max(...(selected?.durations ?? [8]))}s. Cảnh dài hơn sẽ auto-extend. Scene kế tiếp nối liền mạch: Veo/Grok/Seedance/Kling qua ref_history (chain extend), Sora/Meta qua keyframe frame cuối.`}
      </p>
    </div>
  );
}
