import type { ScriptDraft } from '../../shared/types';
import {
  MAX_SCENE_DURATION_SEC,
  TYPICAL_NARRATIVE_BEAT_SEC,
  maxSingleShotDuration,
} from '../../shared/models';

interface Props {
  script: ScriptDraft;
  onChange: (s: ScriptDraft) => void;
  modelId: string;
  mediaKind: 'video' | 'image';
}

export default function SceneEditor({ script, onChange, modelId, mediaKind }: Props) {
  const updateScene = (index: number, patch: Partial<ScriptDraft['scenes'][number]>) => {
    const scenes = script.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s));
    const narration = scenes.map((s) => s.narration_segment).join(' ');
    onChange({ ...script, scenes, narration });
  };

  const addScene = () => {
    const scenes = [
      ...script.scenes,
      {
        id: `scene-${script.scenes.length + 1}`,
        visual_prompt: '',
        narration_segment: '',
        duration_hint: TYPICAL_NARRATIVE_BEAT_SEC,
      },
    ];
    onChange({ ...script, scenes });
  };

  const removeScene = (index: number) => {
    if (script.scenes.length <= 1) return;
    const scenes = script.scenes.filter((_, i) => i !== index);
    onChange({
      ...script,
      scenes,
      narration: scenes.map((s) => s.narration_segment).join(' '),
    });
  };

  const maxShot = maxSingleShotDuration(modelId);

  return (
    <div>
      <div className="field">
        <label htmlFor="title">Tiêu đề</label>
        <input
          id="title"
          value={script.title}
          onChange={(e) => onChange({ ...script, title: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="narration">Narration đầy đủ (OpenAI TTS + Whisper)</label>
        <textarea
          id="narration"
          value={script.narration}
          onChange={(e) => onChange({ ...script, narration: e.target.value })}
        />
      </div>

      {script.scenes.map((scene, index) => (
        <div className="scene-card" key={scene.id}>
          <div className="scene-head">
            <strong>
              Cảnh {index + 1}
              {scene.chapter ? ` · ${scene.chapter}` : ''}
            </strong>
            <button type="button" className="btn ghost" onClick={() => removeScene(index)}>
              Xóa
            </button>
          </div>
          <div className="field">
            <label>Chapter</label>
            <input
              value={scene.chapter || ''}
              placeholder="Opening, Top 10, …"
              onChange={(e) =>
                updateScene(index, { chapter: e.target.value.trim() || undefined })
              }
            />
          </div>
          <div className="field">
            <label>{mediaKind === 'image' ? 'Image prompt (Snapgen)' : 'Visual prompt (Snapgen)'}</label>
            <textarea
              value={scene.visual_prompt}
              onChange={(e) => updateScene(index, { visual_prompt: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Narration segment</label>
            <textarea
              value={scene.narration_segment}
              onChange={(e) => updateScene(index, { narration_segment: e.target.value })}
            />
          </div>
          <div className="field">
            <label>{mediaKind === 'image' ? 'Thời lượng slide (giây)' : 'Duration hint (giây)'}</label>
            <input
              type="number"
              min={1}
              max={MAX_SCENE_DURATION_SEC}
              value={scene.duration_hint}
              onChange={(e) =>
                updateScene(index, {
                  duration_hint: Math.min(
                    MAX_SCENE_DURATION_SEC,
                    Math.max(1, Number(e.target.value) || TYPICAL_NARRATIVE_BEAT_SEC)
                  ),
                })
              }
            />
            {mediaKind === 'video' && scene.duration_hint > maxShot && (
              <p className="hint">
                &gt;{maxShot}s → cảnh này phải chia thành nhiều shot, tất cả dùng CHUNG visual
                prompt này nên hình gần như lặp lại, mà vẫn tốn credit từng shot. Muốn hình đổi
                thì tách thành nhiều cảnh ≤{maxShot}s, mỗi cảnh một prompt riêng.
              </p>
            )}
          </div>
        </div>
      ))}

      <button type="button" className="btn" onClick={addScene}>
        Thêm cảnh
      </button>
    </div>
  );
}
