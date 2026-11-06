'use strict';
/**
 * usage.js — Token 用量与费用统计（纯函数，不依赖 electron / 网络）
 *
 * 为什么需要它：
 *   用户为每一场面试付真金白银，但界面只显示「出了几张卡」。
 *   不知道花了多少，就没法判断「这个模型值不值」。
 *
 * 三条设计原则：
 *  1. **不猜价格**：内置常见模型的公开单价，但允许用户自定义；
 *     未收录的模型标记为 unknown，只统计 token 不算钱，绝不瞎估。
 *  2. **缓存价单独算**：多数供应商的命中缓存输入价是普通输入价的 1/4 甚至 1/10，
 *     混在一起算会让账单明显偏高。
 *  3. **金额取整到分**：浮点累加会飘出 0.30000000000000004 这种数字，
 *     内部一律按「厘」(0.001 元) 存整数，展示时再换算。
 */

const MILLI_PER_YUAN = 1000; // 1 元 = 1000 厘，内部按厘存整数避免浮点累加误差

/**
 * 常见模型单价（元 / 每百万 token）
 * 数据来源：各厂公开定价页，2026-11 抓取。
 * 用户可以在设置里覆盖，这里只是默认值。
 */
const PRICING = {
  // DeepSeek
  'deepseek-chat': { in: 2, cacheHit: 0.5, out: 8 },
  'deepseek-reasoner': { in: 4, cacheHit: 1, out: 16 },
  // 通义千问
  'qwen-plus': { in: 0.8, cacheHit: 0.8, out: 2 },
  'qwen-max': { in: 2.4, cacheHit: 2.4, out: 9.6 },
  'qwen-turbo': { in: 0.3, cacheHit: 0.3, out: 0.6 },
  // Kimi
  'moonshot-v1-8k': { in: 12, cacheHit: 12, out: 12 },
  'moonshot-v1-32k': { in: 24, cacheHit: 24, out: 24 },
  // 智谱
  'glm-4-flash': { in: 0, cacheHit: 0, out: 0 },
  'glm-4-plus': { in: 50, cacheHit: 50, out: 50 },
  // OpenAI（按 7.2 汇率折算，仅作参考）
  'gpt-4o-mini': { in: 1.08, cacheHit: 0.54, out: 4.32 },
  'gpt-4o': { in: 18, cacheHit: 9, out: 72 }
};

/** 把 "glm-4-plus-20260101" 这类带日期的模型名归一到基础名 */
function normalizeModel(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  if (PRICING[n]) return n;
  // 去掉末尾的 -YYYYMMDD 或 -YYYY-MM-DD
  const stripped = n.replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
  if (PRICING[stripped]) return stripped;
  // 以已知模型名开头也算（如 deepseek-chat-v3）
  const hit = Object.keys(PRICING).find((k) => n.startsWith(k));
  return hit || n;
}

/**
 * 查单价
 * @returns {{in:number, cacheHit:number, out:number, known:boolean}}
 */
function priceOf(model, overrides) {
  const key = normalizeModel(model);
  const custom = overrides && overrides[key];
  const p = custom || PRICING[key];
  if (!p) {
    return { in: 0, cacheHit: 0, out: 0, known: false };
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    in: num(p.in),
    cacheHit: num(p.cacheHit != null ? p.cacheHit : p.in),
    out: num(p.out),
    known: true
  };
}

/**
 * 从 OpenAI 兼容的 usage 对象里抽出四类 token
 * 各家字段名不完全一致，这里做兼容：
 *   prompt_tokens / input_tokens
 *   completion_tokens / output_tokens
 *   prompt_tokens_details.cached_tokens / cache_read_input_tokens
 */
function parseUsage(usage) {
  const u = usage || {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };

  const prompt = num(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens);
  const completion = num(u.completion_tokens != null ? u.completion_tokens : u.output_tokens);

  let cached = 0;
  if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens != null) {
    cached = num(u.prompt_tokens_details.cached_tokens);
  } else if (u.cache_read_input_tokens != null) {
    cached = num(u.cache_read_input_tokens);
  } else if (u.cached_tokens != null) {
    cached = num(u.cached_tokens);
  }

  // 缓存命中的部分已经含在 prompt 里，算钱时要拆开，避免重复计费
  if (cached > prompt) cached = prompt;

  return { prompt, completion, cached, total: prompt + completion };
}

/**
 * 算一次调用的费用（单位：厘）
 */
