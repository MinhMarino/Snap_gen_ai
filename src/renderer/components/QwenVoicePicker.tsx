import { useEffect, useMemo, useState } from 'react';
import {
  filterQwenVoices,
  getQwenVoiceOption,
  listQwenVoicesForLanguage,
  pickQwenVoiceForLanguage,
  qwenAgeLabel,
  qwenPurposeLabels,
  QWEN_VOICE_AGES,
  QWEN_VOICE_PURPOSES,
  type QwenVoiceFilter,
} from '../../shared/voice';

export default function QwenVoicePicker({
  languageType,
  value,
  disabled,
  onChange,
  selectId = 'qwen-voice',
  label = 'Voice',
}: {
  languageType: string;
  value: string;
  disabled?: boolean;
  onChange: (voiceId: string) => void;
  selectId?: string;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [gender, setGender] = useState<QwenVoiceFilter['gender']>('');
  const [age, setAge] = useState<QwenVoiceFilter['age']>('');
  const [purpose, setPurpose] = useState<QwenVoiceFilter['purpose']>('');

  const { presets, others } = useMemo(
    () => listQwenVoicesForLanguage(languageType),
    [languageType]
  );

  // Remap speaker cũ / không khớp language → speaker Irodori phù hợp.
  useEffect(() => {
    const next = pickQwenVoiceForLanguage(languageType, value);
    if (next && next !== value) onChange(next);
  }, [value, languageType, onChange]);

  const filter: QwenVoiceFilter = { query, gender, age, purpose };
  const filteredPresets = useMemo(
    () => filterQwenVoices(presets, filter),
    [presets, query, gender, age, purpose]
  );
  const filteredOthers = useMemo(
    () => filterQwenVoices(others, filter),
    [others, query, gender, age, purpose]
  );
  const total = filteredPresets.length + filteredOthers.length;
  const selected = getQwenVoiceOption(value);
  const selectedHidden =
    Boolean(selected) &&
    !filteredPresets.some((v) => v.id === value) &&
    !filteredOthers.some((v) => v.id === value);

  const clearFilters = () => {
    setQuery('');
    setGender('');
    setAge('');
    setPurpose('');
  };

  const hasFilters = Boolean(query.trim() || gender || age || purpose);

  return (
    <div className="qwen-voice-picker">
      <div className="qwen-voice-filters">
        <div className="qwen-voice-filters-head">
          <span>Bộ lọc giọng</span>
          {hasFilters ? (
            <button type="button" className="btn ghost" disabled={disabled} onClick={clearFilters}>
              Xóa lọc
            </button>
          ) : null}
        </div>

        <label className="qwen-voice-filter-field">
          <span>Tìm kiếm</span>
          <input
            type="search"
            className="qwen-voice-search"
            value={query}
            disabled={disabled}
            placeholder="Tên hoặc mô tả…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <label className="qwen-voice-filter-field">
          <span>Giới tính</span>
          <select
            value={gender || ''}
            disabled={disabled}
            onChange={(e) => setGender((e.target.value || '') as QwenVoiceFilter['gender'])}
          >
            <option value="">Tất cả</option>
            <option value="female">Nữ</option>
            <option value="male">Nam</option>
          </select>
        </label>

        <label className="qwen-voice-filter-field">
          <span>Độ tuổi</span>
          <select
            value={age || ''}
            disabled={disabled}
            onChange={(e) => setAge((e.target.value || '') as QwenVoiceFilter['age'])}
          >
            <option value="">Tất cả</option>
            {QWEN_VOICE_AGES.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        <label className="qwen-voice-filter-field">
          <span>Mục đích</span>
          <select
            value={purpose || ''}
            disabled={disabled}
            onChange={(e) => setPurpose((e.target.value || '') as QwenVoiceFilter['purpose'])}
          >
            <option value="">Tất cả</option>
            {QWEN_VOICE_PURPOSES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <p className="qwen-voice-filter-count">{total} giọng phù hợp</p>
      </div>

      <div className="field">
        <label htmlFor={selectId}>{label}</label>
        <select
          id={selectId}
          value={value}
          disabled={disabled || (total === 0 && !selectedHidden)}
          onChange={(e) => onChange(e.target.value)}
        >
          {selectedHidden && selected ? (
            <option value={selected.id}>{selected.label} (đang chọn — ngoài bộ lọc)</option>
          ) : null}
          {filteredPresets.length > 0 ? (
            <optgroup
              label={
                languageType === 'Japanese'
                  ? 'Preset tiếng Nhật'
                  : `Preset ${languageType || 'Auto'}`
              }
            >
              {filteredPresets.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {filteredOthers.length > 0 ? (
            <optgroup label="Voice khác">
              {filteredOthers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {total === 0 && !selectedHidden ? (
            <option value="" disabled>
              Không có giọng khớp bộ lọc
            </option>
          ) : null}
        </select>
      </div>

      {selected ? (
        <div className="qwen-voice-detail" aria-live="polite">
          <div className="qwen-voice-detail-head">
            <strong>{selected.id}</strong>
            {selected.gender ? (
              <span className="qwen-voice-detail-meta">
                {selected.gender === 'female' ? 'Nữ' : 'Nam'}
              </span>
            ) : null}
            {selected.age ? (
              <span className="qwen-voice-detail-meta">{qwenAgeLabel(selected.age)}</span>
            ) : null}
          </div>
          {selected.purposes?.length ? (
            <p className="qwen-voice-detail-tags">{qwenPurposeLabels(selected.purposes)}</p>
          ) : null}
          <p className="qwen-voice-detail-desc">{selected.description}</p>
        </div>
      ) : null}
    </div>
  );
}
