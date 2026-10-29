'use strict';
/**
 * 验收项 4（自动化版）：packages/asr 内不得出现任何 Electron 依赖，
 * 且所有模块必须能在纯 Node（非 Electron）环境里 require 成功。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');

const FORBIDDEN = [
  /require\(\s*['"]electron['"]\s*\)/, // require('electron')
  /from\s+['"]electron['"]/, // import ... from 'electron'
  /import\(\s*['"]electron['"]\s*\)/, // await import('electron')
  /require\(\s*['"]@electron\/[^'"]+['"]\s*\)/,
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('packages/asr/src 下没有任何 electron 依赖', () => {
  const files = walk(SRC_DIR);
  assert.ok(files.length >= 7, `源文件数量应 ≥7，实际 ${files.length}`);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(src), `${path.basename(f)} 命中禁用模式 ${re}`);
    }
  }
});

test('packages/asr/src 下也没有 stealth / 内容保护相关代码', () => {
  for (const f of walk(SRC_DIR)) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/stealth/i.test(src), `${path.basename(f)} 含 stealth`);
    assert.ok(!/setContentProtection/i.test(src), `${path.basename(f)} 含内容保护逻辑`);
  }
});

test('每个模块都能在纯 Node 环境 require', () => {
  for (const f of walk(SRC_DIR)) {
    const mod = require(f);
    assert.ok(mod && typeof mod === 'object', `${path.basename(f)} 应导出对象`);
  }
});

test('package.json 未声明 electron 依赖', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  assert.ok(!deps.electron, 'asr 包不得依赖 electron');
  assert.strictEqual(pkg.main, 'src/index.js');
});
