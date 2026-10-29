'use strict';
/**
 * VAD 分段器单测（node:test）
 * 覆盖：合成 PCM 分段数量/时长、Int16 输入、短噪声丢弃、maxSegmentMs 硬收句、partial。
 */

const test = require('node:test');
const assert = require('node:assert');

const { VadSegmenter, segmentPcm, rms, DEFAULT_VAD_OPTIONS } = require('../src/vad');
const { synthPcm, synthSpeechLike } = require('../src/synth');
const { toPcm16Buffer } = require('../src/contract');

const SR = 16000;

test('合成“0.5s静音 + 0.8s正弦 + 0.5s静音”×3 → 至少 3 段，时长合理', () => {
  const pcm = synthSpeechLike({ cycles: 3, silenceSec: 0.5, speechSec: 0.8 });
  assert.strictEqual(pcm.length, 4.4 * SR, '总时长 4.4 s');

  const segs = segmentPcm(pcm, { sampleRate: SR });
  assert.ok(segs.length >= 3, `段数应 ≥3，实际 ${segs.length}`);
  assert.strictEqual(segs.length, 3, '理想情况下正好 3 段');

  const expectedStarts = [0.5, 1.8, 3.1];
  segs.forEach((s, i) => {
    assert.ok(s.pcm instanceof Float32Array && s.pcm.length > 0, `第 ${i} 段要有 PCM`);
    // 起音时刻：静音 0.5s 后开始，误差不超过一个帧（20 ms）
    assert.ok(
      Math.abs(s.startSec - expectedStarts[i]) <= 0.06,
      `第 ${i} 段 startSec=${s.startSec.toFixed(3)} 应≈${expectedStarts[i]}`,
    );
    // 段长：0.8s 发声 ± 帧量化，且必须落在 [minSpeechMs, maxSegmentMs] 内
    assert.ok(s.durationSec >= 0.6 && s.durationSec <= 1.2, `第 ${i} 段时长 ${s.durationSec.toFixed(3)}s 应≈0.8s`);
    assert.ok(s.durationSec * 1000 >= DEFAULT_VAD_OPTIONS.minSpeechMs, '不短于 minSpeechMs');
    assert.ok(s.durationSec * 1000 <= DEFAULT_VAD_OPTIONS.maxSegmentMs, '不长于 maxSegmentMs');
    assert.strictEqual(s.reason, 'silence', '正常由尾部静音收句');
  });

  // 段与段之间严格递增、不重叠
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].startSec > segs[i - 1].endSec, '相邻段不重叠');
  }
});

test('段内 PCM 含 preRoll（起音前的音频被保留）', () => {
  const pcm = synthSpeechLike({ cycles: 1, silenceSec: 0.5, speechSec: 0.8 });
  const [seg] = segmentPcm(pcm, { sampleRate: SR });
  // 0.3s preRoll + 0.8s 发声 + 0.3s hangover ≈ 1.4s
  const segSec = seg.pcm.length / SR;
  assert.ok(segSec > 1.2 && segSec < 1.6, `段 PCM 应≈1.4s（含 preRoll 与尾部静音），实际 ${segSec.toFixed(3)}s`);
  // 段 PCM 的开头应当是静音（preRoll 部分）
  assert.ok(rms(seg.pcm.subarray(0, 1600)) < 0.001, '段首是 preRoll 静音');
});

test('Int16Array / Buffer 输入同样能分段', () => {
  const pcm = synthSpeechLike({ cycles: 3 });
  const buf = toPcm16Buffer(pcm); // Int16-LE 字节
  const i16 = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const a = segmentPcm(i16, { sampleRate: SR });
  const b = segmentPcm(buf, { sampleRate: SR });
  const c = segmentPcm(pcm, { sampleRate: SR });
  assert.strictEqual(a.length, c.length, 'Int16 与 Float32 段数一致');
  assert.strictEqual(b.length, c.length, 'Buffer 与 Float32 段数一致');
  assert.ok(Math.abs(a[0].startSec - c[0].startSec) < 1e-6);
});

