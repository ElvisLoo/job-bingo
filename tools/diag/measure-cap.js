'use strict';
/** 量采集窗口的内容高度与是否溢出，验证窗口尺寸是否够用 */
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
setTimeout(() => { console.log('timeout'); app.exit(2); }, 20000);

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 520, height: 360, show: false, frame: false,
    backgroundColor: '#0b0f18',
    webPreferences: { contextIsolation: true },
  });
  await w.loadFile('C:/Users/Admin/WorkBuddy/2026-10-26-18-19-33/job-bingo/packages/desktop/src/renderer/audio-capture.html');
  await new Promise((r) => setTimeout(r, 900));
  const m = await w.webContents.executeJavaScript(`(() => {
    const a = document.querySelector('.app');
    return {
      contentH: Math.ceil(a.getBoundingClientRect().height),
      winInnerH: window.innerHeight,
      scrollH: document.documentElement.scrollHeight,
      overflow: document.documentElement.scrollHeight - window.innerHeight,
    };
  })()`);
  console.log(JSON.stringify(m));
  // 按内容高度调整后再量一次
  const need = m.contentH + 2;
  w.setSize(520, need);
  await new Promise((r) => setTimeout(r, 400));
  const m2 = await w.webContents.executeJavaScript(`(() => ({
    after: Math.ceil(document.querySelector('.app').getBoundingClientRect().height),
    winInnerH: window.innerHeight,
    overflow: document.documentElement.scrollHeight - window.innerHeight,
  }))()`);
  console.log(JSON.stringify(m2));
  app.exit(0);
});
