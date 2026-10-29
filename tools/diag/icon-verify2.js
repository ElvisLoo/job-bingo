'use strict';
/** 更细的图标检查：统计各颜色占比 + 关键部位采样 */
const path = require('path');
const { app } = require('electron');
const { draw } = require('../../packages/desktop/src/main/tray-icon');

const CLOSE = (a, b, tol = 26) => Math.abs(a[0]-b[0])<=tol && Math.abs(a[1]-b[1])<=tol && Math.abs(a[2]-b[2])<=tol;

app.whenReady().then(() => {
  for (const s of [16, 32, 128]) {
    const img = draw(s);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const px = (x, y) => { const i=(y*width+x)*4; return [bmp[i+2],bmp[i+1],bmp[i],bmp[i+3]]; };
    let skin=0, hair=0, eye=0, gear=0, shirt=0, opaque=0, total=0;
    for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
      total++;
      const p = px(x,y);
      if (p[3] < 128) continue;
      opaque++;
      if (CLOSE(p,[255,224,202])||CLOSE(p,[240,196,168])) skin++;
      else if (CLOSE(p,[74,48,38])||CLOSE(p,[102,68,54])) hair++;
      else if (CLOSE(p,[42,33,30])) eye++;
      else if (CLOSE(p,[13,148,168])||CLOSE(p,[8,105,122])) gear++;
      else if (CLOSE(p,[255,255,255])) shirt++;
    }
    const pct = (n) => (100*n/opaque).toFixed(1)+'%';
    console.log(`${width}px | 不透明${opaque}/${total} | 肤${pct(skin)} 发${pct(hair)} 眼${pct(eye)} 耳麦${pct(gear)} 衣${pct(shirt)}`);
  }
  app.exit(0);
});
