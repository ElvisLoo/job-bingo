'use strict';
/**
 * 双轨回声门（Echo Gate）—— 解决「自己说话被系统回环收进去」这个头号误报源。
 *
 * 场景：面试时同时开
 *   ① 系统混音（回环）：包含对方的声音，也包含你自己的声音 —— 因为你的声音
 *      从扬声器/耳机漏出或经会议软件本地混音后同样会出现在系统输出里；
 *   ② 麦克风：只有你的声音。
 *
 * 如果不处理，你自己在回答问题时会不断被自己的话触发新卡片，
 * 这是回环方案最致命的体验缺陷（也是同类产品最常见的翻车点）。
 *
 * 做法（纯能量域，不引入任何模型，可测试、可解释）：
 *   把两路 PCM 按 100 ms 帧对齐，逐帧比较能量。判为「我方发言」需同时满足：
 *      · 麦克风帧高于底噪 → 确实有人在本地说话；
 *      · 回环帧比麦克风帧低 X dB → 说明回环这一路不是本地声源在主导；
 *   这里的直觉是：本地说话时麦克风贴近声源，能量显著高于回环；
 *   对方说话时麦克风基本安静或只有很弱的泄漏，回环明显更强。
 *
 * 这只是一个「门」，不做任何识别：判为我方时只把该段文本标记为 role='me'
 * 进上下文（用于 LLM 消歧），不生成卡片，也不做语音代答。
 */

/** dBFS：20 * log10(rms)，rms=0 时返回 -120 */
function dbfs(rms) {
  if (!(rms > 0)) return -120;
  return 20 * Math.log10(Math.max(rms, 1e-6));
}

function rmsOf(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / Math.max(1, frame.length));
}

/**
 * 动态底噪跟踪：噪声底只会缓慢上升（泄漏/风扇），下降时快速跟随，
 * 避免安静环境被前几帧的异常值抬高。
 */
class NoiseFloor {
  constructor(initial = 0.0012, { upAlpha = 0.02, downAlpha = 0.35 } = {}) {
    this.value = initial;
    this.upAlpha = upAlpha;
    this.downAlpha = downAlpha;
  }
  observe(rms) {
    if (!(rms > 0)) return this.value;
    const a = rms > this.value ? this.upAlpha : this.downAlpha;
    this.value = this.value + a * (rms - this.value);
    return this.value;
  }
  reset(v) { this.value = v == null ? 0.0012 : v; }
}

class DualTrackEchoGate {
  /**
   * @param {object} [opts]
   * @param {number} [opts.micAboveFloorDb] 麦克风需高于底噪多少 dB 才算「本地有人在说话」，默认 9
   * @param {number} [opts.micDominanceDb]  麦克风比回环高多少 dB 才判为我方，默认 4
   * @param {number} [opts.absentFloorDb]   麦克风低于底噪多少 dB 视为「麦克风无信号」，默认 6
   * @param {number} [opts.absoluteFloorDb] 麦克风绝对电平高于此值即认为有人在说话（-45 dBFS）
   * @param {number} [opts.holdMs]          胜者保持时长，避免逐字抖动导致来回翻转，默认 600
   */
  constructor(opts = {}) {
    this.micAboveFloorDb = opts.micAboveFloorDb != null ? opts.micAboveFloorDb : 9;
    this.micDominanceDb = opts.micDominanceDb != null ? opts.micDominanceDb : 4;
    this.absentFloorDb = opts.absentFloorDb != null ? opts.absentFloorDb : 6;
    this.absoluteFloorDb = opts.absoluteFloorDb != null ? opts.absoluteFloorDb : -45;
    // 低于此 RMS 视为麦克风没有接上信号（约 -80 dBFS，正常语音远高于此）
    this.absentRms = opts.absentRms != null ? opts.absentRms : 1e-4;
    this.holdMs = opts.holdMs != null ? opts.holdMs : 600;

    this.micFloor = new NoiseFloor();
    this.loopFloor = new NoiseFloor();

    this.lastVerdict = 'unknown'; // 'me' | 'them' | 'silence' | 'unknown'
    this.lastDecidedAt = 0;
    this.stats = { frames: 0, me: 0, them: 0, silence: 0 };
  }

