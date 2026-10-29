'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
setTimeout(() => app.exit(2), 25000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 1600, show: false, backgroundColor: '#0f1420',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.resolve(__dirname, 'shot-preload.js') } });
  await win.loadFile(path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer', 'settings.html'));
  await new Promise((r) => setTimeout(r, 1200));
  // 注入复盘结果，验证渲染样式（不依赖主进程）
  await win.webContents.executeJavaScript(`
    const out=document.getElementById('reviewOut');
    if(out){
      out.hidden=false;
      out.textContent='# 面试复盘 · 2026-10-27 17:05\n> 岗位：信息化经理\n> 引擎：本地规则 · 轮次：2 · 证据不足：1\n\n## 总体判断\n\n本地复盘：共 2 轮提问，其中 1 处证据不足。\n\n### ✅ 站得住｜说说你处理过最复杂的一次系统故障\n> 去年双十一订单服务雪崩，我把连接池从 200 调到 500\n\n有数字、有关键词，结构上站得住\n\n### ⚠️ 答得薄｜你怎么知道问题解决了\n> 看错误率回落\n\n回答仅 6 字，撑不起一个完整的例子';
    }
    const n=document.getElementById('reviewNote'); if(n) n.textContent='已保存：Documents\\面必过复盘\\复盘-2026-10-27-1705.md';
    true;
  `);
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.resolve(__dirname, '..', '..', 'settings-shot.png'), (await win.capturePage()).toPNG());
  console.log('saved');
  app.exit(0);
});
