'use strict';
/**
 * OpenAI 兼容 LLM 网关
 *
 * 只暴露一家 provider 的形状，好处有两个：
 * 1. 任何支持 /v1/chat/completions 的服务都能接（含本地网关）；
 * 2. 魔方简历那一侧也能把本网关当成一家 provider 填进去，用户不用配两遍 Key。
 */

const DEFAULT_TIMEOUT = 20000;

/**
 * 「繁忙」的辨识规则。夜间免费额度常被官方限流，这类错误值得等待重试，
 * 而不是当成普通失败丢掉整个请求。
 */
const BUSY_PATTERNS = [
  /繁忙/i, /拥挤/i, /拥挤/, /暂时不可用/, /稍后再试/i, /请稍后/i,
  /busy/i, /overload(ed)?/i, /capacity/i, /rate.?limit/i, /too many requests/i,
  /service unavailable/i, /upstream/i, /try again/i, /later/i,
  /model.?overload/i, /server.?busy/i, /throttl/i,
];

const BUSY_STATUS = new Set([429, 500, 502, 503, 504, 509]);

/**
 * 判断一次错误是不是「繁忙/限流」。
 * @param {Error|string} err
 * @returns {{busy: boolean, status: number, reason: string}}
 */
function classifyError(err) {
  const msg = String((err && err.message) || err || '');
  const status = Number((err && err.status) || 0);
  const byStatus = BUSY_STATUS.has(status);
  const byText = BUSY_PATTERNS.some((r) => r.test(msg));
  return { busy: byStatus || byText, status, reason: msg.slice(0, 300) };
}

function normalizeBaseUrl(baseUrl) {
  let u = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}

function createClient({ baseUrl, apiKey, model, timeoutMs = DEFAULT_TIMEOUT }) {
  const base = normalizeBaseUrl(baseUrl);
  const mdl = model || 'gpt-4o-mini';
  // FIX: timeoutMs 传 0 / 负数 / 非数字时，setTimeout 会当成 0ms，请求刚发出就被 abort
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;

  async function chat(messages, { maxTokens = 400, temperature = 0.3, jsonMode = true } = {}) {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const body = { model: mdl, messages, max_tokens: maxTokens, temperature };
      if (jsonMode) body.response_format = { type: 'json_object' };

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey || ''}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 带 status：上层 classifyError 据此判断是否该退避重试（夜间免费额度常被限流）
        const err = new Error(`LLM ${res.status} ${res.statusText} :: ${body.slice(0, 400)}`);
        err.status = res.status;
        throw err;
      }
      const raw = await res.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        // FIX: 网关返回 HTML 错误页时原来是裸 SyntaxError，日志里看不出是配置错还是服务挂
        throw new Error(`LLM 返回体不是 JSON：${raw.slice(0, 200)}`);
      }
      const content = json?.choices?.[0]?.message?.content ?? '';
      return {
        content,
        latencyMs: Date.now() - started,
        usage: json?.usage || null,
      };
    } catch (e) {
      // FIX: abort 原本只报 "This operation was aborted"，排查时无法区分超时和网络故障
      if (e && e.name === 'AbortError') throw new Error(`LLM 请求超时（>${timeout}ms）：${base}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return { base, model: mdl, chat };
}

/**
 * 从文本里切出第一个花括号配平的子串（忽略字符串内部的括号与转义）
 * @returns {string|null} 没找到配平对象返回 null
 */
function sliceBalancedObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (inStr) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 从模型输出里抠出 JSON（容忍 markdown 代码块与前后废话） */
function parseCardObject(content) {
  let s = String(content || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // FIX: 原来用 lastIndexOf('}') 定位结尾，JSON 后面只要还有一句带 } 的解释就切错，白扔一次重试
  const obj = sliceBalancedObject(s);
  if (obj == null) throw new Error(`输出中没有 JSON 对象：${s.slice(0, 200)}`);
  return JSON.parse(obj);
}

module.exports = { createClient, parseCardObject, normalizeBaseUrl, classifyError, BUSY_PATTERNS, BUSY_STATUS };
