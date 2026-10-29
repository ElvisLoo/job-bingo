'use strict';
/**
 * 契约 + mock 引擎单测（node:test）
 * 覆盖：mock 引擎经契约返回非空文本、latencyMs 自动填充、assertEngine 校验、PCM 归一化。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  CONTRACT_VERSION,
  DEFAULT_SAMPLE_RATE,
  createEngine,
  assertEngine,
  normalizeTranscribeResult,
  toFloat32Pcm,
  toPcm16Buffer,
  pcmSampleCount,
  pcmDurationSec,
} = require('../src/contract');
const { createMockEngine } = require('../src/mockEngine');
const { synthSpeechLike } = require('../src/synth');

test('契约版本号与默认采样率', () => {
  assert.strictEqual(CONTRACT_VERSION, 1);
  assert.strictEqual(DEFAULT_SAMPLE_RATE, 16000);
});

test('mockEngine 通过契约接口返回非空文本（验收项 2）', async () => {
  const engine = createMockEngine();
  assertEngine(engine);
  assert.strictEqual(engine.name, 'mock');

  const pcm = synthSpeechLike({ cycles: 1, silenceSec: 0.2, speechSec: 1.0 });
  const res = await engine.transcribe(pcm, { sampleRate: 16000 });

  assert.strictEqual(typeof res.text, 'string');
  assert.ok(res.text.length > 0, '文本不能为空');
  assert.ok(/模拟转写/.test(res.text), '占位文本应标明是离线模拟');
  assert.strictEqual(typeof res.latencyMs, 'number');
  assert.ok(Number.isFinite(res.latencyMs) && res.latencyMs >= 0);
  assert.strictEqual(res.engine, 'mock');
  assert.ok(Array.isArray(res.segments) && res.segments.length > 0, '带句级 segments');
  for (const s of res.segments) {
    assert.strictEqual(typeof s.startSec, 'number');
    assert.strictEqual(typeof s.endSec, 'number');
    assert.ok(s.endSec >= s.startSec);
    assert.strictEqual(typeof s.text, 'string');
  }
});

test('mockEngine 文本随音频时长变化', async () => {
  const e = createMockEngine();
  const short = await e.transcribe(new Float32Array(16000), { sampleRate: 16000 }); // 1s
  const long = await e.transcribe(new Float32Array(160000), { sampleRate: 16000 }); // 10s
  assert.ok(short.text.includes('1.00'), `1s 音频应报 1.00 秒，实际：${short.text}`);
  assert.ok(long.text.includes('10.00'));
  assert.notStrictEqual(short.text, long.text);
});

test('createEngine 会为裸引擎兜底 latencyMs 并规整结果', async () => {
  const raw = createEngine({
    name: 'raw',
    async transcribe() {
      return { text: '  hello  ' }; // 没有 latencyMs
    },
  });
  const res = await raw.transcribe(new Float32Array(10));
  assert.strictEqual(res.text, 'hello', '文本 trim');
  assert.strictEqual(res.engine, 'raw');
  assert.strictEqual(typeof res.latencyMs, 'number');
  assert.strictEqual(res.segments, undefined, '没有 segments 时不应硬塞空数组');
});

test('normalizeTranscribeResult 拒绝非对象返回值', () => {
  assert.throws(() => normalizeTranscribeResult(null, Date.now(), 'x'), /must resolve an object/);
  assert.throws(() => normalizeTranscribeResult('text', Date.now(), 'x'), /must resolve an object/);
  const r = normalizeTranscribeResult({ text: 'a', latencyMs: 12 }, 0, 'y');
  assert.strictEqual(r.latencyMs, 12, '引擎自带的 latencyMs 优先');
});

test('assertEngine 校验引擎形状', () => {
  assert.throws(() => assertEngine(null), /missing transcribe/);
  assert.throws(() => assertEngine({}), /missing transcribe/);
  assert.throws(() => assertEngine({ transcribe() {} }), /non-empty .name/);
  const ok = { name: 'x', transcribe() {} };
  assert.strictEqual(assertEngine(ok), ok);
});

test('toFloat32Pcm 支持 Float32 / Int16 / Buffer / 数组', () => {
  const f = new Float32Array([0, 0.5, -0.5]);
  assert.strictEqual(toFloat32Pcm(f), f, 'Float32 原样返回');

  const i16 = new Int16Array([32767, -32768, 0]);
  const c = toFloat32Pcm(i16);
  assert.ok(c instanceof Float32Array);
  assert.ok(Math.abs(c[0] - 32767 / 32768) < 1e-6);
  assert.ok(Math.abs(c[1] + 1) < 1e-6);

  const buf = toPcm16Buffer(f);
  const fromBuf = toFloat32Pcm(buf);
  assert.strictEqual(fromBuf.length, 3);
  assert.ok(Math.abs(fromBuf[1] - 0.5) < 1e-3, `0.5 → int16 → float 有量化误差，实际 ${fromBuf[1]}`);

  const joined = toFloat32Pcm([f, i16]);
  assert.strictEqual(joined.length, 6, '数组输入会被拼接');
});

test('pcmSampleCount / pcmDurationSec', () => {
  assert.strictEqual(pcmSampleCount(new Float32Array(1600)), 1600);
  assert.strictEqual(pcmSampleCount([new Float32Array(1600), new Int16Array(800)]), 2400);
  assert.strictEqual(pcmSampleCount(toPcm16Buffer(new Float32Array(1600))), 1600);
  assert.ok(Math.abs(pcmDurationSec(new Float32Array(16000), 16000) - 1) < 1e-9);
  assert.strictEqual(pcmSampleCount(null), 0);
});

test('toPcm16Buffer 输出 Int16-LE 且长度正确', () => {
  const b = toPcm16Buffer(new Float32Array([1, -1, 0]));
  assert.strictEqual(b.length, 6);
  assert.strictEqual(b.readInt16LE(0), 32767);
  assert.strictEqual(b.readInt16LE(2), -32768);
  assert.strictEqual(b.readInt16LE(4), 0);
});
