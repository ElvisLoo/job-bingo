'use strict';
/**
 * 无截图的界面自检：加载真实页面，检查
 *  1) 脚本是否抛错（监听 console / pageerror）；
 *  2) 关键元素是否存在；
 *  3) 是否有元素溢出容器（scrollWidth > clientWidth）；
 *  4) 计算样式是否生效（用 getComputedStyle 取样）。
 * 比截图更可靠：不依赖图像通道，也不受远程会话影响。
 */
const path = require('path');
const { app, BrowserWindow } = require('electron');

const R = path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer');
const page = process.argv[2] || 'settings';
const W = page === 'settings' ? 920 : page === 'overlay' ? 800 : 540;
const H = page === 'settings' ? 900 : page === 'overlay' ? 320 : 330;

const errors = [];
app.disableHardwareAcceleration();
setTimeout(() => { console.log('[ui-check] timeout'); app.exit(2); }, 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H, show: false, backgroundColor: '#0b0f18',
    webPreferences: { preload: path.resolve(__dirname, 'ui-stub.js'), contextIsolation: true },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) errors.push('console: ' + msg.slice(0, 200));
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('crash: ' + JSON.stringify(d)));

  await win.loadFile(path.join(R, page + '.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const report = await win.webContents.executeJavaScript(`(() => {
    const out = { title: document.title, missing: [], overflow: [], samples: {}, sizes: {} };
    const SET = ${JSON.stringify(page)} === 'settings';
    const CAP = ${JSON.stringify(page)} === 'audio-capture';
    const OV  = ${JSON.stringify(page)} === 'overlay';
    const ids = SET ? ['save','warmup','importResume','askBtn','mockRun','capStart','capSegs','capWho','reviewRun','preview','sideDot']
              : CAP ? ['barsLoop','barsMic','whoPanel','stateWrap','frames','micFrames','probe']
              : ['card','points','anchor','edge','dot','mode'];
    for (const id of ids) if (!document.getElementById(id)) out.missing.push(id);

    // 溢出检查：只查会横向溢出的块级元素
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const s = getComputedStyle(el);
        if (s.overflowX === 'visible') out.overflow.push((el.id || el.className || el.tagName) + ' +' + (el.scrollWidth - el.clientWidth));
      }
    }

    const pick = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
    out.samples.bg = pick('body', 'backgroundColor');
    out.samples.fontSize = pick('body', 'fontSize');
    out.samples.cardBg = pick('.card', 'backgroundColor');
    out.samples.cardRadius = pick('.card', 'borderRadius');
    out.samples.btnPrimary = pick('button.primary', 'backgroundColor');

    const bars = document.getElementById('barsLoop');
    out.sizes.bars = bars ? bars.children.length : 0;
    const m = document.querySelector('.main');
    out.sizes.scrollHeight = m ? m.scrollHeight : 0;
    out.sizes.clientHeight = m ? m.clientHeight : 0;
    return out;
  })()`).catch((e) => ({ fatal: String(e && e.message) }));

  console.log(JSON.stringify({ page, errors, report }, null, 1));
  app.exit(0);
});
