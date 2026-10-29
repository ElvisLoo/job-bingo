'use strict';
/**
 * 包出口 + 路由器单测（node:test）
 * 覆盖：createAsrRouter 的引擎选择、语种路由、云失败降级到 mock；导出完整性。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const asr = require('../src/index');
const { createAsrRouter, createMockEngine, createCloudEngine } = asr;
const { segmentPcm, encodeWav, decodeWav16kMono } = asr;
const { synthSpeechLike } = asr;

const SR = 16000;

test('index 导出齐全', () => {
  const required = [
    'VadSegmenter', 'segmentPcm', 'rms', 'DEFAULT_VAD_OPTIONS',
    'encodeWav', 'decodeWav', 'decodeWav16kMono', 'readWavInfo',
    'LanguageRouter', 'detectLangFromText', 'pickEngine',
    'createMockEngine', 'createCloudEngine', 'createAsrRouter',
    'createEngine', 'assertEngine', 'toFloat32Pcm', 'pcmDurationSec',
    'CONTRACT_VERSION', 'DEFAULT_SAMPLE_RATE',
  ];
  for (const k of required) {
    assert.ok(typeof asr[k] !== 'undefined', `缺少导出：${k}`);
  }
  assert.strictEqual(asr.DEFAULT_SAMPLE_RATE, 16000);
});

test('createAsrRouter 默认走 mock 引擎', async () => {
  const router = createAsrRouter();
  assert.ok(router.engines.mock, '默认内置 mock 引擎');
  assert.strictEqual(router.engines.cloud, null);
  const res = await router.transcribe(synthSpeechLike({ cycles: 2 }), { sampleRate: SR });
  assert.ok(res.text.length > 0);
  assert.strictEqual(res.engine, 'mock');
  assert.strictEqual(res.lang, 'chinese', '默认中文');
});

test('createAsrRouter 按文本语种路由', () => {
  // 语言有粘性（短句/不确定时沿用上一次），每条断言用独立 router
  assert.strictEqual(createAsrRouter().pickLanguage('请介绍一下你自己'), 'chinese');
  assert.strictEqual(createAsrRouter().pickLanguage('Tell me about yourself'), 'english');
  assert.strictEqual(createAsrRouter().pickLanguage(''), 'chinese', '无文本时中文优先');
  assert.strictEqual(
    createAsrRouter({ language: 'english' }).pickLanguage(''),
    'english',
    '初始语言可配置为 english',
  );
});

test('createAsrRouter 配了云就走云', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: '云端转写结果' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();

  const router = createAsrRouter({
    cloudConfig: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'whisper-1', apiKey: 'k' },
  });
  assert.ok(router.engines.cloud, '云引擎被创建');
  const res = await router.transcribe(synthSpeechLike({ cycles: 1 }), { sampleRate: SR });
  assert.strictEqual(res.text, '云端转写结果');
  assert.strictEqual(res.engine, 'cloud');
});

test('createAsrRouter 云失败时降级到 mock', async () => {
  const router = createAsrRouter({
    cloudConfig: { baseUrl: 'http://127.0.0.1:59998/v1', model: 'm', timeoutMs: 800 },
    fallbackToMock: true,
  });
  const res = await router.transcribe(synthSpeechLike({ cycles: 1 }), { sampleRate: SR });
  assert.strictEqual(res.degradedFrom, 'cloud');
  assert.strictEqual(res.engine, 'mock');
  assert.ok(res.text.length > 0, '降级后仍有文本');
  assert.ok(res.error && /cloud ASR/.test(res.error), '记录原始错误');
});

test('createAsrRouter fallbackToMock=false 时把错误抛给上层', async () => {
  const router = createAsrRouter({
    cloudConfig: { baseUrl: 'http://127.0.0.1:59997/v1', model: 'm', timeoutMs: 800 },
    fallbackToMock: false,
  });
  await assert.rejects(() => router.transcribe(new Float32Array(1600), { sampleRate: SR }), /cloud ASR/);
});

test('createAsrRouter 支持按语种指定不同引擎', async () => {
  const zh = createMockEngine({ prefix: '【中文引擎】' });
  const en = createMockEngine({ prefix: '【英文引擎】' });
  const router = createAsrRouter({ engines: { chinese: zh, english: en } });
  const a = await router.transcribe(new Float32Array(16000), { sampleRate: SR, text: '介绍一下你的项目' });
  const b = await router.transcribe(new Float32Array(16000), { sampleRate: SR, text: 'introduce your project' });
  assert.ok(a.text.startsWith('【中文引擎】'));
  assert.ok(b.text.startsWith('【英文引擎】'));
});

test('端到端：合成音 → WAV → 解析 → 分段 → mock 转写', async () => {
  const pcm = synthSpeechLike({ cycles: 3, silenceSec: 0.5, speechSec: 0.8 });
  const wav = encodeWav(pcm, SR);
  const back = decodeWav16kMono(wav);
  assert.strictEqual(back.length, pcm.length);

  const segs = segmentPcm(back, { sampleRate: SR });
  assert.ok(segs.length >= 3);

  const router = createAsrRouter();
  for (const s of segs) {
    const res = await router.transcribe(s.pcm, { sampleRate: SR });
    assert.ok(res.text.length > 0, '每段都能拿到非空文本');
  }
});
