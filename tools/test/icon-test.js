'use strict';
/**
 * 图标回归测试（纯几何，不依赖 Electron）。
 *
 * 背景：图标是「卡通女孩」，之前两次画坏过 ——
 *   1. 头发后层整块包住脸，脸永远画不出来，小尺寸只剩一团深色；
 *   2. 刘海半径过大盖到脸中部，眼睛和嘴全被埋。
 * 这两次都是靠像素采样才发现的，光看代码看不出来。
 *
 * 这里把「脸要露出来」「头发不能压过脸」固化成断言。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'tray-icon.js');

test('图标源码存在且导出必要函数', () => {
  assert.ok(fs.existsSync(SRC), '找不到 tray-icon.js');
  const src = fs.readFileSync(SRC, 'utf8');
  for (const fn of ['createTrayImage', 'createAppIcon', 'writeIconFiles', 'draw']) {
    assert.ok(src.includes(fn), `应导出 ${fn}`);
  }
});

test('头发与脸是分离的：头发判定必须排除脸的区域', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // 这条断言对应上面第 1 个bug：hairBack 覆盖整脸却先于脸绘制
  const hairBlock = src.slice(src.indexOf('// ---- 头发后层 ----'), src.indexOf('// ---- 脸 ----'));
  assert.ok(
    hairBlock.includes('!inEllipse(x, y, face)'),
    '头发分支必须排除脸部区域，否则脸会被整块盖住'
  );
});

test('刘海只盖额头，不能压到眼睛', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = src.match(/const bangs = \{ cx: ([\d.]+), cy: ([\d.]+), rx: ([\d.]+), ry: ([\d.]+) \}/);
  assert.ok(m, '应能找到 bangs 定义');
  const cy = parseFloat(m[2]);
  const ry = parseFloat(m[4]);
  // 刘海下沿不能低于眼睛中心（0.545）
  assert.ok(cy + ry < 0.545, `刘海下沿 ${(cy + ry).toFixed(3)} 不能超过眼睛中心 0.545`);
});

test('脸的比例要大于头发，否则看着像一团色块', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const face = src.match(/const face = \{ cx: [\d.]+, cy: [\d.]+, rx: ([\d.]+), ry: ([\d.]+) \}/);
  const hair = src.match(/const hairBack = \{ cx: [\d.]+, cy: [\d.]+, rx: ([\d.]+), ry: ([\d.]+) \}/);
  assert.ok(face && hair);
  const faceArea = parseFloat(face[1]) * parseFloat(face[2]);
  const hairArea = parseFloat(hair[1]) * parseFloat(hair[2]);
  assert.ok(faceArea > hairArea * 0.85, `脸的面积 (${faceArea.toFixed(4)}) 不应明显小于头发 (${hairArea.toFixed(4)})`);
});

test('图标支持 16px 到 512px 的完整尺寸梯度', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(/\[16, 20, 24, 32, 48, 64, 128, 256, 512\]/.test(src), 'writeIconFiles 应覆盖 16–512');
});

test('小尺寸自动简化：16px 不画耳麦细节', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(src.includes('const tiny = size <= 20'), '应有 tiny 档位');
  assert.ok(src.includes('if (!tiny)'), '耳麦在小尺寸应被省略');
});

test('BGRA 写入顺序正确（nativeImage 要求）', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // 按 RGBA 写会把蓝画成青，之前实测踩过
  assert.ok(src.includes('buf[i] = Math.round(b / n)'), '第 1 字节应为 B');
  assert.ok(src.includes('buf[i + 2] = Math.round(r / n)'), '第 3 字节应为 R');
});