  /**
   * 用同一时间窗内的两路 PCM 判定说话人。
   * @param {Float32Array} micPcm  麦克风（可为 null：未接麦克风时退化为「不做判定」）
   * @param {Float32Array} loopPcm 回环（系统混音）
   * @param {number} [now]
   * @returns {{role:'me'|'them'|'unknown'|'silence', micDb:number, loopDb:number, reason:string}}
   */
  classify(micPcm, loopPcm, now = Date.now()) {
    this.stats.frames++;
    // 允许直接传 RMS（number）：调用方已经算好能量时不必再包一层数组。
    // 早期版本只认数组，调用方传标量会被当成「无信号」，静默判成 unknown。
    const loopRms = toRms(loopPcm);
    const micRmsIn = toRms(micPcm);
    const hasMic = micPcm != null && micPcm !== '';
    const loopDb = dbfs(loopRms);
    this.loopFloor.observe(loopRms);

    if (!hasMic) {
      // 没有麦克风轨：无从判断，一律交给回环（这是 v0.1 的既有行为）
      this.stats.them++;
      return this._decide('unknown', loopDb, loopDb, 'no-mic-track', now);
    }

    const micRms = micRmsIn;
    const micDb = dbfs(micRms);
    this.micFloor.observe(micRms);
    const floorDb = dbfs(this.micFloor.value);
    void this.absentFloorDb; // 保留参数以兼容旧调用，判定已改用绝对阈值

    // 麦克风几乎数字静音（未选中正确设备 / 被系统静音）：不能据此吞掉对方的问题。
    // 只用绝对阈值判断，不用「低于底噪」判断：冷启动时底噪尚未收敛，
    // 用相对判断会把真实语音误当成「无信号」。
    if (micRms < this.absentRms) {
      this.stats.them++;
      return this._decide('unknown', micDb, loopDb, 'mic-silent', now);
    }

    // 两条判据取「或」：相对底噪判断抗设备增益差异，绝对电平判断防冷启动时
    // 底噪还没收敛（一上来就是强音，把 noiseFloor 抬高，导致后面再也判不出 me）。
    const micActive = micDb > floorDb + this.micAboveFloorDb || micDb > this.absoluteFloorDb;
    const micDominant = micDb - loopDb > this.micDominanceDb;

    if (micActive && micDominant) {
      // 保持窗口：刚判为我方后的一小段时间内不轻易翻转
      this.stats.me++;
      return this._decide('me', micDb, loopDb, 'mic-dominant', now);
    }
    if (!micActive && loopDb < -60) {
      this.stats.silence++;
      return this._decide('silence', micDb, loopDb, 'all-quiet', now);
    }
    this.stats.them++;
    return this._decide('them', micDb, loopDb, micActive ? 'loop-dominant' : 'mic-quiet', now);
  }

  _decide(role, micDb, loopDb, reason, now) {
    // 保持窗口只作用于「me ↔ them」的翻转；unknown/silence 不锁
    const reversible = role === 'me' || role === 'them';
    const prev = this.lastVerdict;
    if (reversible && (prev === 'me' || prev === 'them') && prev !== role && now - this.lastDecidedAt < this.holdMs) {
      return { role: prev, micDb: round1(micDb), loopDb: round1(loopDb), reason: 'hold:' + reason };
    }
    if (role !== 'silence') this.lastDecidedAt = now;
    this.lastVerdict = role === 'silence' ? this.lastVerdict : role;
    return { role, micDb: round1(micDb), loopDb: round1(loopDb), reason };
  }

  reset() {
    this.micFloor.reset();
    this.loopFloor.reset();
    this.lastVerdict = 'unknown';
    this.lastDecidedAt = 0;
    this.stats = { frames: 0, me: 0, them: 0, silence: 0 };
  }
}

/** 数组 → RMS；数字直接当作 RMS；其他视为无信号 */
function toRms(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? Math.max(0, x) : 0;
  if (x && typeof x.length === 'number') return rmsOf(x);
  return null;
}

function round1(v) { return Math.round(v * 10) / 10; }

module.exports = { DualTrackEchoGate, NoiseFloor, dbfs, rmsOf };
