'use strict';
/**
 * 云 ASR 引擎：把 VAD 收好的一段音频 POST 给 OpenAI 兼容的转写端点。
 * 只用 Node 内置 fetch / FormData / Blob，零第三方依赖。
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：electron/asr/cloudEngine.ts
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）：TS → CommonJS 重写；原实现走
 *   /chat/completions + base64 input_audio，本项目改为更通用的
 *   /v1/audio/transcriptions + multipart/form-data（OpenAI/Whisper.cpp/本地服务通用）；
 *   apiKey 留空时不发 Authorization 头（兼容本地无鉴权服务）；新增 segments 解析与超时控制。
 *
 * 隐私边界沿用原设计：本地 VAD 是唯一的“出门闸机”，只有判定为说话的段才会离开本机。
 */

const { DEFAULT_SAMPLE_RATE, createEngine, toFloat32Pcm } = require('./contract');
const { encodeWav } = require('./wav');

// ---- 可调默认值 ----
const DEFAULTS = {
  /** 转写端点路径（OpenAI 兼容） */
  endpoint: '/v1/audio/transcriptions',
  /** 单次请求超时；超过就抛错，由上层降级到 mock 引擎 */
  timeoutMs: 15000,
  /** 提示词：告诉模型这是中文面试场景，别乱加标点、别翻译 */
  prompt: 'zh interview, verbatim',
  /** 响应格式：verbose_json 会带 segments；服务端不支持时通常退回 text 字段 */
  responseFormat: 'verbose_json',
  /** 语言，传空串则由服务端自动判定 */
  language: 'zh',
};

function isConfigured(cfg) {
  return !!(cfg && cfg.baseUrl && cfg.model);
}

/**
 * 拼接请求 URL。两种 baseUrl 约定都兼容：
 *   baseUrl='https://api.openai.com/v1' + '/v1/audio/transcriptions'
 *   baseUrl='https://api.openai.com'    + '/v1/audio/transcriptions'
 * （避免拼出 /v1/v1/... 这种静默 404）
 */
function joinUrl(base, endpoint) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const b = String(base).replace(/\/+$/, '');
  let e = String(endpoint);
  if (!e.startsWith('/')) e = '/' + e;
  if (/\/v\d+$/i.test(b) && /^\/v\d+\//i.test(e)) e = e.replace(/^\/v\d+/, '');
  return b + e;
}

function assertConfig(cfg) {
  if (!cfg || !cfg.baseUrl) throw new Error('cloud ASR is not configured: missing baseUrl');
  if (!cfg.model) throw new Error('cloud ASR is not configured: missing model');
}

/**
 * @param {Object} cfg
 * @param {string} cfg.baseUrl   例如 https://api.openai.com/v1 或 http://127.0.0.1:8787/v1
 * @param {string} cfg.model     例如 whisper-1
 * @param {string} [cfg.apiKey]  留空则不发送 Authorization 头
 * @param {string} [cfg.endpoint]
 * @param {number} [cfg.timeoutMs]
 * @param {string} [cfg.language]
 * @param {string} [cfg.prompt]
 * @param {string} [cfg.responseFormat]
 * @param {Function} [cfg.fetchImpl] 注入用（测试可传自己的 fetch）
 */
function createCloudEngine(cfg = {}) {
  assertConfig(cfg);
  const o = Object.assign({}, DEFAULTS, cfg);
  const base = String(o.baseUrl).replace(/\/+$/, '');
  const url = joinUrl(base, o.endpoint);
  const doFetch = o.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('global fetch is unavailable: Node >= 18 required');
  }

  return createEngine({
    name: 'cloud',
    async transcribe(pcmChunks, opts = {}) {
      const sr = opts.sampleRate || DEFAULT_SAMPLE_RATE;
      const pcm = toFloat32Pcm(pcmChunks);
      if (pcm.length === 0) return { text: '', latencyMs: 0 };

      const wav = encodeWav(pcm, sr);
      const form = new FormData();
      // 注意：字段名必须是 file（OpenAI 兼容端点约定）
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
      form.append('model', o.model);
      if (o.language) form.append('language', o.language);
      if (o.prompt) form.append('prompt', o.prompt);
      if (o.responseFormat) form.append('response_format', o.responseFormat);

      const headers = {};
      // 本地无鉴权服务（如自建 whisper.cpp）不传 key，避免 401
      if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), o.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      let res;
      try {
        res = await doFetch(url, { method: 'POST', headers, body: form, signal: ac.signal });
      } catch (e) {
        clearTimeout(timer);
        throw new Error(`cloud ASR request failed: ${e && e.message ? e.message : e}`);
      }
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`cloud ASR HTTP ${res.status}: ${String(body).slice(0, 200)}`);
      }

      // 有些自建端点标着 application/json 却直接返回纯文本，所以先看能不能 JSON.parse，
      // 失败就当纯文本用（不依赖 content-type 判断，容错更好）
      const rawBody = (await res.text()).trim();
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = { text: rawBody };
      }

      const text = String(payload.text ?? payload.transcript ?? '').trim();
      const out = { text };
      if (Array.isArray(payload.segments)) {
        out.segments = payload.segments.map((s) => ({
          startSec: Number(s.start ?? s.startSec ?? 0),
          endSec: Number(s.end ?? s.endSec ?? 0),
          text: String(s.text ?? ''),
        }));
      }
      if (payload.language) out.lang = payload.language;
      return out;
    },
  });
}

module.exports = { createCloudEngine, isConfigured, joinUrl, CLOUD_DEFAULTS: DEFAULTS };
