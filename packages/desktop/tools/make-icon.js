'use strict';
/**
 * 写出图标文件（多尺寸 PNG），供安装包与「关于」页使用。
 * 绘制逻辑统一来自 packages/desktop/src/main/tray-icon.js 的 draw()，避免两套实现。
 * 注意：本脚本需要 Electron 的 nativeImage，必须用 tools/icon-run.js 之类的方式
 * 在 Electron 环境下运行，或用 `npx electron` 执行。
 */
const fs = require('fs');
const path = require('path');
const { draw } = require('../src/main/tray-icon');

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });

const sizes = [16, 20, 32, 48, 64, 128, 256];
for (const s of sizes) {
  const img = draw(s);
  if (!img || img.isEmpty()) { console.error(`尺寸 ${s} 生成失败`); continue; }
  const p = path.join(out, `tray-${s}.png`);
  fs.writeFileSync(p, img.toPNG());
  console.log(`tray-${s}.png ${fs.statSync(p).size} bytes`);
}
console.log('输出目录:', out);