function costOf(usage, model, overrides) {
  const u = parseUsage(usage);
  const p = priceOf(model, overrides);

  if (!p.known) {
    return { ...u, costMilli: 0, known: false, model: normalizeModel(model) };
  }

  const freshPrompt = u.prompt - u.cached;
  // 单价是「元/百万 token」，乘 token 数再除以 1e6，得到元；再乘 1000 得厘
  const costYuan =
    (freshPrompt * p.in) / 1e6 +
    (u.cached * p.cacheHit) / 1e6 +
    (u.completion * p.out) / 1e6;

  return {
    ...u,
    // 不在这里取整：单次可能只有 0.1 厘，先取整会让高频小调用累计成 0
    costMilli: costYuan * MILLI_PER_YUAN,
    known: true,
    model: normalizeModel(model)
  };
}

/**
 * 累加器：一场会话 / 一天的账
 */
function createLedger() {
  return {
    calls: 0,
    prompt: 0,
    completion: 0,
    cached: 0,
    costMilli: 0,
    unknownCalls: 0,
    byModel: {}
  };
}

/**
 * 记一笔（就地修改 ledger）
 * @returns {object} 这笔的明细
 */
function addCall(ledger, usage, model, overrides) {
  const c = costOf(usage, model, overrides);
  if (!ledger || typeof ledger !== 'object') return c;

  ledger.calls += 1;
  ledger.prompt += c.prompt;
  ledger.completion += c.completion;
  ledger.cached += c.cached;
  // 以 1/1000 厘为整数单位累加，彻底避开浮点尾数；
  // 对外仍以「厘」为单位，读取时由 totalMilli() 还原
  ledger.costMicro = (ledger.costMicro || 0) + Math.round(c.costMilli * 1000);
  ledger.costMilli = ledger.costMicro / 1000;
  if (!c.known) ledger.unknownCalls += 1;

  const key = c.model || 'unknown';
  if (!ledger.byModel[key]) {
    ledger.byModel[key] = { calls: 0, prompt: 0, completion: 0, cached: 0, costMilli: 0 };
  }
  const b = ledger.byModel[key];
  b.calls += 1;
  b.prompt += c.prompt;
  b.completion += c.completion;
  b.cached += c.cached;
  b.costMicro = (b.costMicro || 0) + Math.round(c.costMilli * 1000);
  b.costMilli = b.costMicro / 1000;

  return c;
}

/** 厘 -> "¥0.35"，超过 1 元保留两位，不足则保留三位 */
function formatMoney(milli) {
  const n = Math.max(0, Number(milli) || 0) / MILLI_PER_YUAN;
  if (n === 0) return '¥0';
  if (n >= 0.1) return '¥' + n.toFixed(2);   // ¥0.35
  if (n >= 0.001) return '¥' + n.toFixed(3); // ¥0.050
  return '¥' + n.toFixed(4);
}

/** 数字加千分位 */
function formatTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 生成给人看的摘要文案
 * 例：「23 次调用 · 18.4k 输入（缓存 62%）· 3.1k 输出 · ¥0.42」
 */
function summarize(ledger, opts) {
  const l = ledger || createLedger();
  const cacheRate = l.prompt > 0 ? Math.round((l.cached / l.prompt) * 100) : 0;
  const parts = [];

  parts.push(l.calls + ' 次调用');
  if (l.prompt > 0) {
    const inK = l.prompt >= 1000 ? (l.prompt / 1000).toFixed(1) + 'k' : String(l.prompt);
    parts.push(inK + ' 输入' + (cacheRate > 0 ? '（缓存 ' + cacheRate + '%）' : ''));
  }
  if (l.completion > 0) {
    const outK = l.completion >= 1000 ? (l.completion / 1000).toFixed(1) + 'k' : String(l.completion);
    parts.push(outK + ' 输出');
  }
  parts.push(formatMoney(l.costMilli));

  let text = parts.join(' · ');
  if (l.unknownCalls > 0) {
    const names = Object.keys(l.byModel).filter((k) => !priceOf(k).known);
    text += '（' + names.join('/') + ' 未收录单价，未计入金额）';
  }
  if (opts && opts.suffix) text += opts.suffix;
  return text;
}

/**
 * 从一场会话的 entries 里重建账本
 * entries 形如 { t, kind:'hint'|'review', usage, model }，缺失的字段自动跳过
 */
function fromEntries(entries) {
  const ledger = createLedger();
  if (!Array.isArray(entries)) return ledger;
  for (const e of entries) {
    if (!e || !e.usage) continue;
    addCall(ledger, e.usage, e.model);
  }
  return ledger;
}

module.exports = {
  MILLI_PER_YUAN,
  PRICING,
  normalizeModel,
  priceOf,
  parseUsage,
  costOf,
  createLedger,
  addCall,
  formatMoney,
  formatTokens,
  summarize,
  fromEntries
};
