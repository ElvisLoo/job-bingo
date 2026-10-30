'use strict';
/** 提示词：前缀必须逐字节稳定，否则 KV cache 预热白做 */
const test = require('node:test');
const assert = require('node:assert');
const { SYSTEM_PROMPT, buildStablePrefix, buildMessages, buildWarmupMessages } = require('../src/prompt');

const MD = '[exp-1] 淮北万金天宇 · ERP 实施顾问\n负责库存成本模块';
const JD = '招 ERP 实施顾问，要求懂库存成本';

test('buildStablePrefix：同一份输入必须逐字节相同', () => {
  const a = buildStablePrefix(MD, JD);
  const b = buildStablePrefix(MD, JD);
  assert.strictEqual(a, b);
  assert.strictEqual(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')), 0);
  assert.ok(a.startsWith(SYSTEM_PROMPT));
  assert.ok(a.includes(MD));
  assert.ok(a.includes(JD));
  assert.ok(a.includes('===== 目标岗位 JD ====='));
});

test('buildStablePrefix：JD 变化会改变前缀，JD 为空则不出现 JD 段', () => {
  assert.notStrictEqual(buildStablePrefix(MD, JD), buildStablePrefix(MD, '另一个 JD'));
  const noJd = buildStablePrefix(MD, '   ');
  assert.ok(!noJd.includes('JD'));
  assert.strictEqual(noJd, buildStablePrefix(MD, undefined));
  // 简历未导入时也要稳定，且不能因为 undefined 崩
  assert.ok(buildStablePrefix(undefined, undefined).includes('（未提供简历）'));
});

test('buildMessages：角色映射与截断', () => {
  const msgs = buildMessages({
    prefix: 'P',
    question: '说说最难的一次故障',
    history: [
      { role: 'them', text: '你做过 ERP 吗' },
      { role: 'me', text: '做过，库存那一块' },
    ],
  });
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[0].content, 'P');
  assert.deepStrictEqual(msgs[1], { role: 'user', content: '（面试官说）你做过 ERP 吗' });
  assert.deepStrictEqual(msgs[2], { role: 'assistant', content: '（我答）做过，库存那一块' });
  assert.strictEqual(msgs[3].role, 'user');
  assert.match(msgs[3].content, /说说最难的一次故障/);
});

test('buildMessages：默认近层 8 条原文，更早的进摘要', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'them', text: `q${i}` }));
  const msgs = buildMessages({ prefix: 'P', question: '现在这个问题', history });
  // system(前缀+摘要) + 8 条近层 + 当前问题
  assert.strictEqual(msgs.length, 10);
  assert.match(msgs[0].content, /问答概要/, '更早的应压进同一条 system');
  assert.match(msgs[0].content, /^P/, '前缀仍在最前，KV cache 不受影响');
  assert.match(msgs[1].content, /q12/, '近层从第 12 条开始');
  assert.match(msgs[8].content, /q19/);
});

test('buildMessages：可以调近层条数', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: 'them', text: `q${i}` }));
  const msgs = buildMessages({
    prefix: 'P', question: 'q', history, contextOpts: { recentTurns: 4 },
  });
  // system + 4 条 + 当前
  assert.strictEqual(msgs.length, 6);
});

test('buildMessages：只允许开头一条 system（严格网关常见限制）', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'me' : 'them', text: `关于订单系统的问题${i}`,
  }));
  const msgs = buildMessages({
    prefix: 'P', question: '那个订单系统怎么做的', history,
  });
  const sys = msgs.filter((m) => m.role === 'system');
  assert.strictEqual(sys.length, 1, 'system 只能有一条');
  assert.strictEqual(msgs[0].role, 'system', '且必须在最前');
  // 相邻角色不得重复
  for (let i = 1; i < msgs.length; i += 1) {
    assert.notStrictEqual(msgs[i].role, msgs[i - 1].role, `第 ${i} 条角色与前一条相同`);
  }
});

test('buildMessages：短会话不插摘要，保持原样', () => {
  const history = [{ role: 'them', text: '短问题' }];
  const msgs = buildMessages({ prefix: 'P', question: '下一个', history });
  assert.strictEqual(msgs.length, 3);
  assert.ok(!msgs.some((m) => m.content.includes('问答概要')));
});

test('buildMessages：脏 history / 空文本不崩也不污染 messages', () => {
  const msgs = buildMessages({
    prefix: 'P',
    question: '问一句',
    history: [null, undefined, 'string', 42, { role: 'them' }, { role: 'them', text: '   ' }, { role: 'other', text: 'x' }, { role: 'me', text: '有效' }],
  });
  assert.strictEqual(msgs.length, 3); // system + 1 条有效 + 当前问题
  assert.deepStrictEqual(msgs[1], { role: 'assistant', content: '（我答）有效' });
});

test('buildMessages：history 非数组 / question 缺失都不崩', () => {
  assert.strictEqual(buildMessages({ prefix: 'P', question: 'x', history: 'nope' }).length, 2);
  const m = buildMessages({ prefix: 'P' });
  assert.ok(!m[1].content.includes('undefined'));
  const m2 = buildMessages({ prefix: 'P', question: undefined });
  assert.ok(!m2[1].content.includes('undefined'));
});

test('buildWarmupMessages：两条且前缀一致', () => {
  const prefix = buildStablePrefix(MD, JD);
  const msgs = buildWarmupMessages(prefix);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[0].content, prefix);
  assert.strictEqual(msgs[1].role, 'user');
  assert.match(msgs[1].content, /预热/);
});
