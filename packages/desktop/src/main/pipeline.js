'use strict';
/**
 * 集成流水线：ASR 文本 → 提问判定 → 去重 → 生成思路卡 → 推送浮窗。
 *
 * 存在的意义是把「接哪种音频源」和「怎么变成卡片」解耦：
 * 电脑回环、电脑麦克风、手机端、甚至手动输入，全部汇流到 ingest()，
 * 之后的行为完全一致。M1 接上真 ASR 时只需替换调用方，本文件不用大改。
 */
const core = require('@job-bingo/core');

// ASR 层可选：装了就走真转写，没装或加载失败降级为文本输入模式。
let asr = null;
try { asr = require('@job-bingo/asr'); } catch (_) { asr = null; }

// 中文提问的语言特征。面试场景里 80% 的发言是对方在提问，
// 这个启发式用来避免把自己的回答也当成新问题去生成卡片。
const QUESTION_HINT = /[?？]|吗|呢|什么|怎么|怎样|如何|为什么|讲一讲|讲讲|说说|说一说|介绍|描述|谈谈|聊聊|举例|举个例子|能否|能不能|可以不可以|请/;

// 祈使式追问往往没有疑问词，例如「继续」「还有呢」「说具体一点」
const PROBE_HINT = /^(继续|还有|然后呢|具体|再说|详细|重复|举个)/;

const MOCK_INTERVAL_MS = 9000; // 模拟采集的提问间隔
const MOCK_QUESTIONS = [
  '请先做一个自我介绍',
  '说说你处理过最复杂的一次系统故障',
  '库存成本出现负数余额，你会怎么定位根因',
  '你为什么离开上一家公司',
  '如果让你搭建公司的数据备份体系，你会怎么做',
  '你期望的薪资是多少',
];

const MIN_GAP_MS = 2200;      // 同一问题的最小重触发间隔，防止 ASR 重复出字刷屏
const MIN_TEXT_LEN = 4;       // 太短的片段基本是噪音或语气词
const MAX_HISTORY = 6;        // 上下文轮数（与 core/prompt.js 的 slice(-6) 对应）

function normalize(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[，。、,.!！;；:：~～]/g, '');
}

function isQuestion(text) {
  const t = normalize(text);
  return QUESTION_HINT.test(t) || PROBE_HINT.test(t);
}

/** 两段文本的相似度（简单 Jaccard，按字），用于去重 */
function similarity(a, b) {
  const sa = new Set(normalize(a).split(''));
  const sb = new Set(normalize(b).split(''));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter++;
  return inter / (sa.size + sb.size - inter);
}

