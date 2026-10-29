'use strict';
/**
 * 语言路由：中英混合面试场景下的语种判定与引擎选择（纯逻辑，可单测）
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：electron/asr/langRouter.ts
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）：TS → CommonJS 重写；原实现只吃 LID（声学语种识别）
 *   结果，本项目没有本地 LID 模型，因此新增 detectLangFromText()——直接对已有文本做字符统计判定，
 *   并新增 pickEngine() 做“按语种选引擎”。中文优先（平票时判中文）是本项目的一等需求。
 *
 * 原实现的“粘性”策略保留：短段、低置信度的判定不改写上一次的语言，避免上下文来回跳。
 */

// ---- 可调常量 ----
const DEFAULT_ROUTER_OPTIONS = {
  /** 初始语言：本项目面向中文面试，默认中文 */
  initial: 'chinese',
  /** 音频短于此毫秒数时不信任 LID 结果，沿用上一次语言 */
  minAudioMsForLid: 1200,
  /** LID 置信度间隔（|logit(zh)-logit(en)|）低于此值视为“不确定”，沿用上一次语言 */
  minMargin: 1.0,
  /** 文本判定的最低置信度：中/英字符占比差低于此值视为“不确定”（沿用上一次语言） */
  minTextMargin: 0.2,
  /** 可判别字符少于此数量时不信任文本判定（"嗯"、"OK" 这种单词不足以改判语言） */
  minTextChars: 4,
};

/** CJK 统一表意文字（含扩展 A 与兼容表意文字；不含日文假名/韩文，避免误判为中文） */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;
/** 拉丁字母（英文） */
const LATIN_RE = /[A-Za-z]/g;

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * 对一段文本做语种判定（中文优先）。
 * @param {string} text
 * @param {Partial<typeof DEFAULT_ROUTER_OPTIONS>} [opts]
 * @returns {{lang: 'chinese'|'english', margin: number, confident: boolean,
 *            cjk: number, latin: number, zhRatio: number}}
 *   margin ∈ [0,1]，= |cjk-latin| / (cjk+latin)；confident = margin >= minTextMargin
 */
function detectLangFromText(text, opts = {}) {
  const o = Object.assign({}, DEFAULT_ROUTER_OPTIONS, opts);
  const s = typeof text === 'string' ? text : '';
  const cjk = countMatches(s, CJK_RE);
  const latin = countMatches(s, LATIN_RE);
  const total = cjk + latin;

  if (total === 0) {
    // 没有任何可判别字符（纯数字/标点/空串）→ 不自信，沿用初始语言（中文优先）
    return { lang: o.initial, margin: 0, confident: false, cjk: 0, latin: 0, zhRatio: 0 };
  }

  const zhRatio = cjk / total;
  // 平票时取中文：cjk >= latin → chinese
  const lang = cjk >= latin ? 'chinese' : 'english';
  const margin = Math.abs(cjk - latin) / total;
  // 字符太少（"嗯"/"OK"）不做改判，沿用上一次语言
  const confident = total >= o.minTextChars && margin >= o.minTextMargin;
  return { lang, margin, confident, cjk, latin, zhRatio };
}

/**
 * 语言路由器（有状态）：记住上一次判定的语言，供短段/低置信度场景兜底。
 */
class LanguageRouter {
  constructor(opts = {}) {
    this.opts = Object.assign({}, DEFAULT_ROUTER_OPTIONS, opts);
    this.lastLang = this.opts.initial;
  }

  /** 上一次判定的语言（partial 结果跳过 LID 时用它） */
  get currentLang() {
    return this.lastLang;
  }

  /** 这段音频够长吗？够长才值得跑 LID。 */
  shouldRunLid(audioMs) {
    return audioMs >= this.opts.minAudioMsForLid;
  }

  /**
   * 结合音频时长与 LID 结果给出最终语言。
   * @param {number} audioMs
   * @param {{lang:'chinese'|'english', margin:number}|null} lid
   */
  decide(audioMs, lid) {
    if (lid && audioMs >= this.opts.minAudioMsForLid && lid.margin >= this.opts.minMargin) {
      this.lastLang = lid.lang;
    }
    return this.lastLang;
  }

  /** 文本版：把 detectLangFromText 的结果按同样规则做“粘性”处理。 */
  decideByText(text) {
    const d = detectLangFromText(text, this.opts);
    if (d.confident) this.lastLang = d.lang;
    return { lang: this.lastLang, detected: d };
  }

  reset() {
    this.lastLang = this.opts.initial;
  }
}

/**
 * 按语种挑选 ASR 引擎。
 * @param {'chinese'|'english'} lang
 * @param {{chinese?: Object, english?: Object, default?: Object}} engines
 * @returns {Object|null} 找不到时返回 null（调用方自行降级）
 */
function pickEngine(lang, engines = {}) {
  if (lang && engines[lang]) return engines[lang];
  return engines.default || engines.chinese || engines.english || null;
}

module.exports = {
  DEFAULT_ROUTER_OPTIONS,
  LanguageRouter,
  detectLangFromText,
  pickEngine,
};
