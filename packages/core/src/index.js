'use strict';
/**
 * @job-bingo/core —— 三端（Windows / Android / 未来的 Web）共享的业务内核。
 * 本目录严禁 import 'electron' 或任何平台专有 API，
 * 这是「借代码不 fork」方案能成立的唯一假设。
 */

const { indexResume, toMarkdown } = require('./resume');
const { buildStablePrefix, buildMessages, buildWarmupMessages } = require('./prompt');
const { validateHintCard, buildRepairInstruction, countCJK } = require('./hint-card');
const { createClient, parseCardObject, classifyError } = require('./llm');
const review = require('./review');

/** 繁忙退避的默认值：每 5 分钟重试一次，最多等 60 分钟 */
const DEFAULT_BUSY = { intervalMs: 5 * 60 * 1000, maxWaitMs: 60 * 60 * 1000 };

/**
 * 等待一段时间，期间支持每秒回调倒计时，并允许上层随时叫停。
 * @returns {Promise<{waitedMs:number}>}
 */
function waitInterval(ms, hooks = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const left = Math.max(0, ms - (Date.now() - startedAt));
      try { hooks.onTick && hooks.onTick({ secondsLeft: Math.ceil(left / 1000) }); } catch (_) {}
    }, 1000);
    const timer = setTimeout(() => {
      clearInterval(tick); clearInterval(stopCheck);
      resolve({ waitedMs: Date.now() - startedAt });
    }, ms);
    const stopCheck = setInterval(() => {
      if (hooks.shouldStop && hooks.shouldStop()) {
        clearInterval(tick); clearInterval(stopCheck); clearTimeout(timer);
        const e = new Error('用户取消了等待');
        e.code = 'ABORTED';
        reject(e);
      }
    }, 300);
  });
}

/**
 * 单次生成（不含繁忙等待）：调模型 → 解析 → 校验 → 带修正指令重试。
 * @returns {Promise<{card:object|null, attempts:number, latencyMs:number, errors:Array, busyError?:object}>}
 */
async function generateOnce(cfgIn) {
  const cfg = cfgIn || {};
  const { question, resume, jd, history, llm } = cfg;
  // FIX: maxAttempts 未夹紧时（配置写错就是一次上百次付费请求 + 每次最多等满超时）必须限制上限
  const asked = Number(cfg.maxAttempts);
  const maxAttempts = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 5) : 3;
  const idx = indexResume(resume || {});
  const prefix = buildStablePrefix(idx.markdown, jd);
  const client = createClient(llm || {});

  const errors = [];
  let lastRaw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = buildMessages({ prefix, question, history });
    if (attempt > 1 && errors.length) {
      messages.push({ role: 'user', content: buildRepairInstruction(errors) });
    }

    const started = Date.now();
    let res;
    try {
      res = await client.chat(messages, { maxTokens: 400 });
    } catch (e) {
      // FIX: 单次网络抖动 / 鉴权失败原本直接抛出，浪费掉后面两次机会，上层只能显示 EXCEPTION
      errors.length = 0;
      errors.push({ code: 'LLM_ERROR', reason: String((e && e.message) || e).slice(0, 200) });
      // 夜间免费额度常被限流：识别出「繁忙」就交给外层等待重试，而不是把机会耗尽
      const cls = classifyError(e);
      if (cls.busy) return { card: null, attempts: attempt, latencyMs: 0, errors, busyError: cls };
      continue;
    }
    lastRaw = res.content;

    let card;
    try {
      card = parseCardObject(res.content);
    } catch (e) {
      errors.length = 0;
      errors.push({ code: 'PARSE', reason: String((e && e.message) || e).slice(0, 200) });
      continue;
    }

    const v = validateHintCard(card, idx.numbers, idx.ids);
    if (v.ok) {
      card.meta = {
        model: client.model,
        latencyMs: Date.now() - started,
        attempt,
        anchorCount: idx.anchors.length,
      };
      return { card, attempts: attempt, latencyMs: Date.now() - started, errors: [] };
    }

    errors.length = 0;
    for (const e of v.errors) errors.push(e);
  }

  return { card: null, attempts: maxAttempts, latencyMs: 0, errors, raw: lastRaw };
}