class Pipeline {
  /**
   * @param {object} ctx
   * @param {() => object} ctx.getConfig  返回当前配置（含 llm / jd）
   * @param {() => object|null} ctx.getResume
   * @param {(payload:object) => void} ctx.pushCard
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.history = [];
    this.running = false;
    this.source = 'none';
    this.lastAskAt = 0;
    this.lastQuestion = '';
    this.inflight = false;
    this.stats = { ingested: 0, droppedShort: 0, droppedDup: 0, droppedOwn: 0, generated: 0, busyWaits: 0 };
    // 全场记录（不裁剪），只供复盘使用。history 会截断到 6 轮，不能拿它复盘。
    this.transcript = [];
    this.router = null;
    this.mockQIndex = 0;
    this.cancelWaiting = false;
  }

  start(source) {
    this.running = true;
    this.source = source || 'desktop';
    this.ctx.pushCard({ type: 'status', text: `采集已开始 · ${this.source}` });

    // 模拟采集：真 ASR 接进来之前，用它演示完整链路（浮窗自动出题、自动出卡）
    if (this.source === 'mock') {
      if (this.mockTimer) clearInterval(this.mockTimer);
      let i = 0;
      this.mockTimer = setInterval(() => {
        if (!this.running || this.source !== 'mock') return;
        const q = MOCK_QUESTIONS[i % MOCK_QUESTIONS.length];
        i++;
        this.ingest(q, { role: 'them', force: true, from: 'mock' });
      }, MOCK_INTERVAL_MS);
      this.mockTimer.unref?.();
    }
    return { ok: true, source: this.source };
  }

  stop() {
    this.running = false;
    this.source = 'none';
    if (this.mockTimer) { clearInterval(this.mockTimer); this.mockTimer = null; }
    this.ctx.pushCard({ type: 'status', text: '采集已停止' });
    return { ok: true };
  }

  status() {
    return {
      running: this.running,
      source: this.source,
      inflight: this.inflight,
      historyLen: this.history.length,
      lastQuestion: this.lastQuestion,
      waiting: !!this.waitingBusy,
      stats: { ...this.stats },
    };
  }

  /**
   * 接收一段转写文本。
   * @param {string} text
   * @param {object} [opts]
   * @param {'them'|'me'} [opts.role] 说话人（未来双轨直分；当前来自手机端标注或启发式）
   * @param {boolean} [opts.force] 手动输入，跳过提问判定与去重
   * @param {boolean} [opts.final] 是否是该 segment 的最终文本（ASR 中间结果不要触发）
   */
  async ingest(text, opts = {}) {
    const clean = String(text || '').trim();
    this.stats.ingested++;
    if (!clean) return { skipped: 'empty' };

    const { role = 'them', force = false, final = true } = opts;

    // 自己的发言只进上下文，不生成卡片
    if (role === 'me') {
      this.stats.droppedOwn++;
      this.history.push({ role: 'me', text: clean });
      this.logTranscript('me', clean);
      this.trimHistory();
      return { skipped: 'own-voice' };
    }

    if (!final) return { skipped: 'interim' };
    if (!force && clean.length < MIN_TEXT_LEN) { this.stats.droppedShort++; return { skipped: 'too-short' }; }
    if (!force && !isQuestion(clean)) { this.stats.droppedShort++; return { skipped: 'not-question' }; }

    const now = Date.now();
    if (!force && this.inflight) return { skipped: 'busy' };
    if (!force && now - this.lastAskAt < MIN_GAP_MS) return { skipped: 'too-soon' };
    if (!force && similarity(clean, this.lastQuestion) > 0.72) { this.stats.droppedDup++; return { skipped: 'duplicate' }; }

    this.inflight = true;
    this.lastAskAt = now;
    this.lastQuestion = clean;
    this.history.push({ role: 'them', text: clean });
    this.trimHistory();
    this.logTranscript('them', clean);

    try {
      const cfg = this.ctx.getConfig();

      // 未配置 Key 时走演示卡，保证产品开箱可见，而不是抛网络错误
      if (!cfg.llm?.apiKey) {
        const card = core.mockHintCard(clean);
        this.stats.generated++;
        this.ctx.pushCard({ type: 'card', card, question: clean, from: opts.from || this.source });
        return { ok: true, card, mocked: true, attempts: 0 };
      }

      const busy = cfg.busy || {};
      const state = { round: 0 };

      const r = await core.generateHintCard({
        question: clean,
        resume: this.ctx.getResume() || {},
        jd: cfg.jd,
        history: this.history.slice(0, -1),
        llm: cfg.llm,
        // 夜间免费额度被限流时：每 N 分钟自动重试，直到成功/超时/用户取消
        busy: {
          intervalMs: Math.max(1, Number(busy.retryMinutes) || 5) * 60 * 1000,
          maxWaitMs: Math.max(1, Number(busy.maxWaitMinutes) || 60) * 60 * 1000,
        },
        hooks: {
          onBusy: (info) => {
            state.round = info.round;
            this.stats.busyWaits++;
            this.waitingBusy = true;
            this.ctx.pushCard({
              type: 'busy', phase: 'wait', question: clean,
              round: info.round, waitMs: info.waitMs, reason: info.reason,
              secondsLeft: Math.round(info.waitMs / 1000),
            });
          },
          onTick: (t) => {
            this.ctx.pushCard({
              type: 'busy', phase: 'tick', question: clean,
              round: state.round, secondsLeft: t.secondsLeft,
            });
          },
          onRetry: (info) => {
            this.ctx.pushCard({ type: 'busy', phase: 'retry', question: clean, round: info.round });
          },
          shouldStop: () => this.cancelWaiting === true,
        },
      });

      const from = opts.from || this.source;
      if (!r.card) {
        this.ctx.pushCard({ type: 'error', errors: r.errors, question: clean, from });
        return { ok: false, errors: r.errors };
      }
      this.stats.generated++;
      this.ctx.pushCard({ type: 'card', card: r.card, question: clean, source: this.source, from: this.source });
      return { ok: true, card: r.card, attempts: r.attempts };
    } catch (e) {
      // 用户主动叫停等待：不算失败，只是放弃这次出卡
      if (e && e.code === 'ABORTED') {        this.ctx.pushCard({ type: 'status', text: '已停止等待模型' });
        return { skipped: 'cancelled' };
      }
      this.ctx.pushCard({ type: 'error', errors: [{ code: 'EXCEPTION', reason: String(e.message).slice(0, 200) }], question: clean });
      return { ok: false, error: String(e.message).slice(0, 200) };
    } finally {
      this.inflight = false;
      this.waitingBusy = false;
      this.cancelWaiting = false;
    }
  }

  /** 用户叫停当前的繁忙等待（下一次 ingest 前生效） */
  cancelBusyWait() {
    if (!this.waitingBusy) return { ok: false, waiting: false };
    this.cancelWaiting = true;
    return { ok: true };
  }

  /**
   * ASR 是否可用（供 UI 提示）
   */
  get asrAvailable() {
    return !!asr;
  }

  /** 按需创建 ASR 路由；未配 Key 时用离线 mock 引擎 */
  ensureAsr() {
    if (!asr) throw new Error('ASR 层未加载（packages/asr 缺失）');
    if (!this.router) {
      const cfg = this.ctx.getConfig();
      const asrCfg = cfg.asr || {};
      this.router = asr.createAsrRouter({
        cloudConfig: {
          baseUrl: asrCfg.baseUrl || cfg.llm?.baseUrl,
          apiKey: asrCfg.apiKey || cfg.llm?.apiKey,
          model: asrCfg.model || 'whisper-1',
        },
      });
    }
    return this.router;
  }

