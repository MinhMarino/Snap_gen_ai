/**
 * Test Qwen TTS Realtime (WebSocket) — useful for streaming TTS apps.
 *
 * Usage:
 *   export DASHSCOPE_API_KEY='sk-ws-...'
 *   # optional: DASHSCOPE_REGION=beijing|singapore (default singapore)
 *   npm run test:realtime
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY = process.env.DASHSCOPE_API_KEY;
const REGION = (process.env.DASHSCOPE_REGION || 'singapore').toLowerCase();
const TEXT = process.env.TTS_TEXT || 'Hello from Qwen realtime TTS.';
const VOICE = process.env.TTS_VOICE || 'Cherry';
const LANGUAGE = process.env.TTS_LANGUAGE || 'Auto';
const INSTRUCTIONS = process.env.TTS_INSTRUCTIONS || '';
const OUT_NAME = process.env.TTS_OUT || `tts-realtime-${REGION}.wav`;
const MODEL =
  process.env.TTS_MODEL || 'qwen3-tts-instruct-flash-realtime-2026-01-22';

const WS_BASE = {
  beijing: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  singapore: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
};

if (!API_KEY) {
  console.error('❌ Missing DASHSCOPE_API_KEY');
  process.exit(1);
}
if (!(REGION in WS_BASE)) {
  console.error('❌ DASHSCOPE_REGION must be beijing or singapore');
  process.exit(1);
}

const url = `${WS_BASE[REGION]}?model=${MODEL}`;
const chunks = [];
let finished = false;

function send(ws, payload) {
  ws.send(JSON.stringify({ event_id: `event_${randomUUID()}`, ...payload }));
}

function pcmToWav(pcm, sampleRate = 24000) {
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

console.log(`Connecting realtime TTS (${REGION})…`);
console.log(url);

const ws = new WebSocket(url, {
  headers: {
    Authorization: `Bearer ${API_KEY}`,
  },
});

const timeout = setTimeout(() => {
  console.error('❌ Timeout 30s — không nhận đủ audio');
  ws.close();
  process.exit(2);
}, 30_000);

ws.on('open', () => {
  console.log('✅ WebSocket connected — key được chấp nhận (handshake OK)');
  console.log(`   voice=${VOICE} language=${LANGUAGE}`);
  const session = {
    voice: VOICE,
    mode: 'server_commit',
    response_format: 'pcm',
    sample_rate: 24000,
    language_type: LANGUAGE,
  };
  if (INSTRUCTIONS) {
    session.instructions = INSTRUCTIONS;
    session.optimize_instructions = true;
  }
  send(ws, { type: 'session.update', session });
  send(ws, { type: 'input_text_buffer.append', text: TEXT });
  send(ws, { type: 'input_text_buffer.commit' });
  send(ws, { type: 'session.finish' });
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    chunks.push(Buffer.from(data));
    return;
  }

  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    console.log('raw:', data.toString().slice(0, 200));
    return;
  }

  const type = msg.type || msg.event || 'unknown';
  if (type === 'error' || msg.error) {
    console.error('❌ Server error:', JSON.stringify(msg, null, 2));
    clearTimeout(timeout);
    ws.close();
    process.exit(2);
  }

  if (type === 'response.audio.delta' && msg.delta) {
    chunks.push(Buffer.from(msg.delta, 'base64'));
  }

  if (
    type === 'response.done' ||
    type === 'session.finished' ||
    type === 'session.finish' ||
    msg.status === 'finished'
  ) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);

    const pcm = Buffer.concat(chunks);
    mkdirSync('outputs', { recursive: true });
    const out = join('outputs', OUT_NAME);
    writeFileSync(out, pcmToWav(pcm));
    console.log(`✅ Realtime TTS OK — saved ${out} (${pcm.length} pcm bytes)`);
    ws.close();
    process.exit(0);
  }

  if (['session.created', 'session.updated', 'response.created'].includes(type)) {
    console.log(`   event: ${type}`);
  }
});

ws.on('unexpected-response', (_req, res) => {
  console.error(`❌ Handshake failed HTTP ${res.statusCode}`);
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    console.error(body || '(empty body)');
    clearTimeout(timeout);
    process.exit(2);
  });
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
  clearTimeout(timeout);
  process.exit(2);
});

ws.on('close', (code, reason) => {
  if (!finished) {
    clearTimeout(timeout);
    console.error(`❌ Closed early code=${code} reason=${reason.toString()}`);
    if (chunks.length) {
      const pcm = Buffer.concat(chunks);
      mkdirSync('outputs', { recursive: true });
      const out = join('outputs', `tts-realtime-${REGION}-partial.wav`);
      writeFileSync(out, pcmToWav(pcm));
      console.log(`Partial audio saved: ${out}`);
    }
    process.exit(2);
  }
});
