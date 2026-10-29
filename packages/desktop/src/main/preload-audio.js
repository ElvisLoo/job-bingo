'use strict';
/**
 * 采集窗口的预加载：只做 IPC 桥接，**不 require 任何业务包**。
 *
 * 踩过的坑：早期版本在这里 require('@job-bingo/asr') 给 renderer 用 VAD，
 * 结果 preload 上下文解析不了 workspace 软链的包名，脚本直接加载失败，
 * 整条采集链路静默瘫痪。VAD 属 Node 包能力，应该留在主进程。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  /** 每 100ms 一帧 16kHz Float32 PCM → 主进程做 VAD。track: 'loop' | 'mic' */
  sendPcm: (float32, track) => ipcRenderer.send('capture:pcm', { track: track || 'loop', pcm: float32 }),
  /** 100ms 两路瞬时能量（RMS），主进程用它做「谁在说」判定，不落盘 */
  sendLevel: (payload) => ipcRenderer.send('capture:level', payload),
  /** 状态与错误上报 */
  report: (payload) => ipcRenderer.send('capture:status', payload),
  reportError: (msg) => ipcRenderer.send('capture:status', { level: 'error', message: String(msg) }),
  /** 自检指令：播放一段合成语音，用来验证「系统声音 → 回环 → VAD」真的通 */
  onSelfTest: (cb) => ipcRenderer.on('capture:selftest', () => cb()),
  /** 回声门判定回传：{ role: 'me'|'them'|'unknown'|'silence', micDb, loopDb } */
  onWho: (cb) => ipcRenderer.on('capture:who', (_e, p) => cb(p)),
});
