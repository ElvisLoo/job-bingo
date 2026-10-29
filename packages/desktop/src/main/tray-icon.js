'use strict';
/**
 * 应用图标：卡通女孩（戴耳麦的面试助理）。
 *
 * 为什么用代码画而不是放 PNG：
 *  1) 少一层「文件没打包进去 / 解码失败」的失效点；
 *  2) 托盘要 16px、桌面要 256px，代码可按尺寸重画，缩小时不糊；
 *  3) 小尺寸能自动省略细节（16px 下眼睛只有 1px，画了反而脏）。
 *
 * 形象：齐肩短发 + 大眼 + 微笑 + 青色耳麦（带嘴边麦克），白衬衫领。
 * 配色沿用产品蓝青渐变，保证与设置页、浮窗一致。
 */

const { nativeImage } = require('electron');

// ---- 调色板 ----
const BG_TOP = [59, 130, 246];     // #3b82f6
const BG_BOT = [6, 182, 212];      // #06b6d4
const HAIR = [74, 48, 38];         // 深棕 #4a3026
const HAIR_HI = [102, 68, 54];     // 高光
const SKIN = [255, 224, 202];      // 肤色
const SKIN_SH = [240, 196, 168];   // 阴影
const EYE = [42, 33, 30];
const MOUTH = [199, 92, 92];
const GEAR = [13, 148, 168];       // 耳麦青
const GEAR_DK = [8, 105, 122];
const SHIRT = [255, 255, 255];
const BLUSH = [255, 168, 168];

