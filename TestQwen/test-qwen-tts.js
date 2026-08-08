/**
 * Test Qwen (DashScope) TTS API key via HTTP.
 *
 * Usage:
 *   export DASHSCOPE_API_KEY='sk-ws-...'
 *   npm run test:key
 *
 * Optional:
 *   DASHSCOPE_REGION=beijing|singapore  (default: try both)
 *   TTS_TEXT='Xin chào'
 *   TTS_VOICE=Cherry
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY = process.env.DASHSCOPE_API_KEY;
const TEXT = process.env.TTS_TEXT || 'Xin chào, đây là bài kiểm tra Qwen TTS.';
const VOICE = process.env.TTS_VOICE || 'Cherry';
const LANGUAGE = process.env.TTS_LANGUAGE || 'Chinese';
const REGION = (process.env.DASHSCOPE_REGION || 'both').toLowerCase();

const ENDPOINTS = {
  beijing: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  singapore: 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
};

if (!API_KEY) {
  console.error('❌ Missing DASHSCOPE_API_KEY');
  console.error('   export DASHSCOPE_API_KEY="sk-ws-..."');
  process.exit(1);
}

function maskKey(key) {
  if (key.length <= 16) return '***';
  return `${key.slice(0, 10)}...${key.slice(-6)}`;
}

async function testEndpoint(name, url) {
  console.log(`\n── Testing region: ${name}`);
  console.log(`   URL: ${url}`);

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Models you enabled: instruct-flash is realtime-only (WebSocket).
        // For HTTP non-realtime voice-design use qwen3-tts-vd-* + custom voice.
        // Default here tries instruct non-realtime alias if available; prefer npm run test:realtime.
        model: process.env.TTS_MODEL || 'qwen3-tts-instruct-flash',
        input: {
          text: TEXT,
          voice: VOICE,
          language_type: LANGUAGE,
        },
      }),
    });
  } catch (err) {
    console.error(`   ❌ Network error: ${err.message}`);
    return { ok: false, region: name, error: err.message };
  }

  const elapsed = Date.now() - started;
  const contentType = res.headers.get('content-type') || '';
  let body;
  try {
    body = contentType.includes('application/json')
      ? await res.json()
      : { raw: await res.text() };
  } catch {
    body = { raw: '<unreadable body>' };
  }

  if (!res.ok) {
    console.error(`   ❌ HTTP ${res.status} (${elapsed}ms)`);
    console.error(`   code: ${body.code || '(none)'}`);
    console.error(`   message: ${body.message || JSON.stringify(body)}`);
    return {
      ok: false,
      region: name,
      status: res.status,
      code: body.code,
      message: body.message,
    };
  }

  const audioUrl = body?.output?.audio?.url;
  const chars = body?.usage?.characters;

  if (!audioUrl) {
    console.error(`   ❌ 200 nhưng không có audio.url`);
    console.error(JSON.stringify(body, null, 2));
    return { ok: false, region: name, error: 'no_audio_url', body };
  }

  mkdirSync('outputs', { recursive: true });
  const outPath = join('outputs', `tts-${name}.wav`);

  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error(`download HTTP ${audioRes.status}`);
    const buf = Buffer.from(await audioRes.arrayBuffer());
    writeFileSync(outPath, buf);
    console.log(`   ✅ KEY OK — TTS thành công (${elapsed}ms)`);
    console.log(`   voice: ${VOICE} | chars: ${chars ?? '?'} | file: ${outPath} (${buf.length} bytes)`);
    console.log(`   audio url (24h): ${audioUrl.slice(0, 80)}...`);
    return { ok: true, region: name, outPath, bytes: buf.length, chars };
  } catch (err) {
    console.log(`   ✅ KEY OK — TTS trả về URL nhưng tải file lỗi: ${err.message}`);
    console.log(`   audio url: ${audioUrl}`);
    return { ok: true, region: name, audioUrl, downloadError: err.message };
  }
}

async function main() {
  console.log('Qwen TTS key test');
  console.log(`key: ${maskKey(API_KEY)}`);
  console.log(`text: ${TEXT}`);
  console.log(`voice: ${VOICE} | language_type: ${LANGUAGE}`);

  const regions =
    REGION === 'both'
      ? Object.keys(ENDPOINTS)
      : REGION in ENDPOINTS
        ? [REGION]
        : null;

  if (!regions) {
    console.error(`❌ Unknown DASHSCOPE_REGION=${REGION}. Use beijing|singapore|both`);
    process.exit(1);
  }

  const results = [];
  for (const region of regions) {
    results.push(await testEndpoint(region, ENDPOINTS[region]));
  }

  console.log('\n══ SUMMARY ══');
  const success = results.filter((r) => r.ok);
  if (success.length) {
    console.log(`✅ Key dùng được với region: ${success.map((r) => r.region).join(', ')}`);
    console.log('   Dùng region đó khi làm app TTS.');
    process.exit(0);
  }

  console.log('❌ Key không gọi được TTS trên các region đã thử.');
  console.log('   Kiểm tra: key còn hạn / đúng region / đã bật model TTS / còn credit.');
  process.exit(2);
}

main();
