'use strict';
/**
 * WAV 封装（写）与解析（读）——16 kHz / 16 bit / 单声道
 *
 * 来源仓库：https://github.com/JWM0203/MeetingCopilot
 * 原文件：electron/asr/wav.ts、electron/asr/wavRead.ts（本文件为两者的合并）
 * 许可证：Apache-2.0（沿用原仓库 LICENSE，版权归原作者所有）
 * Modified by 面必过（interview-copilot）：TS → CommonJS 重写；encode 侧新增 Int16Array
 *   直传路径；decode 侧保留“严格”策略（非 16 bit 直接报错，不做静默重采样）。
 *
 * 写：给云 ASR 端点发 multipart 文件用。
 * 读：解析测试夹具 / 落盘录音。刻意严格——静默重采样会把坏夹具变成“识别结果莫名很差”，
 *     不如当场响亮地报错。
 */

const { DEFAULT_SAMPLE_RATE, toFloat32Pcm } = require('./contract');

/**
 * 把 float32 [-1,1] 或 int16 PCM 封装成 16 bit 单声道 WAV。
 * @param {Float32Array|Int16Array} pcm
 * @param {number} [sampleRate]
 * @returns {Uint8Array}
 */
function encodeWav(pcm, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (pcm == null) throw new TypeError('encodeWav: pcm is required');
  const isI16 = pcm instanceof Int16Array;
  const n = pcm.length;
  const dataLen = n * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i) & 0xff);
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true); // 除 RIFF 头 8 字节外的总长
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 长度（PCM = 16）
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = 1（单声道）
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate = sr * channels * bytesPerSample
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);

  let off = 44;
  if (isI16) {
    for (let i = 0; i < n; i++) {
      view.setInt16(off, pcm[i], true);
      off += 2;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(off, s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

/**
 * 解析 16 bit PCM WAV。走 chunk 链表而不是假定 44 字节头——SAPI 之类生成的
 * WAV 会在 fmt 前插一个 fact chunk。
 * @param {Uint8Array|Buffer} bytes
 * @returns {{pcm: Float32Array, sampleRate: number, channels: number, bits: number}}
 */
function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );

  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOff = -1;
  let dataLen = 0;

  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true); // body+0 = audioFormat
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOff = body;
      // 流式写入可能把 data 长度声明得比实际文件还大
      dataLen = Math.min(size, bytes.byteLength - body);
      break;
    }
    off = body + size + (size % 2); // chunk 按偶数字节对齐
  }

  if (dataOff < 0) throw new Error('WAV has no data chunk');
  if (bits !== 16) throw new Error(`WAV must be 16-bit PCM (got ${bits}-bit)`);

  const n = Math.floor(dataLen / 2);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = view.getInt16(dataOff + i * 2, true) / 32768;
  return { pcm, sampleRate, channels, bits };
}

/** 解析并强制校验成 ASR 引擎要的格式：16 kHz 单声道。 */
function decodeWav16kMono(bytes) {
  const { pcm, sampleRate, channels } = decodeWav(bytes);
  if (sampleRate !== DEFAULT_SAMPLE_RATE || channels !== 1) {
    throw new Error(`expected 16 kHz mono WAV, got ${sampleRate} Hz ${channels}ch`);
  }
  return pcm;
}

/** 只读头部信息，不解码采样（快速探测夹具是否合格）。 */
function readWavInfo(bytes) {
  const { pcm, sampleRate, channels, bits } = decodeWav(bytes);
  return { sampleRate, channels, bits, durationSec: pcm.length / (sampleRate || DEFAULT_SAMPLE_RATE) };
}

/** 便捷封装：任意 PCM 输入 → WAV 字节。 */
function encodeWavFrom(pcmInput, sampleRate = DEFAULT_SAMPLE_RATE) {
  return encodeWav(toFloat32Pcm(pcmInput), sampleRate);
}

module.exports = {
  encodeWav,
  encodeWavFrom,
  decodeWav,
  decodeWav16kMono,
  readWavInfo,
};
