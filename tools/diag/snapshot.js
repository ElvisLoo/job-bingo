'use strict';
/**
 * 给浮窗拍一张真实渲染快照（不依赖屏幕抓取，也不依赖桌面会话）。
 * 用一个离屏窗口加载真实的 overlay.html，注入一张思路卡，capturePage 存 PNG。
 * 用途：当 GUI 跑在远程桌面会话、本地看不到时，用它产出可视化证据。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const OUT = process.env.OUT || path.resolve(__dirname, '..', '..', 'snapshot.png');

const CARD = {
  anchor: { resumeId: 'proj:0', label: 'ERP 成本分析 · 昆山万金天宇' },
  points: [
    { kind: 'fact', text: '库存 1000 pcs / 余额 -3994.58' },
    { kind: 'path', text: 'INVQ01 流水 → INV102 重算' },
    { kind: 'key', text: '出入库异动类型 + 暂估凭证' },
    { kind: 'close', text: '落到单据层，不是调总数' },
  ],
  caution: '别急着说"改好了"，先讲怎么定位',
  meta: { model: 'mock', latencyMs: 820, attempt: 1, anchorCount: 12 },
};

app.disableHardwareAcceleration(); // 离屏渲染在部分环境下更稳

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 820,
    height: 320,
    show: false,
    frame: false,
    transparent: false, // 截图需要实底，否则 PNG 全透明看不清
    backgroundColor: '#1b2233',
    webPreferences: {
      preload: path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });

  await win.loadFile(path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer', 'overlay.html'));
  win.webContents.send('mode', { mouseThrough: true });
  win.webContents.send('card', {
    type: 'card',
    card: CARD,
    question: '说说你处理过最复杂的一次库存成本异常',
    from: 'desktop',
  });

  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(OUT, img.toPNG());
      console.log('[snapshot] 已保存', OUT, fs.statSync(OUT).size, 'bytes');
    } catch (e) {
      console.error('[snapshot] 失败', e.message);
    }
    app.quit();
  }, 1500);
});
