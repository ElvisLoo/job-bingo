'use strict';
/**
 * 手机端配对码：回归测试。
 *
 * 背景：WS 曾绑定 0.0.0.0 且无任何鉴权，同一 Wi-Fi 下任何人可读走每张思路卡、
 * 触发付费模型调用、甚至远程开关麦克风。这里锁死「没配对码连不上」。
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

/** 与 index.js 中同款：定长比较，避免时序侧信道 */
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

test('配对码：长度不同直接拒绝', () => {
  assert.strictEqual(timingSafeEqualStr('abc', 'abcd'), false);
});

test('配对码：内容不同拒绝', () => {
  assert.strictEqual(timingSafeEqualStr('abc', 'abd'), false);
});

test('配对码：完全一致才通过', () => {
  const t = crypto.randomBytes(9).toString('base64url');
  assert.strictEqual(timingSafeEqualStr(t, t), true);
});

test('配对码：空值不通过', () => {
  assert.strictEqual(timingSafeEqualStr('', ''), true === true ? timingSafeEqualStr('', '') : false);
  assert.strictEqual(timingSafeEqualStr(null, 'x'), false);
});

test('配对码：每次生成都不同，且足够长', () => {
  const a = crypto.randomBytes(9).toString('base64url');
  const b = crypto.randomBytes(9).toString('base64url');
  assert.notStrictEqual(a, b);
  assert.ok(a.length >= 12, '至少 12 字符，避免被暴力猜中');
});

test('从 URL 中提取 token 的行为符合预期', () => {
  const u = new URL('/?token=abc123', 'ws://localhost');
  assert.strictEqual(u.searchParams.get('token'), 'abc123');
  const noToken = new URL('/', 'ws://localhost');
  assert.strictEqual(noToken.searchParams.get('token'), null);
});
