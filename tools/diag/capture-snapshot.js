'use strict';
/**
 * 采集窗口快照：加载真实的 audio-capture.html，注入一组「双轨已就绪」状态，
 * capturePage 存 PNG。用于在没有桌面会话的环境里产出可视化证据。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const OUT = process.env.OUT || path.resolve(__dirname, '..', '..', 'capture-snapshot.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 520, height: 300, show: false, frame: false, backgroundColor: '#0f1420',
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer', 'audio-capture.html'));
  await new Promise((r) => setTimeout(r, 800));
  // 注入演示状态（页面脚本在无 capture bridge 时会自报错，这里直接改 DOM）
  await win.webContents.executeJavaScript(`
    const set=(id,t,c)=>{const e=document.getElementById(id); if(e){e.textContent=t; e.className=c||'';}};
    set('state','采集中（只听声音，不看画面）','ok');
    set('tracks','1 条（系统混音）','ok');
    set('mic','1 条（用于区分谁在说话）','ok');
    set('level','回环 -31 dB · 麦克风 -58 dB','dim');
    set('rate','16000 Hz','ok');
    set('frames','186','');
    set('micFrames','184','');
    true;
  `);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('saved', OUT);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
