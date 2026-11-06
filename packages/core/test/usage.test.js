'use strict';
/**
 * usage.js 的单元测试
 *
 * 重点守三件事：
 *  1. 缓存命中不能重复计费（否则账单虚高好几倍）
 *  2. 未知模型只统计 token，绝不瞎估金额
 *  3. 厘为整数单位，累加不产生浮点尾数
 */
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/usage.js');

test('normalizeModel 去掉日期后缀与版本尾巴', () => {
  assert.strictEqual(U.normalizeModel('deepseek-chat'), 'deepseek-chat');
  assert.strictEqual(U.normalizeModel('glm-4-plus-20260101'), 'glm-4-plus');
  assert.strictEqual(U.normalizeModel('glm-4-plus-2026-01-01'), 'glm-4-plus');
  assert.strictEqual(U.normalizeModel('DeepSeek-Chat'), 'deepseek-chat');
  assert.strictEqual(U.normalizeModel('deepseek-chat-v3'), 'deepseek-chat');
  assert.strictEqual(U.normalizeModel(''), '');
  assert.strictEqual(U.normalizeModel(null), '');
});

test('priceOf 对未收录模型返回 known:false 且单价为 0', () => {
  const p = U.priceOf('some-local-llm');
  assert.strictEqual(p.known, false);
  assert.strictEqual(p.in, 0);
  assert.strictEqual(p.out, 0);
});

test('priceOf 支持用户覆盖单价', () => {
  const p = U.priceOf('my-model', { 'my-model': { in: 10, cacheHit: 1, out: 30 } });
  assert.strictEqual(p.known, true);
  assert.strictEqual(p.in, 10);
  assert.strictEqual(p.out, 30);
});

test('parseUsage 兼容三种缓存字段写法', () => {
  const a = U.parseUsage({ prompt_tokens: 1000, completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 600 } });
  assert.deepStrictEqual(a, { prompt: 1000, completion: 200, cached: 600, total: 1200 });

  const b = U.parseUsage({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 600 });
  assert.deepStrictEqual(b, { prompt: 1000, completion: 200, cached: 600, total: 1200 });

  const c = U.parseUsage({ prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 600 });
  assert.strictEqual(c.cached, 600);
});

test('parseUsage 对缺失或异常值返回 0 而不是 NaN', () => {
  for (const v of [null, undefined, {}, { prompt_tokens: 'x' }, { prompt_tokens: -5 }]) {
    const u = U.parseUsage(v);
    assert.strictEqual(u.prompt, 0);
    assert.strictEqual(u.completion, 0);
    assert.strictEqual(u.cached, 0);
  }
});

test('cached 超过 prompt 时被夹到 prompt，不会出现负数计费', () => {
  const u = U.parseUsage({ prompt_tokens: 100, completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 999 } });
  assert.strictEqual(u.cached, 100);
});

test('costOf：缓存部分按缓存价算，不重复计入普通输入', () => {
  // deepseek-chat: in=2, cacheHit=0.5, out=8（元/百万 token）
  const c = U.costOf({
    prompt_tokens: 2000, completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 1200 }
  }, 'deepseek-chat');

  // 普通输入 800 * 2 / 1e6 = 0.0016 元
  // 缓存     1200 * 0.5 / 1e6 = 0.0006 元
  // 输出      300 * 8 / 1e6 = 0.0024 元
  // 合计 0.0046 元 = 4.6 厘。costOf 不取整（避免小额被吃掉），
  // 账本累加时才按 1/1000 厘的整数记账
  assert.ok(Math.abs(c.costMilli - 4.6) < 1e-9, '实际 ' + c.costMilli);
  assert.strictEqual(c.known, true);
});

test('costOf：无缓存时全额按普通输入价', () => {
  const c = U.costOf({ prompt_tokens: 1000000, completion_tokens: 0 }, 'deepseek-chat');
  assert.strictEqual(c.costMilli, 2000); // 2 元 = 2000 厘
});

