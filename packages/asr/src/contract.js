'use strict';
/**
 * ASR 引擎统一契约（纯 CommonJS，不含任何 Electron 依赖）
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：electron/asr/contract.ts、electron/asr/engine.ts
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）：TS 接口改写为运行时校验的 JS 工厂函数，
 *   去掉 worker_threads / utilityProcess 通信层，只保留引擎实现必须遵守的最小契约。
 */

/** 本项目统一采样率：16 kHz（Whisper / 各家云 ASR 的通用输入） */
const DEFAULT_SAMPLE_RATE = 16000;

/** 契约版本号：一旦 transcribe 的输入输出形状变更就必须 +1，方便上层做兼容判断 */
const CONTRACT_VERSION = 1;

/**
 * @typedef {Object} TranscribeSegment
 * @property {number} startSec 相对该段音频起点的秒数
 * @property {number} endSec
 * @property {string} text
 */

/**
 * @typedef {Object} TranscribeResult
 * @property {string} text           最终文本（已 trim）
 * @property {TranscribeSegment[]} [segments]  句级时间戳，引擎不支持时为 undefined
 * @property {number} latencyMs      本次转写耗时（由 createEngine 兜底填充）
 * @property {string} [lang]         'chinese' | 'english' | BCP-47
 * @property {string} [engine]       引擎名，便于日志排障
 */

/**
 * @typedef {Object} AsrEngine
 * @property {string} name
 * @property {(pcmChunks: any, opts?: Object) => Promise<TranscribeResult>} transcribe
 */

function isPcmBufferLike(v) {
  return (
    v instanceof Float32Array ||
    v instanceof Int16Array ||
    v instanceof Uint8Array ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
  );
}

/**
 * 把任意允许的输入归一化成 Float32Array（值域 [-1, 1]）。
 * 允许：Float32Array / Int16Array / Uint8Array(Int16-LE 原始字节) / Buffer / 以上类型的数组。
 */
function toFloat32Pcm(input) {
  if (input == null) return new Float32Array(0);
  if (input instanceof Float32Array) return input;
  if (input instanceof Int16Array) {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = input[i] / 32768;
    return out;
  }
  if (Array.isArray(input)) {
    // 多段拼接：先算总长再一次分配，避免反复扩容
    const parts = input.map(toFloat32Pcm);
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
    return int16BytesToFloat32(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof Uint8Array) {
    return int16BytesToFloat32(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('unsupported PCM input type: ' + Object.prototype.toString.call(input));
}

/** 把一小端 Int16 字节序列解成 Float32；长度按偶数截断，避免未对齐访问。 */
function int16BytesToFloat32(arrayBuffer, byteOffset, byteLength) {
  const n = Math.floor(byteLength / 2);
  const copy = arrayBuffer.slice(byteOffset, byteOffset + n * 2);
  const i16 = new Int16Array(copy);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i16[i] / 32768;
  return out;
}

/** Float32（或 Int16）转 Int16-LE Buffer，用于 WAV 封装 / 网络传输。 */
function toPcm16Buffer(input) {
  if (input instanceof Int16Array) {
    const copy = new Int16Array(input.length);
    copy.set(input);
    return Buffer.from(copy.buffer, copy.byteOffset, copy.length * 2);
  }
  const f32 = toFloat32Pcm(input);
  const buf = Buffer.allocUnsafe(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0, i * 2);
  }
  return buf;
}

/** 采样点数（不解码，只看长度，开销低）。 */
function pcmSampleCount(input) {
  if (input == null) return 0;
  if (Array.isArray(input)) {
    let n = 0;
    for (const c of input) n += pcmSampleCount(c);
    return n;
  }
  if (input instanceof Float32Array || input instanceof Int16Array) return input.length;
  if (isPcmBufferLike(input)) return Math.floor(input.byteLength / 2);
  return 0;
}

/** 音频时长（秒）。 */
function pcmDurationSec(input, sampleRate = DEFAULT_SAMPLE_RATE) {
  return pcmSampleCount(input) / sampleRate;
}

/** 把引擎原始返回值规整成契约形状。 */
function normalizeTranscribeResult(raw, startedAtMs, engineName) {
  if (raw == null || typeof raw !== 'object') {
    throw new TypeError(`engine "${engineName}" must resolve an object, got ${raw}`);
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const out = {
    text,
    latencyMs: Number.isFinite(raw.latencyMs) ? raw.latencyMs : Date.now() - startedAtMs,
    engine: raw.engine || engineName,
  };
  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    out.segments = raw.segments.map((s) => ({
      startSec: Number(s.startSec) || 0,
      endSec: Number(s.endSec) || 0,
      text: typeof s.text === 'string' ? s.text : '',
    }));
  }
  if (raw.lang) out.lang = raw.lang;
  if (raw.error) out.error = raw.error;
  return out;
}

/**
 * 把一个裸转写函数包装成符合契约的引擎：负责计时、结果规整、异常加引擎名前缀。
 * @param {{name: string, transcribe: Function, close?: Function}} impl
 * @returns {AsrEngine}
 */
function createEngine(impl) {
  if (!impl || typeof impl.transcribe !== 'function') {
    throw new TypeError('createEngine needs an impl with a transcribe() function');
  }
  const name = impl.name || 'anonymous';
  const engine = {
    name,
    async transcribe(pcmChunks, opts = {}) {
      const t0 = Date.now();
      const raw = await impl.transcribe(pcmChunks, opts);
      return normalizeTranscribeResult(raw, t0, name);
    },
  };
  if (typeof impl.close === 'function') engine.close = impl.close.bind(impl);
  if (typeof impl.warmup === 'function') engine.warmup = impl.warmup.bind(impl);
  return engine;
}

/** 契约自检：上层拿到未知引擎时可先断言一次，避免运行时才炸。 */
function assertEngine(engine) {
  if (!engine || typeof engine.transcribe !== 'function') {
    throw new TypeError('not an ASR engine: missing transcribe()');
  }
  if (typeof engine.name !== 'string' || !engine.name) {
    throw new TypeError('ASR engine must expose a non-empty .name');
  }
  return engine;
}

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_SAMPLE_RATE,
  // 契约
  createEngine,
  assertEngine,
  normalizeTranscribeResult,
  // PCM 工具
  toFloat32Pcm,
  toPcm16Buffer,
  pcmSampleCount,
  pcmDurationSec,
  isPcmBufferLike,
};