/**
 * 生成思路卡（含繁忙退避）。
 *
 * 夜间免费额度常被官方限流：遇到 429/503 或「繁忙/拥挤/overloaded」时，
 * 按 cfg.busy.intervalMs（默认 5 分钟）自动重试，直到成功、超过 maxWaitMs 或用户取消。
 * 与 generateOnce 里的「校验重试」职责分离：前者等额度，后者纠格式。
 *
 * @param {object} cfg  同 generateOnce，额外支持：
 *   @param {object} [cfg.busy]  {intervalMs, maxWaitMs}
 *   @param {object} [cfg.hooks] {onBusy, onTick, onRetry, shouldStop}
 * @throws 用户取消时抛出 code='ABORTED' 的错误
 */
async function generateHintCard(cfgIn) {
  const cfg = cfgIn || {};
  const hooks = cfg.hooks || {};
  const busyCfg = Object.assign({}, DEFAULT_BUSY, cfg.busy || {});
  const deadline = Date.now() + busyCfg.maxWaitMs;
  let busyRounds = 0;

  for (;;) {
    const r = await generateOnce(cfg);
    if (r.card || !r.busyError) {
      return Object.assign({}, r, { busyRounds });
    }

    busyRounds++;
    const waitMs = busyCfg.intervalMs;
    if (Date.now() + waitMs > deadline) {
      return {
        card: null,
        attempts: r.attempts,
        latencyMs: 0,
        busyRounds,
        timedOut: true,
        errors: [{ code: 'BUSY_TIMEOUT', reason: `已重试 ${busyRounds} 轮仍繁忙：${r.busyError.reason}` }],
      };
    }

    try {
      hooks.onBusy && hooks.onBusy({
        round: busyRounds, waitMs, reason: r.busyError.reason, status: r.busyError.status,
      });
    } catch (_) {}

    await waitInterval(waitMs, hooks); // 用户取消 → throw ABORTED
    try { hooks.onRetry && hooks.onRetry({ round: busyRounds }); } catch (_) {}
  }
}

/** 预热 provider 的 KV cache，面试开始前调一次，之后每题首 token 更快 */
async function warmup(llm, resume, jd) {
  const idx = indexResume(resume || {});
  const prefix = buildStablePrefix(idx.markdown, jd);
  const client = createClient(llm || {});
  const started = Date.now();
  await client.chat(buildWarmupMessages(prefix), { maxTokens: 1, temperature: 0 });
  return { latencyMs: Date.now() - started, prefixBytes: Buffer.byteLength(prefix, 'utf8') };
}

/** 无 API Key 时的演示卡：结构完全真实，只是内容来自本地模板 */
function mockHintCard(question) {
  const q = String(question || '')
    // FIX: 问题原文以问号/句号结尾时，演示卡第一条会带句末标点，被自家校验器判成成稿
    .replace(/[。！？；.!?;，,、…]+$/, '')
    .trim()
    .slice(0, 14);
  return {
    anchor: { resumeId: null, label: '未配置模型 · 演示卡' },
    points: [
      { kind: 'fact', text: `识别到：${q || '未识别到问题'}` },
      { kind: 'path', text: '在设置里填入 API 即出真卡' },
      { kind: 'key', text: '要点 ≤18 字，无句号，不代答' },
    ],
    caution: '当前为演示模式',
    meta: { model: 'mock', latencyMs: 0, attempt: 0, anchorCount: 0 },
  };
}

module.exports = {
  // ---- 复盘（M4）----
  generateReview: review.generateReview,
  normalizeTranscript: review.normalizeTranscript,
  validateReview: review.validateReview,
  localReview: review.localReview,
  reviewToMarkdown: review.reviewToMarkdown,
  buildReviewMessages: review.buildReviewMessages,

  generateHintCard,
  generateOnce,
  waitInterval,
  warmup,
  mockHintCard,
  indexResume,
  toMarkdown,
  buildStablePrefix,
  buildMessages,
  buildWarmupMessages,
  validateHintCard,
  buildRepairInstruction,
  countCJK,
  createClient,
  parseCardObject,
  classifyError,
  waitInterval,
};
