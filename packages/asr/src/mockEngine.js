'use strict';
/**
 * 离线假引擎：不联网、不装模型，按音频时长返回占位文本。
 * 用途：CI 单测、无网络演示、云引擎失败时的兜底。
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：electron/asr/cloudEngine.ts（引擎骨架与配置校验写法）
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）：原仓库没有离线假引擎，本文件按其
 *   AsrEngine 接口形状新增实现，供无网络环境与自动化测试使用。
 */

const {
  DEFAULT_SAMPLE_RATE,
  createEngine,
  toFloat32Pcm,
  pcmDurationSec,
} = require('./contract');

/**
 * @param {Object} [opts]
 * @param {number} [opts.sampleRate]
 * @param {string} [opts.prefix]     占位文本前缀
 * @param {boolean} [opts.withSegments] 是否附带句级 segments
 * @param {number} [opts.segmentSec]  segments 的切片长度（秒）
 * @param {number} [opts.delayMs]     模拟网络/推理延迟（默认 0，测试里别拖慢）
 */
function createMockEngine(opts = {}) {
  const {
    sampleRate = DEFAULT_SAMPLE_RATE,
    prefix = '（离线模拟转写）',
    withSegments = true,
    segmentSec = 2,
    delayMs = 0,
  } = opts;

  return createEngine({
    name: 'mock',
    async transcribe(pcmChunks, o = {}) {
      const sr = o.sampleRate || sampleRate;
      const pcm = toFloat32Pcm(pcmChunks);
      const durationSec = pcmDurationSec(pcm, sr);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      const nPoints = Math.max(1, Math.round(durationSec / segmentSec));
      const text =
        `${prefix}收到 ${durationSec.toFixed(2)} 秒音频（${pcm.length} 采样点），` +
        `可归纳为 ${nPoints} 个思路要点，请先复述问题再分点作答。`;

      const result = { text, lang: 'chinese' };
      if (withSegments && durationSec > 0) {
        const segs = [];
        const step = Math.max(0.5, segmentSec);
        for (let t = 0; t < durationSec; t += step) {
          const end = Math.min(durationSec, t + step);
          segs.push({
            startSec: Number(t.toFixed(3)),
            endSec: Number(end.toFixed(3)),
            text: `${prefix}第 ${segs.length + 1} 个要点（${t.toFixed(1)}s-${end.toFixed(1)}s）`,
          });
        }
        result.segments = segs;
      }
      return result;
    },
  });
}

module.exports = { createMockEngine };
