'use strict';
/** 把各尺寸图标拼成一张对照图，便于人眼确认小尺寸是否可辨 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
setTimeout(() => app.exit(2), 20000);

app.whenReady().then(async () => {
  const dir = path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'assets');
  const sizes = [16, 20, 32, 48, 64, 128, 256];
  const cells = sizes.map((s) =>
    `<div class="cell"><img src="file:///${path.join(dir, `tray-${s}.png`).replace(/\/g, '/')}" width="${s}" height="${s}"><div>${s}px</div></div>`
  ).join('');
  const html = `<html><body style="margin:0;background:#111826;color:#8b96ab;font:12px sans-serif">
    <div style="display:flex;align-items:flex-end;gap:24px;padding:28px">${cells}</div>
  </body></html>`;
  const tmp = path.resolve(__dirname, '..', '..', '_icon_sheet.html');
  fs.writeFileSync(tmp, html, 'utf8');

  const win = new BrowserWindow({ width: 760, height: 360, show: false, backgroundColor: '#111826' });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 600));
  const out = path.resolve(__dirname, '..', '..', 'icon-sheet.png');
  fs.writeFileSync(out, (await win.capturePage()).toPNG());
  console.log('saved', out);
  app.exit(0);
});
