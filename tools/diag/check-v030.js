'use strict';
/** 校验 0.3.0 产物：新代码在不在、临时文件清没清 */
const asar = require('@electron/asar');

const f = 'dist/win-unpacked/resources/app.asar';
const idx = asar.listPackage(f);
const sep = String.fromCharCode(92);
const norm = idx.map((p) => ({ raw: p, posix: p.split(sep).join('/') }));

console.log('文件数:', idx.length);

const find = (suffix) => norm.find((e) => e.posix.endsWith(suffix));
const read = (e) => asar.extractFile(f, e.raw.replace(/^[\\/]+/, '')).toString('utf8');

const ctx = find('core/src/context.js');
console.log('含 context.js:', !!ctx);
if (ctx) {
  const s = read(ctx);
  console.log('  滑动二元组说明:', s.includes('滑动二元组') ? '✓' : '✗');
  console.log('  findRelated:', s.includes('findRelated') ? '✓' : '✗');
  console.log('  buildContext:', s.includes('buildContext') ? '✓' : '✗');
}

const pr = find('core/src/prompt.js');
if (pr) {
  const s = read(pr);
  console.log('prompt 引用 context:', s.includes("require('./context')") ? '✓' : '✗');
  console.log('prompt 单条 system:', s.includes('sysBlocks') ? '✓' : '✗');
}

const tmp = norm.filter((e) => /\.tmp\.js$/.test(e.posix));
console.log('临时文件:', tmp.length === 0 ? '已清空 ✓' : ('残留 ' + tmp.length + ' 个 ✗'));
if (tmp.length) tmp.forEach((t) => console.log('   ', t.posix));

const pj = JSON.parse(asar.extractFile(f, 'package.json').toString('utf8'));
console.log('版本:', pj.version);
