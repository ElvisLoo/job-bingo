'use strict';
/**
 * 能量 VAD 分段器（纯逻辑，无 Electron 依赖，可单测）
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：electron/asr/vad.ts
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）：TS → CommonJS 重写；新增 segmentPcm() 一次性
 *   分段入口并输出 startSec/endSec（原实现只有 Date.now() 时间戳）；新增 Int16Array 输入支持。
 *
 * 算法（沿用原实现）：RMS 能量 + 自适应噪声底。说话帧触发起音，尾部静音累计到
 * hangoverMs 即收句；超过 maxSegmentMs 强制收句（防止长篇独白卡住不吐字）。
 * 系统回环采集的音频很干净（句间是真静音），能量 VAD 足够可靠；将来要换 Silero-VAD
 * 只需替换 isSpeech 判定，状态机不用动。
 */

const { DEFAULT_SAMPLE_RATE, toFloat32Pcm } = require('./contract');

// ---- 可调常量（面试场景实测微调过，默认值沿用原仓库）----
const DEFAULT_VAD_OPTIONS = {
  sampleRate: DEFAULT_SAMPLE_RATE, // 输入必须是 16 kHz 单声道
  /** 尾部静音多久判定“这句话说完了”。太大=反应慢，太小=把换气切成两段 */
  hangoverMs: 300,
  /** 短于此的段直接丢弃（键盘声、咳嗽、爆音） */
  minSpeechMs: 250,
  /** 硬上限：即使对方还在说也强制收句，避免请求体过长、延迟过高 */
  maxSegmentMs: 10000,
  /** 起音前保留多少音频，护住第一个音节（不然“你好”只剩“好”） */
  preRollMs: 300,
  /** 绝对静音门限：RMS 低于它的帧永远不算说话（防止把噪声底抬成 0 后误触发） */
  absSilenceRms: 0.004,
  /** 动态门限 = max(absSilenceRms, 噪声底 * noiseRatio) */
  noiseRatio: 3,
  /** >0 时每 N ms 吐一次实时 partial（0 = 关闭，只在收句时转写） */
  partialIntervalMs: 0,
  /** segmentPcm() 内部切片帧长：20 ms 是延迟与判定精度的一个平衡点 */
  frameMs: 20,
};

