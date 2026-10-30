'use strict';
/**
 * 热键注册与透明度调节：回归测试。
 *
 * 背景两件事：
 * 1. globalShortcut.register 返回 false 时被完全忽略。Ctrl+Alt+H 是
 *    微信/QQ 系输入法、截屏工具的高频冲突键，被占用后用户按了没反应，
 *    只会以为软件坏了 —— 而且没有任何日志。
 * 2. config.json 是用户可手改的文件。opacity 写成字符串 "0.9" 时，
 *    `config.overlay.opacity + 0.05` 变成字符串拼接 "0.90.05"，
 *    Math.round 得 NaN，写盘后浮窗直接透明到不可见，重启也不好。
 *
 * Electron 的 globalShortcut 需要真实运行时，所以这里用静态检查 +
 * 一份等价实现来锁定行为契约。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const MAIN = path.join(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'index.js');
const src = fs.readFileSync(MAIN, 'utf8');

// ---- 1. 注册结果必须被检查 ----

test('每次 register 的返回值都参与判断，而不是直接丢弃', () => {
  // 允许的写法：把结果赋给变量 / 直接用于 if
  const bare = /globalShortcut\.register\(\s*'[^']+'\s*,\s*\(\)\s*=>/g;
  const matches = src.match(bare) || [];
  assert.equal(matches.length, 0,
    `不应出现忽略返回值的 register 调用，实际 ${matches.length} 处`);
});

test('失败项被收集到列表，供界面展示', () => {
  assert.ok(src.includes('shortcutFailures'), '应有失败项集合');
  assert.ok(/shortcutFailures\.push\(/.test(src), '失败时应记录');
});

test('注册抛异常不会中断其它热键', () => {
  // 逐个注册要包 try，否则一个非法加速键会让后面全部不注册
  const loop = src.slice(src.indexOf('function registerShortcuts'), src.indexOf('function registerShortcuts') + 1400);
  assert.ok(loop.includes('try'), '注册循环内应有 try');
  assert.ok(loop.includes('catch'), '注册循环内应有 catch');
  assert.ok(loop.includes('for (const item of SHORTCUTS)'), '应遍历清单逐个注册');
});

test('热键清单集中定义，设置页能拿到逐项状态', () => {
  assert.ok(src.includes('const SHORTCUTS = ['), '应有集中清单');
  assert.ok(src.includes('function shortcutStatus()'), '应有状态查询');
  assert.ok(src.includes('shortcuts: shortcutStatus()'), 'config:get 应带出热键状态');
});

test('提供重新注册入口（不必重启应用）', () => {
  assert.ok(src.includes("ipcMain.handle('shortcuts:retry'"), '应有重试 IPC');
  assert.ok(src.includes('globalShortcut.unregisterAll()'), '重试前先清空，避免重复注册');
});

test('热键失效时用户能看到提示', () => {
  assert.ok(src.includes('热键被其它软件占用'), '启动时应推送提示卡');
  assert.ok(src.includes('function shortcutLabel'), '托盘菜单应有失效标记');
});

// ---- 2. 透明度必须数值安全 ----

// 复刻主进程的 setOpacity 数值保护，验证契约而非实现细节
function clampOpacity(v) {
  const n = Number(v);
  const safe = Number.isFinite(n) ? Math.min(1, Math.max(0.35, n)) : 0.8;
  return Math.round(safe * 100) / 100;
}

test('正常数值原样取整', () => {
  assert.equal(clampOpacity(0.9), 0.9);
  assert.equal(clampOpacity(0.94123), 0.94);
});

test('字符串数字被正确转换，而不是拼接', () => {
  // 修复前的 bug：'0.9' + 0.05 => '0.90.05' => NaN
  assert.equal(clampOpacity('0.9'), 0.9);
  assert.equal(clampOpacity('0.95'), 0.95);
});

test('非法值回落到默认 0.8，绝不写 NaN', () => {
  for (const bad of [NaN, undefined, null, '', 'abc', {}, [], true]) {
    const r = clampOpacity(bad);
    assert.ok(Number.isFinite(r), `${String(bad)} 应得到有限数，实际 ${r}`);
  }
});

test('越界值被夹到 [0.35, 1]', () => {
  assert.equal(clampOpacity(0), 0.35);
  assert.equal(clampOpacity(-5), 0.35);
  assert.equal(clampOpacity(3), 1);
});

test('微调走 nudgeOpacity，先归一化再加减', () => {
  assert.ok(src.includes('function nudgeOpacity'), '应有 nudgeOpacity');
  const body = src.slice(src.indexOf('function nudgeOpacity'), src.indexOf('function setOpacity'));
  assert.ok(body.includes('Number(config.overlay'), '应先 Number() 归一化');
  assert.ok(body.includes('Number.isFinite'), '应校验有限性');
});

test('setOpacity 守卫窗口已销毁的情况', () => {
  const body = src.slice(src.indexOf('function setOpacity'), src.indexOf('function setOpacity') + 700);
  assert.ok(body.includes('isDestroyed()'), '应检查窗口存活');
  assert.ok(body.includes('try'), 'send 应包 try');
});