test('短于 minSpeechMs 的爆音被丢弃', () => {
  // 0.5s 静音 + 100ms 短音 + 0.5s 静音
  const pcm = synthPcm([
    { sec: 0.5, kind: 'silence' },
    { sec: 0.1, kind: 'tone', freq: 1000, amp: 0.4 },
    { sec: 0.5, kind: 'silence' },
  ]);
  assert.strictEqual(segmentPcm(pcm, { sampleRate: SR }).length, 0, '100ms < 250ms，应被丢弃');

  const okPcm = synthPcm([
    { sec: 0.5, kind: 'silence' },
    { sec: 0.4, kind: 'tone', freq: 1000, amp: 0.4 },
    { sec: 0.5, kind: 'silence' },
  ]);
  assert.strictEqual(segmentPcm(okPcm, { sampleRate: SR }).length, 1, '400ms > 250ms，应保留');
});

test('超长独白被 maxSegmentMs 强制收句', () => {
  const pcm = synthPcm([{ sec: 12, kind: 'tone', freq: 300, amp: 0.3 }]);
  const segs = segmentPcm(pcm, { sampleRate: SR, maxSegmentMs: 2000 });
  assert.ok(segs.length >= 2, `12s 独白 + 2s 上限 → 至少 2 段，实际 ${segs.length}`);
  for (const s of segs) {
    assert.ok(s.pcm.length / SR <= 3, '每段不超过上限 + 一帧余量');
    assert.strictEqual(s.reason, 'maxlen', '由硬上限收句');
  }
  // 拼接起来应覆盖整段音频（不丢采样）
  const total = segs.reduce((a, s) => a + s.pcm.length, 0);
  assert.ok(total >= pcm.length * 0.9, `覆盖大部分音频：${total}/${pcm.length}`);
});

test('VadSegmenter 状态机：speech-start → segment，flush 强制收尾', () => {
  const v = new VadSegmenter({ sampleRate: SR });
  assert.strictEqual(v.state, 'idle');

  const frame = (sec, amp) => {
    const n = Math.round(sec * SR);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
    return f;
  };

  let ts = 0;
  let sawStart = false;
  const push = (f) => {
    ts += (f.length / SR) * 1000;
    return v.push(f, ts);
  };

  // 0.4s > minSpeechMs(250ms)，否则收句时会被判为爆音丢弃
  sawStart = push(frame(0.4, 0.5)).some((e) => e.type === 'speech-start');
  assert.ok(sawStart, '能量帧触发 speech-start');
  assert.strictEqual(v.state, 'speech');

  const evs = push(frame(0.5, 0)); // 500ms 静音 > hangover 300ms
  const seg = evs.find((e) => e.type === 'segment');
  assert.ok(seg, '尾部静音达到 hangoverMs 后收句');
  assert.strictEqual(seg.reason, 'silence');
  assert.strictEqual(v.state, 'idle', '收句后回到 idle');

  // 未收尾时 flush 强制出段
  push(frame(0.3, 0.5));
  const flushed = v.flush();
  assert.strictEqual(flushed.length, 1);
  assert.strictEqual(flushed[0].reason, 'flush');
  assert.strictEqual(v.flush().length, 0, 'flush 后没有残留段');
});

test('partialIntervalMs > 0 时吐实时 partial', () => {
  const v = new VadSegmenter({ sampleRate: SR, partialIntervalMs: 200 });
  const n = Math.round(0.5 * SR);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / SR);
  let ts = 0;
  let partials = 0;
  for (let k = 0; k < 4; k++) {
    ts += (n / SR) * 1000;
    for (const e of v.push(f, ts)) if (e.type === 'partial') partials++;
  }
  assert.ok(partials >= 2, `应产生多个 partial，实际 ${partials}`);
});

test('rms 基本性质', () => {
  assert.strictEqual(rms(new Float32Array(0)), 0);
  assert.ok(Math.abs(rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-9);
  // 0.3 幅度正弦的 RMS ≈ 0.212
  const n = 1600;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  assert.ok(rms(f) > 0.15 && rms(f) < 0.25, `正弦 RMS≈0.21，实际 ${rms(f)}`);
});
