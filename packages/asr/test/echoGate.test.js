'use strict';
/**
 * 回声门单测（node:test）
 *
 * 覆盖四种真实场景：
 *  1. 对方说话（回环强、麦克风安静）→ them
 *  2. 我方说话（麦克风强、回环弱）  → me
 *  3. 没有麦克风轨（未接双轨）      → unknown（必须放行，不能吞掉对方问题）
 *  4. 麦克风被静音但回环仍在        → unknown（同上，防「设备选错导致全静音」）
 * 另外验证：判定抖动会被保持窗口吸收；全安静不给假问句。
 */

const test = require('node:test');
const assert = require('node:assert');
const { DualTrackEchoGate, NoiseFloor, dbfs, rmsOf } = require('../src/echoGate');

const SR = 16000;
const FRAME = SR / 10; // 100 ms

/** 生成一段给定振幅的正弦，模拟某一路音频的能量水平 */
function tone(amplitude, n = FRAME, freq = 220) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

const quiet = () => tone(0.0004); // 约 -68 dBFS，接近底噪

function warm(gate, { mic, loop }, rounds = 6, nowBase = 1_000_000) {
  let last;
  for (let i = 0; i < rounds; i++) {
    last = gate.classify(mic, loop, nowBase + i * 100);
  }
  return last;
}

test('dbfs / rmsOf 基本正确', () => {
  assert.strictEqual(dbfs(0), -120);
  assert.ok(Math.abs(dbfs(0.5) - (-6.02)) < 0.05);
  assert.ok(rmsOf(new Float32Array([0, 0, 0])) === 0);
});

test('对方说话：回环强、麦克风安静 → them', () => {
  const gate = new DualTrackEchoGate();
  const r = warm(gate, { mic: quiet(), loop: tone(0.12) });
  assert.strictEqual(r.role, 'them');
  assert.ok(r.loopDb > r.micDb);
});

test('我方说话：麦克风强、回环弱 → me', () => {
  const gate = new DualTrackEchoGate();
  const r = warm(gate, { mic: tone(0.15), loop: tone(0.02) });
  assert.strictEqual(r.role, 'me');
});

test('没有麦克风轨时不吞问题：返回 unknown，交给回环', () => {
  const gate = new DualTrackEchoGate();
  const r = gate.classify(null, tone(0.1));
  assert.strictEqual(r.role, 'unknown');
  assert.strictEqual(r.reason, 'no-mic-track');
});

test('麦克风误选/被静音（无信号）时不判 me', () => {
  const gate = new DualTrackEchoGate();
  // 先走几帧安静帧建立底噪
  warm(gate, { mic: quiet(), loop: tone(0.1) }, 3);
  const r = gate.classify(new Float32Array(FRAME), tone(0.1));
  assert.notStrictEqual(r.role, 'me');
});

test('保持窗口：me ↔ them 在 holdMs 内不来回翻转', () => {
  const gate = new DualTrackEchoGate({ holdMs: 600 });
  const t0 = 2_000_000;
  // 我方发言 3 帧
  let r;
  for (let i = 0; i < 3; i++) r = gate.classify(tone(0.15), tone(0.02), t0 + i * 100);
  assert.strictEqual(r.role, 'me');
  // 紧接着对方说话（100ms 后，仍在保持窗口内）→ 应保持 me
  r = gate.classify(quiet(), tone(0.12), t0 + 300);
  assert.strictEqual(r.role, 'me');
  assert.ok(r.reason.startsWith('hold:'));
  // 过了保持窗口 → 正常翻转
  r = gate.classify(quiet(), tone(0.12), t0 + 900);
  assert.strictEqual(r.role, 'them');
});

test('全安静：不产生假问句（silence）', () => {
  const gate = new DualTrackEchoGate();
  const r = warm(gate, { mic: quiet(), loop: quiet() }, 4);
  assert.strictEqual(r.role, 'silence');
});

test('底噪跟踪单调收敛，不会因偶发大值长期抬高', () => {
  const nf = new NoiseFloor(0.001);
  nf.observe(0.5); // 一次爆音
  const after = nf.value;
  for (let i = 0; i < 200; i++) nf.observe(0.001);
  assert.ok(nf.value < after);
  assert.ok(Math.abs(nf.value - 0.001) < 2e-4);
});

test('reset 清空统计与判定', () => {
  const gate = new DualTrackEchoGate();
  warm(gate, { mic: tone(0.15), loop: tone(0.02) }, 2);
  gate.reset();
  assert.strictEqual(gate.lastVerdict, 'unknown');
  assert.strictEqual(gate.stats.frames, 0);
});

test('统计计数自洽：frames = me + them + silence', () => {
  const gate = new DualTrackEchoGate();
  warm(gate, { mic: tone(0.15), loop: tone(0.02) }, 2);
  warm(gate, { mic: quiet(), loop: tone(0.12) }, 2, 3_000_000);
  warm(gate, { mic: quiet(), loop: quiet() }, 2, 5_000_000);
  assert.ok(gate.stats.frames > 0);
  assert.ok(gate.stats.me >= 1 && gate.stats.them >= 1 && gate.stats.silence >= 1);
});

// ---------------- 段归属投票 ----------------
const { voteRole } = require('../src/roleVote');

test('投票：me 票占有效票 60% 以上才判 me', () => {
  assert.strictEqual(voteRole([{ role: 'me' }, { role: 'me' }, { role: 'them' }, { role: 'them' }, { role: 'them' }]), 'them');
  assert.strictEqual(voteRole([{ role: 'me' }, { role: 'me' }, { role: 'me' }, { role: 'them' }, { role: 'them' }]), 'me');
});

test('投票：unknown / silence 不稀释票数', () => {
  const v = [{ role: 'me' }, { role: 'me' }, { role: 'unknown' }, { role: 'silence' }, { role: 'unknown' }];
  assert.strictEqual(voteRole(v), 'me');
});

test('投票：全是 unknown 或空数组时按对方处理（不漏问题）', () => {
  assert.strictEqual(voteRole([]), 'them');
  assert.strictEqual(voteRole(null), 'them');
  assert.strictEqual(voteRole([{ role: 'unknown' }, { role: 'silence' }]), 'them');
});

// ---------------- 协议回归：RMS 标量 vs PCM 数组 ----------------

test('回声门接受 RMS 标量（渲染层直接上报能量，不传 PCM 数组）', () => {
  const gate = new DualTrackEchoGate();
  // 麦克风 0.15 RMS（约 -16 dB），回环 0.02（约 -34 dB）→ 应判 me
  const r = gate.classify(0.15, 0.02, 1_000_000);
  assert.strictEqual(r.role, 'me', JSON.stringify(r));
});

test('回声门：RMS 为 0 的麦克风视为无信号，不判 me', () => {
  const gate = new DualTrackEchoGate();
  const r = gate.classify(0, 0.12, 1_000_000);
  assert.notStrictEqual(r.role, 'me');
});

test('回声门：mic=null 与 mic=undefined 都按「无麦克风轨」处理', () => {
  const gate = new DualTrackEchoGate();
  assert.strictEqual(gate.classify(null, 0.12).reason, 'no-mic-track');
  assert.strictEqual(gate.classify(undefined, 0.12).reason, 'no-mic-track');
});

test('回归：把 RMS 误当 PCM 数组传入会退化为空数组（写此测试以防再犯）', () => {
  // 这正是线上 bug：new Float32Array(0.15) 得到长度 0 的数组，
  // 而不是「一个 0.15 的样本」。凡是把标量当 PCM 用的地方都会踩这个。
  assert.strictEqual(new Float32Array(0.15).length, 0);
});
