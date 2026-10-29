'use strict';
/**
 * 托盘图标：运行时用原始 RGBA 像素直接生成，不依赖任何图片文件。
 *
 * 为什么不用 PNG 文件：
 *  1) 少一层「文件没打包进去 / 解码失败」的失效点；
 *  2) 可以按任意尺寸重画，缩放到托盘尺寸时不糊。
 *
 * 形象：戴耳麦的虚拟助理半身像（头 + 肩剪影 + 头戴式耳麦 + 麦杆）。
 * 早期版本是「亮蓝块 + 三条白线」，用户评价「像汉堡菜单，不像辅助软件」，故重做为头像。
 * 小尺寸（<32）自动省掉耳麦细节，避免糊成一团。
 */
const { nativeImage } = require('electron');

const BG_TOP = [59, 130, 246];    // #3b82f6 蓝
const BG_BOT = [6, 182, 212];     // #06b6d4 青
const FIGURE = [255, 255, 255];   // 人物剪影
const GEAR = [15, 23, 42];        // 耳麦 #0f172a

/** 圆内判定 */
function inCircle(x, y, c) {
  return (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r ** 2;
}

/** 点到线段距离 */
function distToSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const SS = 3; // 超采样抗锯齿

  // 归一化几何（0-1 坐标系，绘制时乘 size）
  const outer = { cx: 0.5, cy: 0.5, r: 0.5 };
  const head = { cx: 0.5, cy: 0.38, r: 0.16 };
  const body = { cx: 0.5, cy: 1.03, r: 0.45 };      // 肩：大圆的下半部分
  const detail = size >= 32;                        // 小尺寸省略耳麦细节
  const band = { cx: 0.5, cy: 0.38, r: 0.205 };     // 头带外沿
  const bandIn = { cx: 0.5, cy: 0.38, r: 0.175 };   // 头带内沿
  const earL = { cx: 0.315, cy: 0.40, r: 0.055 };
  const earR = { cx: 0.685, cy: 0.40, r: 0.055 };
  const mic = { cx: 0.60, cy: 0.535, r: 0.035 };    // 嘴边麦克风头
  const stem = { x0: 0.665, y0: 0.44, x1: 0.615, y1: 0.52, w: 0.022 }; // 麦杆

  /** 判定某点属于哪一层，返回 [r,g,b] 或 null（透明） */
  function colorAt(nx, ny) {
    if (!inCircle(nx, ny, outer)) return null;

    // 人物：头 + 肩
    if (inCircle(nx, ny, head) || inCircle(nx, ny, body)) return FIGURE;

    if (detail) {
      if (inCircle(nx, ny, earL) || inCircle(nx, ny, earR)) return GEAR;
      // 头带：只取上半部分的环带
      if (ny < 0.38 && inCircle(nx, ny, band) && !inCircle(nx, ny, bandIn)) return GEAR;
      if (inCircle(nx, ny, mic)) return GEAR;
      if (distToSeg(nx, ny, stem.x0, stem.y0, stem.x1, stem.y1) <= stem.w) return GEAR;
    }

    // 背景：上蓝下青的线性渐变
    const t = Math.min(1, Math.max(0, ny));
    return [
      Math.round(BG_TOP[0] * (1 - t) + BG_BOT[0] * t),
      Math.round(BG_TOP[1] * (1 - t) + BG_BOT[1] * t),
      Math.round(BG_TOP[2] * (1 - t) + BG_BOT[2] * t),
    ];
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          const c = colorAt(nx, ny);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
        }
      }
      const i = (y * size + x) * 4;
      const n = SS * SS;
      if (!hits) { buf[i + 3] = 0; continue; }
      // nativeImage.createFromBuffer / toBitmap 的像素格式是 **BGRA**（预乘前），
      // 按 RGBA 写会把蓝色画成青绿色 —— 已实测踩过，务必保持 B,G,R 顺序。
      buf[i] = Math.round(b / n);         // B
      buf[i + 1] = Math.round(g / n);     // G
      buf[i + 2] = Math.round(r / n);     // R
      buf[i + 3] = Math.round(255 * (hits / n));
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 1 });
}

/**
 * 生成托盘图标。优先 64px（Electron 会按需缩放），失败则退 32px。
 * @returns {Electron.NativeImage}
 */
function createTrayImage() {
  let img = draw(64);
  if (!img || img.isEmpty()) img = draw(32);
  return img;
}

/** 写出 PNG 文件，供安装包与「关于」页使用 */
function writeIconFiles(outDir) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const s of [16, 20, 32, 48, 64, 128, 256]) {
    const p = path.join(outDir, `tray-${s}.png`);
    fs.writeFileSync(p, draw(s).toPNG());
    written.push(p);
  }
  return written;
}

module.exports = { createTrayImage, writeIconFiles, draw };