  /**
   * 把一段 WAV（Buffer）喂进来：VAD 分段 → 逐段转写 → 逐段 ingest。
   * 用于已录制好的音频；实时采集请用 feedWavSegment（那边已分段，别切第二遍）。
   */
  /**
   * 外部音频（手机按住说话、导入的 WAV）。
   *
   * @param {Buffer|Uint8Array} wavBuffer
   * @param {object} [opts]
   * @param {'me'|'them'} [opts.role] 说话人，**默认 'me'**。
   *   外部音频入口（手机按住说话、导入 WAV）录到的首先是你自己的声音，
   *   默认按 me 处理才不会把自己的回答当成面试官的新问题——
   *   这正是双轨回声门要解决的问题，不能因为换了入口就绕过去。
   *   确实要录对方（把手机递到扬声器前）时显式传 'them'。
   * @param {boolean} [opts.split] 是否再切一次段。手机端录的已是一句话，
   *   再切会把一句拆成几段分别转写，既慢又容易把同义句判成两个问题。
   */
  async feedWav(wavBuffer, opts = {}) {
    if (!asr) return { ok: false, error: 'ASR 层未加载' };
    this.ensureAsr();

    const role = opts.role === 'them' ? 'them' : 'me';
    const pcm = asr.decodeWav16kMono(wavBuffer);
    if (!pcm || !pcm.length) {
      this.ctx.pushCard({ type: 'status', text: '未检测到语音段' });
      return { ok: true, segments: 0, results: [] };
    }
    const split = opts.split !== false;
    const segments = split ? asr.segmentPcm(pcm) : [{ pcm }];
    if (!segments.length) {
      this.ctx.pushCard({ type: 'status', text: '未检测到语音段' });
      return { ok: true, segments: 0, results: [] };
    }
    const results = [];
    for (const seg of segments) results.push(await this.feedPcm(seg.pcm, { role }));
    return { ok: true, segments: segments.length, results, role };
  }

  /** 已经是一段完整语音（实时采集路径）：直接转写 + 出卡 */
  async feedWavSegment(wavBuffer, opts = {}) {
    if (!asr) return { ok: false, error: 'ASR 层未加载' };
    this.ensureAsr();
    const pcm = asr.decodeWav16kMono(wavBuffer);
    const r = await this.feedPcm(pcm, opts);
    return { ok: true, segments: 1, results: [r] };
  }

  /**
   * 转写一段 PCM 并走完 ingest（含演示文本兜底）。
   * @param {Float32Array|Int16Array} pcm
   * @param {object} [opts]
   * @param {'them'|'me'} [opts.role] 双轨回声门判定的说话人。
   *   'me' 时**只做转写并写入上下文**，不生成卡片 —— 这是回环方案能用的前提：
   *   否则你自己的回答也会被系统混音收回来，触发一张张无关的卡。
   */
  async feedPcm(pcm, opts = {}) {
    const role = opts.role === 'me' ? 'me' : 'them';
    this.ensureAsr();
    let res = null;
    try {
      res = await this.router.transcribe(pcm, { sampleRate: 16000 });
    } catch (e) {
      res = { text: '', engine: 'error', error: e.message };
    }

    // 离线 mock 引擎返回的是占位文本，演示时用预设问题替代，
    // 否则整条链路跑通了却看不出意义。
    let text = String(res.text || '').trim();
    // 我方语音不套演示问题：那不是「识别失败」，是刻意不进卡片
    if (role !== 'me' && (!text || res.engine === 'mock' || res.degradedFrom === 'cloud')) {
      text = MOCK_QUESTIONS[(this.mockQIndex++) % MOCK_QUESTIONS.length];
    }
    if (!text) {
      return { durationSec: Number((pcm.length / 16000).toFixed(2)), engine: res.engine, text: '', role, skipped: 'empty' };
    }

    await this.ingest(text, { role, force: role === 'them', from: 'asr' });
    return { durationSec: Number((pcm.length / 16000).toFixed(2)), engine: res.engine, text, role };
  }

  /** 写入全场记录（带时间戳，复盘时能看出节奏） */
  logTranscript(role, text) {
    if (!this.transcript) this.transcript = [];
    this.transcript.push({ role, text: String(text || '').slice(0, 2000), at: Date.now() });
    // 上限 500 条：一场面试远不到这个量，纯粹防止长时间运行时无限增长
    if (this.transcript.length > 500) this.transcript = this.transcript.slice(-500);
  }

  /** 供复盘读取的快照 */
  getTranscript() {
    return Array.isArray(this.transcript) ? this.transcript.slice() : [];
  }

  trimHistory() {
    if (this.history.length > MAX_HISTORY * 2) {
      this.history = this.history.slice(-MAX_HISTORY * 2);
    }
  }

  reset() {
    this.history = [];
    this.transcript = [];
    this.lastQuestion = '';
    this.lastAskAt = 0;
  }
}

module.exports = { Pipeline, isQuestion, similarity, normalize, QUESTION_HINT, PROBE_HINT };
