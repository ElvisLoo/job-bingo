'use strict';
/**
 * 合成测试音（16 kHz / 单声道 / float32）——单测与离线演示用，不参与线上链路。
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：resources/test-audio/*.wav（原仓库用真实录音夹具，本项目不携带音频二进制，
 *   改为程序生成，避免把二进制塞进仓库）
 * 许可证：Apache-2.0（沿用原仓库 LICENSE）
 * Modified by 面必过（interview-copilot）：新增文件，按 VAD 单测需要的
 *   “静音-发声-静音”节拍程序化合成，结果确定可复现。
 */

const { DEFAULT_SAMPLE_RATE } = require('./contract');

/**
 * 按节拍表合成 PCM。
 * @param {Array<{sec:number, kind?:'silence'|'tone'|'noise', freq?:number, amp?:number}>} pattern
 * @param {number} [sampleRate]
 * @returns {Float32Array}
 */
function synthPcm(pattern, sampleRate = DEFAULT_SAMPLE_RATE) {
  const chunks = [];
  for (const step of pattern) {
    const n = Math.max(0, Math.round((step.sec || 0) * sampleRate));
    const buf = new Float32Array(n);
    const kind = step.kind || 'silence';
    if (kind === 'tone') {
      const freq = step.freq || 440;
      const amp = step.amp == null ? 0.3 : step.amp;
      for (let i = 0; i < n; i++) {
        // 加一点包络，避免首尾突变造成额外爆音
        const env = Math.min(1, i / 240, (n - i) / 240);
        buf[i] = amp * env * Math.sin((2 * Math.PI * freq * i) / sampleRate);
      }
    } else if (kind === 'noise') {
      const amp = step.amp == null ? 0.2 : step.amp;
      let seed = 12345;
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = amp * ((seed / 0x7fffffff) * 2 - 1);
      }
    }
    chunks.push(buf);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * “静音 + 说话 + 静音”循环——面试场景里最常见的节拍。
 * @param {Object} [o]
 * @param {number} [o.cycles=3]
 * @param {number} [o.silenceSec=0.5]
 * @param {number} [o.speechSec=0.8]
 * @param {number} [o.freq=440]
 * @param {number} [o.amp=0.3]
 */
function synthSpeechLike(o = {}) {
  const {
    cycles = 3,
    silenceSec = 0.5,
    speechSec = 0.8,
    freq = 440,
    amp = 0.3,
    sampleRate = DEFAULT_SAMPLE_RATE,
  } = o;
  const pattern = [];
  for (let i = 0; i < cycles; i++) {
    pattern.push({ sec: silenceSec, kind: 'silence' });
    pattern.push({ sec: speechSec, kind: 'tone', freq, amp });
  }
  pattern.push({ sec: silenceSec, kind: 'silence' });
  return synthPcm(pattern, sampleRate);
}

module.exports = { synthPcm, synthSpeechLike };
