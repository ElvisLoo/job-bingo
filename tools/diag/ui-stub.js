'use strict';
// 截图专用：给页面注入假 IPC 桥，避免因缺主进程而中断脚本
const noop = () => Promise.resolve({});
const stub = {
  onCard: () => {}, onMode: () => {}, onConfig: () => {}, onReviewRequest: () => {},
  onWho: () => {}, onSelfTest: () => {},
  ask: noop, mock: noop, warmup: noop, setConfig: noop, loadResume: noop,
  getConfig: () => Promise.resolve({ config: { llm: {}, overlay: {}, busy: {} }, hasResume: false, version: '0.1.3' }),
  setThrough: noop, hide: noop, setTaskbar: noop, setSolid: noop, busyCancel: noop,
  captureStart: noop, captureStop: noop, captureStatus: () => Promise.resolve({}),
  pipelineStatus: () => Promise.resolve({ stats: { ingested: 0, droppedDup: 0, droppedShort: 0, generated: 0 } }),
  pipelineReset: noop, pipelineStart: noop, pipelineStop: noop,
  asrFeedWav: noop, asrDemoWav: noop, asrStatus: () => Promise.resolve({ available: true }),
  reviewGenerate: noop, reviewOpenFolder: noop, reviewClear: noop, reviewCount: () => Promise.resolve({ count: 4 }),
  sendPcm: () => {}, sendLevel: () => {}, report: () => {}, reportError: () => {},
};
require('electron').contextBridge.exposeInMainWorld('copilot', stub);
require('electron').contextBridge.exposeInMainWorld('capture', stub);