/** 圆内判定 */
const inCircle = (x, y, c) => (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r ** 2;

/** 椭圆内判定 */
function inEllipse(x, y, e) {
  const dx = (x - e.cx) / e.rx;
  const dy = (y - e.cy) / e.ry;
  return dx * dx + dy * dy <= 1;
}

/** 圆角矩形内判定（归一化坐标） */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 点到线段距离 */
function distToSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** 环形段判定（用于笑弧、耳麦头带） */
function inRingArc(x, y, cx, cy, r, w, a0, a1) {
  const d = Math.hypot(x - cx, y - cy);
  if (Math.abs(d - r) > w) return false;
  let a = Math.atan2(y - cy, x - cx); // -PI..PI
  if (a < 0) a += Math.PI * 2;
  let s = a0, e = a1;
  if (s < 0) s += Math.PI * 2;
  if (e < 0) e += Math.PI * 2;
  return s <= e ? (a >= s && a <= e) : (a >= s || a <= e);
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const SS = 4;                 // 超采样，边缘更干净
  const R = Math.PI;            // 弧度简写

  // 尺寸分级：<=20 极简，<=40 简化，其余完整
  const tiny = size <= 20;
  const simple = size <= 40;
  const full = !simple;

  // ---- 几何（0..1 归一化）----
  const bg = { x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0, r: 0.22 };

  // 头发（后层，含齐肩）
  const hairBack = { cx: 0.5, cy: 0.455, rx: 0.292, ry: 0.335 };
  const sideL = { cx: 0.225, cy: 0.635, rx: 0.068, ry: 0.170 };
  const sideR = { cx: 0.775, cy: 0.635, rx: 0.068, ry: 0.170 };

  // 脸
  const face = { cx: 0.5, cy: 0.505, rx: 0.298, ry: 0.315 };

  // 刘海：只盖额头。
  // 之前 cy=0.40 / ry=0.155 会盖到脸中部（y=0.555），眼睛和嘴全被埋了，
  // 缩到 16px 就只剩一团深色 —— 是像素验证脚本发现的。
  const bangs = { cx: 0.5, cy: 0.318, rx: 0.303, ry: 0.118 };

  // 五官
  const eyeL = { cx: 0.408, cy: 0.545, rx: 0.050, ry: 0.063 };
  const eyeR = { cx: 0.592, cy: 0.545, rx: 0.050, ry: 0.063 };
  const hlL = { cx: 0.393, cy: 0.525, r: 0.019 };
  const hlR = { cx: 0.577, cy: 0.525, r: 0.019 };
  const blushL = { cx: 0.325, cy: 0.615, rx: 0.046, ry: 0.028 };
  const blushR = { cx: 0.675, cy: 0.615, rx: 0.046, ry: 0.028 };

  // 耳麦
  const bandR = 0.318, bandW = 0.030, bandCy = 0.50;
  const cupL = { cx: 0.203, cy: 0.565, rx: 0.058, ry: 0.082 };
  const cupR = { cx: 0.797, cy: 0.565, rx: 0.058, ry: 0.082 };
  const micTip = { cx: 0.685, cy: 0.700, r: 0.032 };

  // 衬衫
  const shirtY = 0.875;

  function colorAt(x, y) {
    if (!inRoundRect(x, y, bg.x0, bg.y0, bg.x1, bg.y1, bg.r)) return null;

    // ---- 身体：肩膀 + 白衬衫 ----
    if (y > shirtY) {
      const sh = (y - shirtY) / (1 - shirtY);
      // 肩线：越往下越宽
      const halfW = 0.30 + sh * 0.20;
      if (Math.abs(x - 0.5) < halfW) {
        // 领口 V 形
        const collar = Math.abs(x - 0.5) < 0.055 + sh * 0.02 && y < shirtY + 0.10;
        if (collar) return SKIN;
        return SHIRT;
      }
    }

    // ---- 头发后层 ----
    // 注意：必须把脸的区域挖掉，否则 hairBack 整块包住脸，
    // 脸永远画不出来（之前就是这样，128px 看是小圆点，16px 只剩一团深色）。
    if ((inEllipse(x, y, hairBack) || inEllipse(x, y, sideL) || inEllipse(x, y, sideR))
        && !inEllipse(x, y, face)) {
      // 头发高光：左上偏亮
      if (full && inEllipse(x, y, { cx: 0.40, cy: 0.295, rx: 0.085, ry: 0.042 })) return HAIR_HI;
      return HAIR;
    }

    // ---- 脸 ----
    if (inEllipse(x, y, face)) {
      // 刘海压在脸上
      if (inEllipse(x, y, bangs)) return HAIR;

      if (full) {
        // 腮红
        if (inEllipse(x, y, blushL) || inEllipse(x, y, blushR)) return BLUSH;
        // 眼睛
        if (inEllipse(x, y, eyeL) || inEllipse(x, y, eyeR)) {
          if (inCircle(x, y, hlL) || inCircle(x, y, hlR)) return [255, 255, 255];
          return EYE;
        }
        // 嘴：一段小圆弧
        if (inRingArc(x, y, 0.5, 0.625, 0.060, 0.015, R * 0.15, R * 0.85)) return MOUTH;
        // 下巴阴影
        if (y > 0.755) return SKIN_SH;
      } else if (!tiny) {
        // 简化版：只留两只眼睛的暗块，去掉高光与嘴
        if (inEllipse(x, y, { cx: 0.42, cy: 0.52, rx: 0.055, ry: 0.065 })) return EYE;
        if (inEllipse(x, y, { cx: 0.58, cy: 0.52, rx: 0.055, ry: 0.065 })) return EYE;
      }
      return SKIN;
    }

    // ---- 耳麦 ----
    if (!tiny) {
      // 头带：跨过头发顶部
      if (y < bandCy && inRingArc(x, y, 0.5, bandCy, bandR, bandW, R * 1.05, R * 1.95)) return GEAR;
      // 耳罩
      if (inEllipse(x, y, cupL) || inEllipse(x, y, cupR)) {
        if (full && (inEllipse(x, y, { cx: cupL.cx, cy: cupL.cy, rx: 0.032, ry: 0.05 })
                  || inEllipse(x, y, { cx: cupR.cx, cy: cupR.cy, rx: 0.032, ry: 0.05 }))) return GEAR_DK;
        return GEAR;
      }
      // 麦克风杆 + 麦头（只画右侧，避免挡住嘴）
      if (full) {
        if (distToSeg(x, y, 0.80, 0.625, 0.70, 0.690) <= 0.017) return GEAR;
        if (inCircle(x, y, micTip)) return GEAR_DK;
      }
    }

    // ---- 背景渐变 ----
    const t = Math.min(1, Math.max(0, y));
    return [
      Math.round(BG_TOP[0] * (1 - t) + BG_BOT[0] * t),
      Math.round(BG_TOP[1] * (1 - t) + BG_BOT[1] * t),
      Math.round(BG_TOP[2] * (1 - t) + BG_BOT[2] * t),
    ];
  }

  const n = SS * SS;
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
      if (!hits) { buf[i + 3] = 0; continue; }
      // nativeImage 的 bitmap 是 BGRA 顺序，按 RGBA 写会把蓝画成青 —— 已实测踩过
      buf[i] = Math.round(b / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(r / n);
      buf[i + 3] = Math.round(255 * (hits / n));
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size, scaleFactor: 1 });
}

/**
 * 托盘图标：16–32px 用简化版（细节会糊成一团），64px 用完整版。
 * Windows 托盘在高 DPI 下会取 32px，所以这里给 64px 让系统自己缩。
 */
function createTrayImage() {
  let img = draw(64);
  if (!img || img.isEmpty()) img = draw(32);
  return img;
}

/**
 * 窗口 / 任务栏 / 桌面快捷方式用的大图标。
 * 托盘要小（32px 就够），但窗口图标在任务栏和 Alt+Tab 里是 256px，
 * 给 64px 会被系统拉大，边缘发虚。
 */
function createAppIcon() {
  let img = draw(256);
  if (!img || img.isEmpty()) img = draw(128);
  return img;
}

/** 写出各尺寸 PNG，供安装包与窗口图标使用 */
function writeIconFiles(outDir) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const s of [16, 20, 24, 32, 48, 64, 128, 256, 512]) {
    const p = path.join(outDir, `tray-${s}.png`);
    fs.writeFileSync(p, draw(s).toPNG());
    written.push(p);
  }
  return written;
}

module.exports = { createTrayImage, createAppIcon, writeIconFiles, draw };
