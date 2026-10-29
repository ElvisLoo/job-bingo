'use strict';
/**
 * 像素级验证图标：不依赖截图。
 * 检查：尺寸正确、四角透明（圆角）、中心是肤色（脸）、
 * 上方是深色（头发）、背景是蓝青（不是全白/全黑）。
 */
const path = require('path');
const { app } = require('electron');
const { draw } = require('../../packages/desktop/src/main/tray-icon');

app.whenReady().then(() => {
  const out = [];
  for (const s of [16, 32, 64, 256]) {
    const img = draw(s);
    const size = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    const px = (x, y) => {
      const i = (y * size.width + x) * 4;
      return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]]; // -> RGBA
    };
    const c = Math.floor(size.width / 2);
    const face = px(c, Math.floor(size.height * 0.55));
    const hair = px(c, Math.floor(size.height * 0.22));
    const corner = px(0, 0);
    const bg = px(Math.floor(size.width * 0.06), Math.floor(size.height * 0.5));
    out.push({
      size: `${size.width}x${size.height}`,
      cornerAlpha: corner[3],
      face, hair, bg,
      faceIsSkin: face[0] > 200 && face[1] > 150 && face[2] > 120 && face[0] > face[2],
      hairIsDark: hair[0] < 150 && hair[1] < 120,
      bgIsBlue: bg[2] > bg[0] && bg[2] > 120,
    });
  }
  console.log(JSON.stringify(out, null, 1));
  app.exit(0);
});
