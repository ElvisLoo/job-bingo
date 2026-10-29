'use strict';
/**
 * packages/asr 的统一出口（纯 CommonJS，严禁引入 electron——本包要能在
 * 非 Electron 环境（CLI / 测试 / 未来的服务端）里直接 require）。
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：electron/asr/*（vad.ts / wav.ts / wavRead.ts / langRouter.ts / cloudEngine.ts / contract.ts）
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）：按上述原文件用 JS 重写核心算法后在此聚合。
 */

const contract = require('./contract');
const { VadSegmenter, segmentPcm, rms, DEFAULT_VAD_OPTIONS } = require('./vad');
const { encodeWav, encodeWavFrom, decodeWav, decodeWav16kMono, readWavInfo } = require('./wav');
const {
  LanguageRouter,
  detectLangFromText,
  pickEngine,
  DEFAULT_ROUTER_OPTIONS,
} = require('./langRouter');
const { createMockEngine } = require('./mockEngine');
const { createCloudEngine, isConfigured, CLOUD_DEFAULTS } = require('./cloudEngine');
const { synthPcm, synthSpeechLike } = require('./synth');
const { DualTrackEchoGate, NoiseFloor, dbfs, rmsOf } = require('./echoGate');
const { voteRole } = require('./roleVote');

/**
 * ASR 路由器：把“语种判定 + 引擎选择 + 失败降级”收成一个入口，
 * 上层（packages/core）只需要 router.transcribe(pcm, opts)。
 *
 * @param {Object} [opts]
 * @param {Object} [opts.mock]         已构造的 mock 引擎（默认内部建一个）
 * @param {Object} [opts.cloud]        已构造的云引擎；与 cloudConfig 二选一
 * @param {Object} [opts.cloudConfig]  { baseUrl, model, apiKey }，内部调 createCloudEngine
 * @param {boolean} [opts.useCloud]    是否优先走云引擎（默认：配了云就走云）
 * @param {boolean} [opts.fallbackToMock] 云引擎失败时降级到 mock（默认 true）
 * @param {Object} [opts.engines]      按语种指定引擎：{ chinese, english, default }
 * @param {string} [opts.language]     初始语言，默认 chinese
 * @param {number} [opts.sampleRate]
 */
function createAsrRouter(opts = {}) {
  const {
    mock = null,
    cloud = null,
    cloudConfig = null,
    fallbackToMock = true,
    engines = null,
    language = 'chinese',
    sampleRate = contract.DEFAULT_SAMPLE_RATE,
  } = opts;

  const mockEngine = mock || createMockEngine({ sampleRate });
  let cloudEngine = cloud;
  if (!cloudEngine && cloudConfig && isConfigured(cloudConfig)) {
    cloudEngine = createCloudEngine(Object.assign({ sampleRate }, cloudConfig));
  }
  const useCloud = opts.useCloud == null ? !!cloudEngine : !!opts.useCloud && !!cloudEngine;

  const languageRouter = new LanguageRouter({ initial: language === 'english' ? 'english' : 'chinese' });

  function pickLanguage(text) {
    return languageRouter.decideByText(text).lang;
  }

  /** 按文本（或当前语言）挑引擎：显式 engines 映射 > 云/兜底策略。 */
  function pick(text) {
    const lang = pickLanguage(text || '');
    if (engines) {
      const byLang = pickEngine(lang, engines);
      if (byLang) return { engine: byLang, lang };
    }
    if (useCloud && cloudEngine) return { engine: cloudEngine, lang };
    return { engine: mockEngine, lang };
  }

  /**
   * 转写一段 PCM。
   * @param {Float32Array|Int16Array|Buffer|Array} pcmChunks
   * @param {Object} [o] { text?, language?, sampleRate? }  text 用于语种路由（可省）
   * @returns {Promise<{text:string, segments?:Array, latencyMs:number, lang?:string, engine:string}>}
   */
  async function transcribe(pcmChunks, o = {}) {
    const { engine, lang } = pick(o.text || '');
    const callOpts = Object.assign({ sampleRate, language: o.language || lang }, o);
    try {
      const res = await engine.transcribe(pcmChunks, callOpts);
      if (!res.lang) res.lang = lang;
      return res;
    } catch (err) {
      if (engine !== mockEngine && fallbackToMock) {
        const res = await mockEngine.transcribe(pcmChunks, callOpts);
        res.lang = lang;
        res.degradedFrom = engine.name;
        res.error = err && err.message ? err.message : String(err);
        return res;
      }
      throw err;
    }
  }

  return {
    name: 'asr-router',
    transcribe,
    pickLanguage,
    pick,
    languageRouter,
    engines: { mock: mockEngine, cloud: cloudEngine },
    sampleRate,
  };
}

module.exports = {
  // ---- 契约 ----
  CONTRACT_VERSION: contract.CONTRACT_VERSION,
  DEFAULT_SAMPLE_RATE: contract.DEFAULT_SAMPLE_RATE,
  createEngine: contract.createEngine,
  assertEngine: contract.assertEngine,
  normalizeTranscribeResult: contract.normalizeTranscribeResult,
  toFloat32Pcm: contract.toFloat32Pcm,
  toPcm16Buffer: contract.toPcm16Buffer,
  pcmSampleCount: contract.pcmSampleCount,
  pcmDurationSec: contract.pcmDurationSec,

  // ---- 双轨回声门（区分「谁在说话」，解决回环自我触发）----
  DualTrackEchoGate,
  NoiseFloor,
  dbfs,
  rmsOf,
  voteRole,

  // ---- VAD ----
  VadSegmenter,
  segmentPcm,
  rms,
  DEFAULT_VAD_OPTIONS,

  // ---- WAV ----
  encodeWav,
  encodeWavFrom,
  decodeWav,
  decodeWav16kMono,
  readWavInfo,

  // ---- 语言路由 ----
  LanguageRouter,
  detectLangFromText,
  pickEngine,
  DEFAULT_ROUTER_OPTIONS,

  // ---- 引擎 ----
  createMockEngine,
  createCloudEngine,
  isCloudConfigured: isConfigured,
  CLOUD_DEFAULTS,

  // ---- 工具 ----
  synthPcm,
  synthSpeechLike,

  // ---- 路由器 ----
  createAsrRouter,
};
