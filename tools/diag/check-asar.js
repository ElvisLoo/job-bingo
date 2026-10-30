'use strict';
/**
 * 打包产物核验：确认 dist 里的 asar 真的含本次代码，
 * 而不是拿旧产物当新版发出去。
 */
const asar = require('@electron/asar');

const f = 'dist/win-unpacked/resources/app.asar';
const idx = asar.listPackage(f);
const norm = idx.map((p) => ({ raw: p, posix: p.split('\\').join('/') }));

console.log('asar 文件数:', idx.length);

function read(suffix) {
  const hit = norm.find((e) => e.posix.endsWith(suffix));
  if (!hit) return null;
  return asar.extractFile(f, hit.raw.replace(/^[\\/]/, '')).toString('utf8');
}

let allOk = true;
const main = read('src/main/index.js');
if (!main) { console.log('✗ 缺少 src/main/index.js'); allOk = false; } else {
  for (const k of ['shortcutFailures', 'function nudgeOpacity', 'shortcuts:retry', '热键被其它软件占用']) {
    const ok = main.includes(k);
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✓' : '✗'} main: ${k}`);
  }
}

const html = read('renderer/settings.html');
const css = read('renderer/settings.css');
const js = read('renderer/settings.js');
for (const [name, content, key] of [['settings.html', html, 'hotkeyWarn'], ['settings.css', css, '.hotkey-warn'], ['settings.js', js, 'renderShortcuts']]) {
  const ok = !!content && content.includes(key);
  if (!ok) allOk = false;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${key}`);
}

const ver = JSON.parse(asar.extractFile(f, 'package.json').toString('utf8')).version;
console.log('内置版本:', ver);
console.log(allOk ? '结论：产物包含全部本次改动' : '结论：产物不完整');
process.exit(allOk ? 0 : 1);