/** 一帧的 RMS 能量。 */
function rms(frame) {
  if (!frame || frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

class VadSegmenter {
  constructor(opts = {}) {
    this.opts = Object.assign({}, DEFAULT_VAD_OPTIONS, opts);
    this.inSpeech = false;
    this.silenceMs = 0; // 当前段已累计的尾部静音
    this.speechMs = 0; // 当前段已累计的“有声音”时长
    this.segStartTs = 0;
    this.lastSpeechTs = 0;
    this.lastPartialAtMs = 0;
    this.seg = []; // 当前段已收集的帧
    this.preRoll = []; // 说话前的环形缓冲
    this.preRollMsHeld = 0;
    this.noiseFloor = this.opts.absSilenceRms;
  }

  /** 'idle' | 'speech' */
  get state() {
    return this.inSpeech ? 'speech' : 'idle';
  }

  /** 运行时开关实时 partial（0 = 关）。 */
  setPartialInterval(ms) {
    this.opts = Object.assign({}, this.opts, { partialIntervalMs: ms });
  }

  /** 清空所有状态（切换会议/重新开始采集时调用）。 */
  reset() {
    this.inSpeech = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.segStartTs = 0;
    this.lastSpeechTs = 0;
    this.lastPartialAtMs = 0;
    this.seg = [];
    this.preRoll = [];
    this.preRollMsHeld = 0;
    this.noiseFloor = this.opts.absSilenceRms;
  }

  concatSeg() {
    let total = 0;
    for (const c of this.seg) total += c.pcm.length;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of this.seg) {
      pcm.set(c.pcm, off);
      off += c.pcm.length;
    }
    return pcm;
  }

  /**
   * 推入一帧 PCM（Float32Array 或 Int16Array，长度任意，典型 20~100 ms）。
   * @param {Float32Array|Int16Array} pcm
   * @param {number} captureTs 该帧最后一个采样点的采集时刻（ms）
   * @returns {Array<Object>} 事件数组：speech-start / partial / segment
   */
  push(pcm, captureTs) {
    const o = this.opts;
    const frame = pcm instanceof Float32Array ? pcm : toFloat32Pcm(pcm);
    const frameMs = (frame.length / o.sampleRate) * 1000;
    if (frame.length === 0) return [];

    const level = rms(frame);
    const threshold = Math.max(o.absSilenceRms, this.noiseFloor * o.noiseRatio);
    const speechy = level > threshold;
    const events = [];

    // 自适应噪声底：安静时快速跟随，嘈杂时几乎不抬（避免把持续说话当成噪声）
    if (!speechy) {
      this.noiseFloor = Math.min(this.noiseFloor * 1.02, Math.max(level, o.absSilenceRms / 4));
      if (level < this.noiseFloor) this.noiseFloor = level;
    }

    const chunk = { pcm: frame, ts: captureTs, ms: frameMs };

    if (!this.inSpeech) {
      if (speechy) {
        this.inSpeech = true;
        this.silenceMs = 0;
        this.speechMs = frameMs;
        this.segStartTs = captureTs - frameMs;
        this.lastSpeechTs = captureTs;
        this.seg = this.preRoll.concat([chunk]);
        events.push({ type: 'speech-start', ts: this.segStartTs });
      } else {
        this.preRoll.push(chunk);
        this.preRollMsHeld += frameMs;
        while (this.preRollMsHeld > o.preRollMs && this.preRoll.length > 1) {
          this.preRollMsHeld -= this.preRoll[0].ms;
          this.preRoll.shift();
        }
      }
      return events;
    }

    // ---- 已经处于说话状态 ----
    this.seg.push(chunk);
    if (speechy) {
      this.silenceMs = 0;
      this.speechMs += frameMs;
      this.lastSpeechTs = captureTs;
    } else {
      this.silenceMs += frameMs;
    }

    let segMs = 0;
    for (const c of this.seg) segMs += c.ms;

    if (this.silenceMs >= o.hangoverMs) {
      const ev = this.close('silence');
      if (ev) events.push(ev);
    } else if (segMs >= o.maxSegmentMs) {
      const ev = this.close('maxlen');
      if (ev) events.push(ev);
    } else if (o.partialIntervalMs > 0 && segMs - this.lastPartialAtMs >= o.partialIntervalMs) {
      // 实时 partial：只在实际有声音时吐，别在累计尾部静音时吐
      this.lastPartialAtMs = segMs;
      if (speechy) {
        events.push({ type: 'partial', pcm: this.concatSeg(), startTs: this.segStartTs });
      }
    }
    return events;
  }

  /** 强制收尾（采集停止时调用）。 */
  flush() {
    if (!this.inSpeech) return [];
    const ev = this.close('flush');
    return ev ? [ev] : [];
  }

  close(reason) {
    const o = this.opts;
    const chunks = this.seg;
    const startTs = this.segStartTs;
    const endTs = this.lastSpeechTs;
    const speechMs = this.speechMs;

    this.inSpeech = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.lastPartialAtMs = 0;
    this.seg = [];
    this.preRoll = [];
    this.preRollMsHeld = 0;

    if (speechMs < o.minSpeechMs) return null; // 太短：爆音/点击噪声，丢弃

    let total = 0;
    for (const c of chunks) total += c.pcm.length;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c.pcm, off);
      off += c.pcm.length;
    }
    return { type: 'segment', pcm, startTs, endTs, reason };
  }
}

/**
 * 一次性把整段 PCM 切成若干语音段（离线/单测/批处理用）。
 * 时间基准是音频流自身的采样位置，不是墙钟，因此结果可复现。
 *
 * @param {Float32Array|Int16Array|Buffer} pcmInput 16 kHz 单声道
 * @param {Partial<typeof DEFAULT_VAD_OPTIONS>} [opts]
 * @returns {Array<{index:number, pcm:Float32Array, startSec:number, endSec:number,
 *                  durationSec:number, speechMs:number, reason:string}>}
 */
function segmentPcm(pcmInput, opts = {}) {
  const o = Object.assign({}, DEFAULT_VAD_OPTIONS, opts);
  const pcm = toFloat32Pcm(pcmInput);
  const frameSamples = Math.max(1, Math.round((o.frameMs / 1000) * o.sampleRate));
  const seg = new VadSegmenter(o);
  const out = [];

  const collect = (events) => {
    for (const ev of events) {
      if (ev.type !== 'segment') continue;
      const startSec = ev.startTs / 1000;
      const endSec = ev.endTs / 1000;
      out.push({
        index: out.length,
        pcm: ev.pcm,
        startSec,
        endSec,
        durationSec: Math.max(0, endSec - startSec),
        speechMs: (ev.pcm.length / o.sampleRate) * 1000,
        reason: ev.reason,
      });
    }
  };

  for (let off = 0; off < pcm.length; off += frameSamples) {
    const frame = pcm.subarray(off, Math.min(off + frameSamples, pcm.length));
    const ts = ((off + frame.length) / o.sampleRate) * 1000;
    collect(seg.push(frame, ts));
  }
  collect(seg.flush());
  return out;
}

module.exports = {
  DEFAULT_VAD_OPTIONS,
  VadSegmenter,
  segmentPcm,
  rms,
};
