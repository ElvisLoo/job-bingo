'use strict';
/**
 * WAV 封装/解析单测（node:test）
 * 覆盖：16 kHz/16bit/mono 往返、采样率/位深/声道/时长断言、16k 强制校验、Int16 直传路径。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  encodeWav,
  encodeWavFrom,
  decodeWav,
  decodeWav16kMono,
  readWavInfo,
} = require('../src/wav');
const { synthSpeechLike } = require('../src/synth');
const { DEFAULT_SAMPLE_RATE } = require('../src/contract');

const SR = 16000;

test('encodeWav → decodeWav 往返：采样率/位深/声道/时长都正确', () => {
  const pcm = synthSpeechLike({ cycles: 3, silenceSec: 0.5, speechSec: 0.8 });
  const expectedSec = (0.5 + 0.8) * 3 + 0.5; // 4.4 s

  const wav = encodeWav(pcm, SR);
  assert.ok(wav instanceof Uint8Array, 'encodeWav 返回 Uint8Array');
  assert.strictEqual(wav.length, 44 + pcm.length * 2, 'WAV 长度 = 44 字节头 + 采样点*2');

  // 头字段
  const tag = (off) => String.fromCharCode(wav[off], wav[off + 1], wav[off + 2], wav[off + 3]);
  assert.strictEqual(tag(0), 'RIFF');
  assert.strictEqual(tag(8), 'WAVE');
  assert.strictEqual(tag(12), 'fmt ');
  assert.strictEqual(tag(36), 'data');

  const info = readWavInfo(wav);
  assert.strictEqual(info.sampleRate, SR, '采样率 16 kHz');
  assert.strictEqual(info.bits, 16, '位深 16 bit');
  assert.strictEqual(info.channels, 1, '单声道');
  assert.ok(Math.abs(info.durationSec - expectedSec) < 0.01, `时长≈${expectedSec}s，实际 ${info.durationSec}`);

  const dec = decodeWav(wav);
  assert.strictEqual(dec.pcm.length, pcm.length, '采样点数一致');
  assert.strictEqual(dec.sampleRate, SR);
  assert.strictEqual(dec.channels, 1);
  assert.strictEqual(dec.bits, 16);

  // 采样值误差：±1 LSB 量化 + 编码用 32767/解码用 32768 的固有不对称，合计 < 2 LSB
  let maxErr = 0;
  for (let i = 0; i < pcm.length; i++) maxErr = Math.max(maxErr, Math.abs(dec.pcm[i] - pcm[i]));
  assert.ok(maxErr < 2 / 32768 + 1e-6, `量化误差 ${maxErr} 应 < 2LSB`);
});

test('decodeWav16kMono 只接受 16 kHz 单声道', () => {
  const pcm = synthSpeechLike({ cycles: 1 });
  const ok = decodeWav16kMono(encodeWav(pcm, SR));
  assert.strictEqual(ok.length, pcm.length);

  const bad = encodeWav(pcm, 8000);
  assert.throws(() => decodeWav16kMono(bad), /expected 16 kHz mono/);
});

test('encodeWav 支持 Int16Array 直传', () => {
  const i16 = new Int16Array([0, 32767, -32768, 16000, -16000]);
  const wav = encodeWav(i16, SR);
  const back = decodeWav(wav);
  assert.strictEqual(back.pcm.length, 5);
  assert.ok(Math.abs(back.pcm[1] - 32767 / 32768) < 1e-6);
  assert.ok(Math.abs(back.pcm[2] + 1) < 1e-6, '-32768 归一化到 -1');
});

test('encodeWavFrom 接受 Float32Array / Int16Array / Buffer 混合输入', () => {
  const f32 = new Float32Array([0, 0.5, -0.5]);
  const wav1 = encodeWavFrom(f32, SR);
  assert.strictEqual(decodeWav(wav1).pcm.length, 3);

  const buf = require('node:buffer').Buffer.alloc(4);
  buf.writeInt16LE(1000, 0);
  buf.writeInt16LE(-1000, 2);
  const wav2 = encodeWavFrom(buf, SR);
  const d2 = decodeWav(wav2);
  assert.strictEqual(d2.pcm.length, 2);
  assert.ok(d2.pcm[0] > 0 && d2.pcm[1] < 0, 'Buffer 按 Int16-LE 解释');
});

test('decodeWav 对非法输入响亮报错（不做静默重采样）', () => {
  assert.throws(() => decodeWav(new Uint8Array(10)), /not a RIFF\/WAVE file/);
  const noData = new Uint8Array(44);
  noData.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  noData.set([0x57, 0x41, 0x56, 0x45], 8); // 'WAVE'
  assert.throws(() => decodeWav(noData), /WAV has no data chunk/);
  // 8 bit 数据会被明确拒绝
  const wav = encodeWav(new Float32Array(16), SR);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  view.setUint16(34, 8, true); // bitsPerSample = 8
  assert.throws(() => decodeWav(wav), /16-bit PCM/);
});

test('合成音 → WAV → 解析 → VAD 分段 全链路（验收项 1）', () => {
  const pcm = synthSpeechLike({ cycles: 3, silenceSec: 0.5, speechSec: 0.8 });
  const wav = encodeWav(pcm, SR);
  const back = decodeWav16kMono(wav);
  const { segmentPcm } = require('../src/vad');
  const segs = segmentPcm(back, { sampleRate: SR });
  assert.ok(segs.length >= 3, `至少 3 段，实际 ${segs.length}`);
  assert.strictEqual(DEFAULT_SAMPLE_RATE, SR);
});
