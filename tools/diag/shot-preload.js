'use strict';
// 截图专用：给设置页注入一个假的 copilot 桥，避免因缺 IPC 而中断脚本
const noop = () => Promise.resolve({});
const stub = {
  onCard: () => {}, onMode: () => {}, onConfig: () => {},
  onReviewRequest: () => {},
  reviewGenerate: noop, reviewOpenFolder: noop, reviewClear: noop,
  reviewCount: () => Promise.resolve({ count: 4 }),
  getConfig: () => Promise.resolve({ llm: {}, overlay: {}, busy: {} }),
  setConfig: noop, loadResume: noop, ask: noop, mock: noop, warmup: noop,
  setThrough: noop, hide: noop, setTaskbar: noop, setSolid: noop, busyCancel: noop,
  captureStart: noop, captureStop: noop, captureStatus: () => Promise.resolve({}),
  pipelineStatus: () => Promise.resolve({ stats: { ingested: 0, droppedDup: 0, droppedShort: 0, generated: 0 } }),
  pipelineReset: noop, pipelineStart: noop, pipelineStop: noop,
  asrFeedWav: noop, asrDemoWav: noop, asrStatus: () => Promise.resolve({ available: true }),
};
try {
  require('electron').contextBridge.exposeInMainWorld('copilot', stub);
} catch (_) {
  window.copilot = stub;
}
