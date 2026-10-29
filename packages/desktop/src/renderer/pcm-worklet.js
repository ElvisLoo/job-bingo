'use strict';
/**
 * AudioWorklet：把 16kHz 单声道输入累积成 1600 样本（100ms）的 Float32 帧，
 * 转移 buffer 后 post 给主线程。运行在音频渲染线程上，禁止在此分配大对象。
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：src/public/pcm-worklet.js
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）
 */
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.buf.length) {
          const out = this.buf;
          this.port.postMessage(out.buffer, [out.buffer]);
          this.buf = new Float32Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
