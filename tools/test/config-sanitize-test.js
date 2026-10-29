'use strict';
/**
 * 配置净化：回归测试。
 *
 * 背景：config:set 曾把任意 patch 直接 deepMerge 并落盘。
 * 一次 opacity:"abc" 就让 setOpacity 抛错，且非法值已落盘、重启继续崩；
 * busy.retryMinutes 传 1e9 会让 setTimeout 溢出成 1ms，退避变成疯狂重试。
 */
const test = require('node:test');
const assert = require('node:assert');

// 与 index.js 中同实现（那边未导出，这里镜像一份以锁定行为）
function clampNum(v, min, max, def) {
  // v 为 null / '' / 布尔时 Number() 会得到 0 或 1，看起来「合法」，
  // 于是被夹到边界值而不是回落默认——设置页清空输入框就会触发。
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

test('clampNum：非法值回落默认', () => {
  assert.strictEqual(clampNum('abc', 0, 1, 0.9), 0.9);
  assert.strictEqual(clampNum(NaN, 0, 1, 0.9), 0.9);
  assert.strictEqual(clampNum(undefined, 0, 1, 0.9), 0.9);
  assert.strictEqual(clampNum(null, 0, 1, 0.9), 0.9);
});

test('clampNum：超范围被夹紧', () => {
  assert.strictEqual(clampNum(5, 0.35, 1, 0.9), 1);
  assert.strictEqual(clampNum(-3, 0.35, 1, 0.9), 0.35);
});

test('clampNum：合法值原样保留', () => {
  assert.strictEqual(clampNum('0.8', 0.35, 1, 0.9), 0.8);
});

test('退避参数不会导致 setTimeout 溢出', () => {
  // Node 的 setTimeout 上限是 2^31-1 毫秒（约 24.8 天）
  const MAX_OK = 2147483647;
  const minutes = clampNum(1e9, 1, 120, 5);
  const ms = minutes * 60 * 1000;
  assert.ok(ms <= MAX_OK, `等待 ${ms}ms 会溢出为 1ms，形成忙循环`);
});

test('端口净化：非法端口回落 8787', () => {
  assert.strictEqual(Math.round(clampNum('abc', 1024, 65535, 8787)), 8787);
  assert.strictEqual(Math.round(clampNum(-1, 1024, 65535, 8787)), 1024);
  assert.strictEqual(Math.round(clampNum(99999, 1024, 65535, 8787)), 65535);
  assert.strictEqual(Math.round(clampNum(8787, 1024, 65535, 8787)), 8787);
});

test('不透明度最低 0.35：低于此值浮窗几乎不可见，用户会以为坏了', () => {
  assert.strictEqual(clampNum(0.01, 0.35, 1, 0.94), 0.35);
});
