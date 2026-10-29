'use strict';
/**
 * 界面快照：离屏渲染真实 HTML，注入假 IPC 桥后截图。
 * 用途：无桌面会话（远程/CI）时也能核对 UI，而不是靠猜。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const R = path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer');
const which = process.argv[2] || 'settings';
const OUT = process.env.OUT || path.resolve(__dirname, '..', '..', `ui-${which}.png`);

app.disableHardwareAcceleration();
setTimeout(() => { console.log('[ui-shot] timeout'); app.exit(2); }, 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: which === 'settings' ? 920 : 540,
    height: which === 'settings' ? 1000 : 330,
    show: false,
    backgroundColor: '#0b0f18',
    webPreferences: { preload: path.resolve(__dirname, 'ui-stub.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(R, which === 'settings' ? 'settings.html' : 'audio-capture.html'));
  await new Promise((r) => setTimeout(r, 1400));

  if (which === 'settings') {
    await win.webContents.executeJavaScript(`
      const out = document.getElementById('preview');
      if (out) { out.hidden = false; out.innerHTML =
        '<div class="anchor">锚点：ERP 成本分析 · 昆山万金天宇</div>' +
        '<ul><li>库存 1000 pcs / 余额 -3994.58</li><li>INVQ01 流水 → INV102 重算</li><li>出入库异动类型 + 暂估凭证</li></ul>' +
        '<div class="caution">⚠ 别急着说改好了，先讲怎么定位</div>' +
        '<div class="meta">mock · 尝试 2 次 · 锚点库 12 条</div>'; }
      const v = document.getElementById('ver'); if (v) v.textContent = 'v0.1.3';
      true;`).catch(() => {});
  } else {
    await win.webContents.executeJavaScript(`
      const set=(id,t,c)=>{const e=document.getElementById(id); if(e){e.textContent=t; if(c!==undefined) e.className=c;}};
      set('state','采集中',''), set('tracks','1 条（系统混音）','ok'), set('mic','1 条（区分说话人）','ok');
      set('rate','16000 Hz'), set('frames','412'), set('micFrames','410'), set('probe','电平旁路：已接','ok');
      const w=document.getElementById('stateWrap'); if(w) w.className='badge ok';
      const wp=document.getElementById('whoPanel'); if(wp) wp.className='who-panel them';
      set('who','像是对方在说（生成卡片） · 麦克风 -58.2 dB / 回环 -24.6 dB');
      const paint=(id,lit)=>{const b=document.getElementById(id); if(!b) return;
        [...b.children].forEach((c,i)=>{ c.className = i<lit ? ('on'+(i>=18?' clip':i>=14?' hot':'')) : ''; });};
      paint('barsLoop',17); paint('barsMic',5);
      true;`).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(OUT, (await win.capturePage()).toPNG());
  console.log('[ui-shot] saved', OUT);
  app.exit(0);
});