test('costOf：未知模型 costMilli 为 0 且标记 known:false', () => {
  const c = U.costOf({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'no-such-model');
  assert.strictEqual(c.costMilli, 0);
  assert.strictEqual(c.known, false);
});

test('addCall 累加到 ledger 并分模型统计', () => {
  const l = U.createLedger();
  U.addCall(l, { prompt_tokens: 100, completion_tokens: 10 }, 'deepseek-chat');
  U.addCall(l, { prompt_tokens: 200, completion_tokens: 20 }, 'deepseek-chat');
  U.addCall(l, { prompt_tokens: 300, completion_tokens: 30 }, 'glm-4-plus');

  assert.strictEqual(l.calls, 3);
  assert.strictEqual(l.prompt, 600);
  assert.strictEqual(l.completion, 60);
  assert.strictEqual(l.byModel['deepseek-chat'].calls, 2);
  assert.strictEqual(l.byModel['glm-4-plus'].calls, 1);
});

test('addCall 统计未收录单价的调用次数', () => {
  const l = U.createLedger();
  U.addCall(l, { prompt_tokens: 100, completion_tokens: 10 }, 'private-model');
  assert.strictEqual(l.unknownCalls, 1);
  assert.strictEqual(l.costMilli, 0);
});

test('addCall 对空 ledger 不抛异常', () => {
  assert.doesNotThrow(() => U.addCall(null, { prompt_tokens: 1 }, 'deepseek-chat'));
});

test('金额累加不产生浮点尾数', () => {
  const l = U.createLedger();
  // 每次 50 token * 2 元/1M = 0.0001 元，累加 100 次应是 0.01 元 = 10 厘
  for (let i = 0; i < 100; i++) {
    U.addCall(l, { prompt_tokens: 50, completion_tokens: 0 }, 'deepseek-chat');
  }
  assert.strictEqual(l.costMilli, 10);
  assert.strictEqual(U.formatMoney(l.costMilli), '¥0.010');
});

test('formatMoney 分级保留小数位', () => {
  assert.strictEqual(U.formatMoney(0), '¥0');
  assert.strictEqual(U.formatMoney(1), '¥0.001');
  assert.strictEqual(U.formatMoney(50), '¥0.050');
  assert.strictEqual(U.formatMoney(350), '¥0.35');
  assert.strictEqual(U.formatMoney(12500), '¥12.50');
  assert.strictEqual(U.formatMoney(-5), '¥0');
});

test('formatTokens 加千分位', () => {
  assert.strictEqual(U.formatTokens(0), '0');
  assert.strictEqual(U.formatTokens(999), '999');
  assert.strictEqual(U.formatTokens(18400), '18,400');
  assert.strictEqual(U.formatTokens(1234567), '1,234,567');
});

test('summarize 给出可读摘要并标注缓存比例', () => {
  const l = U.createLedger();
  U.addCall(l, { prompt_tokens: 2000, completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 1200 } }, 'deepseek-chat');
  const s = U.summarize(l);
  assert.ok(s.includes('1 次调用'), s);
  assert.ok(s.includes('2.0k 输入'), s);
  assert.ok(s.includes('缓存 60%'), s);
  assert.ok(s.includes('300 输出'), s);
  assert.ok(s.includes('¥'), s);
});

test('summarize 对未知模型明确说明未计入金额', () => {
  const l = U.createLedger();
  U.addCall(l, { prompt_tokens: 1000, completion_tokens: 100 }, 'mystery-llm');
  const s = U.summarize(l);
  assert.ok(s.includes('mystery-llm'), s);
  assert.ok(s.includes('未收录单价'), s);
});

test('summarize 空账本不报错', () => {
  assert.doesNotThrow(() => U.summarize(null));
  assert.ok(U.summarize(null).includes('0 次调用'));
});

test('summarize 支持自定义后缀', () => {
  const l = U.createLedger();
  const s = U.summarize(l, { suffix: '（本场）' });
  assert.ok(s.endsWith('（本场）'), s);
});

test('fromEntries 从会话记录重建账本，跳过无用条目', () => {
  const ledger = U.fromEntries([
    { usage: { prompt_tokens: 100, completion_tokens: 10 }, model: 'deepseek-chat' },
    { usage: null, model: 'deepseek-chat' },
    null,
    { usage: { prompt_tokens: 200, completion_tokens: 20 }, model: 'deepseek-chat' }
  ]);
  assert.strictEqual(ledger.calls, 2);
  assert.strictEqual(ledger.prompt, 300);
});

test('fromEntries 对非数组返回空账本', () => {
  for (const v of [null, undefined, {}, 'x', 0]) {
    const l = U.fromEntries(v);
    assert.strictEqual(l.calls, 0);
  }
});

test('百万 token 级别的费用与人工计算一致', () => {
  // deepseek-chat 跑满 100 万输入 + 50 万输出：
  // 输入 2 元 + 输出 0.5M * 8 / 1M = 4 元，合计 6 元 = 6000 厘
  const c = U.costOf({ prompt_tokens: 1000000, completion_tokens: 500000 }, 'deepseek-chat');
  assert.strictEqual(c.costMilli, 6000);
  assert.strictEqual(U.formatMoney(c.costMilli), '¥6.00');
});
