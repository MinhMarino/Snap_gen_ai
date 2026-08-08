/**
 * Create a young Japanese male voice via Qwen Voice Design,
 * then synthesize a Japanese sample.
 *
 * Usage:
 *   export DASHSCOPE_API_KEY='sk-ws-...'
 *   node create-jp-male-voice.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY = process.env.DASHSCOPE_API_KEY;
const BASE = 'https://dashscope-intl.aliyuncs.com/api/v1';
const TARGET_MODEL = 'qwen3-tts-vd-2026-01-26';

const VOICE_PROMPT =
  'A young Japanese man in his early 20s. Clear mid-range male voice, ' +
  'natural Tokyo accent, bright and friendly, slightly energetic but not ' +
  'shouting. Smooth articulation, modern casual anime / VTuber narrator feel, ' +
  'warm and approachable.';

const PREVIEW_TEXT =
  'こんにちは！僕はケンです。今日はいい天気ですね。一緒に日本語を練習しましょう。';

const SYNTH_TEXT =
  'はじめまして。僕の名前はケン。二十歳の大学生です。' +
  '趣味は音楽とゲームで、週末はよく友達とカフェに行きます。' +
  'これからよろしくね！';

if (!API_KEY) {
  console.error('Missing DASHSCOPE_API_KEY');
  process.exit(1);
}

mkdirSync('outputs', { recursive: true });

async function createVoice() {
  console.log('1) Designing young Japanese male voice…');
  const res = await fetch(`${BASE}/services/audio/tts/customization`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen-voice-design',
      input: {
        action: 'create',
        target_model: TARGET_MODEL,
        preferred_name: 'jp_young_male',
        voice_prompt: VOICE_PROMPT,
        preview_text: PREVIEW_TEXT,
        language: 'ja',
      },
      parameters: {
        sample_rate: 24000,
        response_format: 'wav',
      },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error('Create voice failed:', JSON.stringify(body, null, 2));
    process.exit(2);
  }

  const voice = body?.output?.voice;
  const previewB64 = body?.output?.preview_audio?.data;
  if (!voice) {
    console.error('No voice in response:', JSON.stringify(body, null, 2));
    process.exit(2);
  }

  console.log(`   ✅ voice id: ${voice}`);
  writeFileSync('outputs/jp-young-male-voice-id.txt', voice + '\n');

  if (previewB64) {
    const previewPath = join('outputs', 'jp-young-male-preview.wav');
    writeFileSync(previewPath, Buffer.from(previewB64, 'base64'));
    console.log(`   preview: ${previewPath}`);
  }

  return voice;
}

async function synthesize(voice) {
  console.log('2) Synthesizing Japanese sample with custom voice…');
  const res = await fetch(
    `${BASE}/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TARGET_MODEL,
        input: {
          text: SYNTH_TEXT,
          voice,
          language_type: 'Japanese',
        },
      }),
    },
  );

  const body = await res.json();
  if (!res.ok) {
    console.error('Synthesize failed:', JSON.stringify(body, null, 2));
    process.exit(2);
  }

  const audioUrl = body?.output?.audio?.url;
  const audioData = body?.output?.audio?.data;
  const outPath = join('outputs', 'jp-young-male-sample.wav');

  if (audioData) {
    writeFileSync(outPath, Buffer.from(audioData, 'base64'));
  } else if (audioUrl) {
    const audioRes = await fetch(audioUrl);
    writeFileSync(outPath, Buffer.from(await audioRes.arrayBuffer()));
  } else {
    console.error('No audio in response:', JSON.stringify(body, null, 2));
    process.exit(2);
  }

  console.log(`   ✅ sample: ${outPath}`);
  return outPath;
}

const voice = await createVoice();
await synthesize(voice);
console.log('\nDone. Listen to:');
console.log('  outputs/jp-young-male-preview.wav');
console.log('  outputs/jp-young-male-sample.wav');
console.log(`\nReuse voice id later: ${voice}`);
