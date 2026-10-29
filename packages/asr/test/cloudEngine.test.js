'use strict';
/**
 * 云引擎单测（node:test + 本地假 HTTP 服务，不联网、不需要真 API Key）
 * 验证：multipart 请求体里确实带了 file 字段与可解析的 WAV、Authorization 头、
 *       model/response_format 字段、正常返回解析、HTTP 错误与超时路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createCloudEngine, isConfigured, CLOUD_DEFAULTS } = require('../src/cloudEngine');
const { decodeWav } = require('../src/wav');
const { synthSpeechLike } = require('../src/synth');

const SR = 16000;

/** 起一个假 OpenAI 兼容转写服务；返回 { url, port, close, last } */
async function startFakeServer(handler) {
  const seen = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const record = {
        url: req.url,
        method: req.method,
        contentType: req.headers['content-type'] || '',
        authorization: req.headers.authorization || null,
        body,
      };
      seen.requests.push(record);
      let out;
      try {
        out = handler(record);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message) }));
        return;
      }
      const { status = 200, payload } = out;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}

/** 从 multipart 原始体里抠出上传的 WAV 字节（无第三方 multipart 解析依赖）。 */
function extractUploadedWav(body) {
  const start = body.indexOf('RIFF');
  assert.ok(start >= 0, '请求体里应能找到 RIFF 头');
  const tail = body.indexOf('\r\n--', start);
  const end = tail > 0 ? tail : body.length;
  return body.subarray(start, end);
}

test('配置校验：缺 baseUrl / model 直接抛错', () => {
  assert.throws(() => createCloudEngine({}), /missing baseUrl/);
  assert.throws(() => createCloudEngine({ baseUrl: 'http://x' }), /missing model/);
  assert.strictEqual(isConfigured({ baseUrl: 'http://x', model: 'whisper-1' }), true);
  assert.strictEqual(isConfigured({ baseUrl: 'http://x' }), false);
  assert.strictEqual(CLOUD_DEFAULTS.endpoint, '/v1/audio/transcriptions');
});

test('云引擎：请求体带 file 字段且 WAV 可被解析（验收项 3）', async (t) => {
  const srv = await startFakeServer((rec) => ({
    payload: {
      text: '面试官问：请介绍一下你最有挑战的项目',
      language: 'zh',
      segments: [{ start: 0.0, end: 1.2, text: '面试官问：请介绍一下你最有挑战的项目' }],
    },
  }));
  t.after(() => srv.close());

  const engine = createCloudEngine({
    baseUrl: srv.baseUrl,
    model: 'whisper-1',
    apiKey: 'test-key-not-real',
    timeoutMs: 5000,
  });
  assert.strictEqual(engine.name, 'cloud');

  const pcm = synthSpeechLike({ cycles: 1, silenceSec: 0.2, speechSec: 1.0 }); // 1.4 s
  const res = await engine.transcribe(pcm, { sampleRate: SR });

  const req = srv.seen.requests[0];
  assert.strictEqual(req.method, 'POST');
  assert.strictEqual(req.url, '/v1/audio/transcriptions');
  assert.ok(req.contentType.startsWith('multipart/form-data'), 'multipart/form-data');
  assert.ok(req.contentType.includes('boundary='), 'multipart 必须有 boundary');
  assert.strictEqual(req.authorization, 'Bearer test-key-not-real', '带 Authorization 头');

  const raw = req.body.toString('latin1');
  assert.ok(raw.includes('name="file"'), '有 file 字段');
  assert.ok(raw.includes('filename="segment.wav"'), '文件名是 segment.wav');
  assert.ok(raw.includes('name="model"') && raw.includes('whisper-1'), '带 model 字段');
  assert.ok(raw.includes('name="response_format"'), '带 response_format 字段');

  const wavBytes = extractUploadedWav(req.body);
  const dec = decodeWav(wavBytes);
  assert.strictEqual(dec.sampleRate, SR, '上传的是 16 kHz');
  assert.strictEqual(dec.channels, 1, '单声道');
  assert.strictEqual(dec.bits, 16, '16 bit');
  assert.strictEqual(dec.pcm.length, pcm.length, '采样点数与输入一致');
  assert.ok(Math.abs(dec.pcm.length / SR - 1.4) < 0.01, '时长 1.4 s');

  // 返回解析
  assert.strictEqual(res.text, '面试官问：请介绍一下你最有挑战的项目');
  assert.strictEqual(res.lang, 'zh');
  assert.strictEqual(res.segments.length, 1);
  assert.strictEqual(res.segments[0].startSec, 0);
  assert.strictEqual(res.segments[0].endSec, 1.2);
  assert.strictEqual(typeof res.latencyMs, 'number');
});

test('云引擎：apiKey 留空时不发 Authorization 头（兼容本地无鉴权服务）', async (t) => {
  const srv = await startFakeServer(() => ({ payload: { text: '本地服务返回' } }));
  t.after(() => srv.close());
  const engine = createCloudEngine({ baseUrl: srv.baseUrl, model: 'whisper-1' });
  const res = await engine.transcribe(new Float32Array(1600), { sampleRate: SR });
  assert.strictEqual(res.text, '本地服务返回');
  assert.strictEqual(srv.seen.requests[0].authorization, null);
});

test('云引擎：服务端返回纯文本也能解析', async (t) => {
  const srv = await startFakeServer(() => ({ payload: '纯文本转写结果' }));
  t.after(() => srv.close());
  const engine = createCloudEngine({ baseUrl: srv.baseUrl, model: 'm', responseFormat: '' });
  const res = await engine.transcribe(new Float32Array(3200), { sampleRate: SR });
  assert.strictEqual(res.text, '纯文本转写结果');
});

test('云引擎：HTTP 非 2xx 抛错并带上状态码', async (t) => {
  const srv = await startFakeServer(() => ({ status: 500, payload: { error: 'boom' } }));
  t.after(() => srv.close());
  const engine = createCloudEngine({ baseUrl: srv.baseUrl, model: 'm', apiKey: 'k' });
  await assert.rejects(
    () => engine.transcribe(new Float32Array(1600), { sampleRate: SR }),
    /cloud ASR HTTP 500/,
  );
});

test('云引擎：连不上 / 超时按错误处理，不会静默吞掉', async () => {
  // 用一个几乎肯定没人监听的高端口
  const engine = createCloudEngine({
    baseUrl: 'http://127.0.0.1:59999/v1',
    model: 'm',
    timeoutMs: 800,
  });
  await assert.rejects(
    () => engine.transcribe(new Float32Array(1600), { sampleRate: SR }),
    /cloud ASR request failed/,
  );
});

test('云引擎：空音频不发请求', async (t) => {
  let hits = 0;
  const srv = await startFakeServer(() => {
    hits++;
    return { payload: { text: 'x' } };
  });
  t.after(() => srv.close());
  const engine = createCloudEngine({ baseUrl: srv.baseUrl, model: 'm' });
  const res = await engine.transcribe(new Float32Array(0), { sampleRate: SR });
  assert.strictEqual(res.text, '');
  assert.strictEqual(hits, 0, '空音频应直接短路');
});
