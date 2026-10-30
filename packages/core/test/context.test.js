'use strict';
/**
 * 长面试上下文管理：回归测试。
 *
 * 要守住的行为：
 *   1. 追问早期话题时，模型能拿到那段原话（否则只能瞎编指代对象）；
 *   2. 全场不会无限制塞进提示词（token 与成本必须可控）；
 *   3. 当前问题不会既出现在近层、又作为结尾重复（会产生连续 user 消息，
 *      部分网关直接 400）；
 *   4. 各种脏输入不崩。
 */
const test = require('node:test');
const assert = require('node:assert');
const ctx = require('../src/context');
const prompt = require('../src/prompt');

// ---- 关键词 / 相似度 ----

test('关键词去掉停用词与纯数字', () => {
  const k = ctx.keywords('我们那个时候其实是用 Redis 做缓存，QPS 大概 8000');
  assert.ok(k.includes('redis'), '应保留英文技术词（小写）');
  assert.ok(k.includes('缓存'), '应保留实词');
  assert.ok(!k.includes('我们'), '应去掉停用词');
  assert.ok(!k.some((w) => /^\d+$/.test(w)), '应去掉纯数字');
});

test('相似度：同一话题明显高于无关话题', () => {
  const a = ctx.keywords('订单履约系统用 Kafka 削峰');
  const same = ctx.keywords('那个订单系统怎么削峰的');
  const other = ctx.keywords('你们团队有多少人');
  assert.ok(ctx.similarity(a, same) > ctx.similarity(a, other));
});

test('相似度：空输入返回 0，不抛错', () => {
  assert.equal(ctx.similarity([], []), 0);
  assert.equal(ctx.similarity(['a'], []), 0);
});

// ---- 摘要 ----

test('摘要把问答配成一组，未答的标注出来', () => {
  const lines = ctx.summarize([
    { role: 'them', text: '介绍一下你自己' },
    { role: 'me', text: '五年后端' },
    { role: 'them', text: '还有什么想问的' },
  ]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('问：介绍一下你自己'));
  assert.ok(lines[0].includes('答：五年后端'));
  assert.ok(lines[1].includes('（未答）'));
});

test('摘要单行截断，不会把长回答整段带进来', () => {
  const long = 'x'.repeat(500);
  const lines = ctx.summarize([{ role: 'them', text: long }, { role: 'me', text: long }], { charsPerLine: 40 });
  for (const l of lines) assert.ok(l.length < 120, '每行应被截断');
});

test('摘要忽略脏条目', () => {
  const lines = ctx.summarize([null, 'str', { role: 'me', text: '   ' }, { role: 'me', text: 'ok' }]);
  assert.equal(lines.length, 1);
});

// ---- 追问检测 ----

test('追问早期话题命中对应原文', () => {
  const entries = [
    { role: 'them', text: '说说你做的订单履约系统' },
    { role: 'me', text: '用 Kafka 削峰，日订单三百万' },
    { role: 'them', text: '你平时用什么数据库' },
    { role: 'me', text: 'MySQL 为主' },
    { role: 'them', text: '团队多少人' },
    { role: 'me', text: '八个人' },
  ];
  const hits = ctx.findRelated(entries, '那个订单履约系统你刚说怎么削峰的？');
  assert.ok(hits.length > 0, '应命中早期条目');
  assert.ok(hits.some((h) => h.text.includes('Kafka') || h.text.includes('订单')),
    '命中的应是订单相关原话');
});

test('无关的新问题不会误捞早期内容', () => {
  const entries = [
    { role: 'them', text: '说说 Kafka 削峰' },
    { role: 'me', text: '日三百万订单' },
  ];
  const hits = ctx.findRelated(entries, '你期望的薪资是多少？');
  assert.equal(hits.length, 0);
});

test('追问命中数量有上限', () => {
  const entries = [];
  for (let i = 0; i < 30; i += 1) entries.push({ role: 'them', text: '订单系统性能问题' });
  const hits = ctx.findRelated(entries, '订单系统性能怎么优化');
  assert.ok(hits.length <= 4);
});

// ---- 上下文组装 ----

function makeEntries(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'them', text: `第${i}个问题：说说你的项目经验` });
    out.push({ role: 'me', text: `第${i}个回答：做过电商系统` });
  }
  return out;
}

test('近层保留指定条数，其余进摘要', () => {
  const entries = makeEntries(20); // 40 条
  const c = ctx.buildContext({ entries, question: '新的问题', recentTurns: 8 });
  assert.equal(c.recent.length, 8);
  assert.equal(c.stats.summarizedCount, 32);
});

test('摘要行数有上限，超出部分显式标注省略', () => {
  const entries = makeEntries(60); // 120 条
  const c = ctx.buildContext({ entries, question: 'q', recentTurns: 8, maxSummaryLines: 10 });
  assert.ok(c.summaryLines.length <= 11, `含省略提示行，实际 ${c.summaryLines.length}`);
  assert.ok(c.summaryLines.some((l) => l.includes('省略')), '应明确告诉模型有内容被省略');
});

test('摘要保留开头：项目背景不会被后来的重复追问挤掉', () => {
  // 真实场景：开场问项目，中间是几十轮同质化追问
  const entries = [
    { role: 'them', text: '先简单介绍一下你自己' },
    { role: 'me', text: '五年后端，主要做电商订单系统' },
    { role: 'them', text: '最有成就感的项目' },
    { role: 'me', text: '订单履约系统，用 Kafka 削峰' },
  ];
  for (let i = 0; i < 40; i += 1) {
    entries.push({ role: 'them', text: `扩展问题${i}：你怎么看团队协作` });
    entries.push({ role: 'me', text: `协作关键在于对齐目标，第${i}次回答` });
  }
  const c = ctx.buildContext({ entries, question: 'q', maxSummaryLines: 12 });
  const joined = c.summaryLines.join(' || ');
  assert.ok(joined.includes('订单履约系统'), '开场的项目背景必须保留');
  assert.ok(joined.includes('介绍一下你自己'), '自我介绍也要保留');
});

test('相邻高度重复的问答被去重', () => {
  const entries = [];
  for (let i = 0; i < 20; i += 1) {
    entries.push({ role: 'them', text: '你还有什么问题问我吗' });
    entries.push({ role: 'me', text: '暂时没有，谢谢' });
  }
  const c = ctx.buildContext({ entries, question: 'q', maxSummaryLines: 24 });
  assert.ok(c.summaryLines.length <= 2, `重复问答应被压缩，实际 ${c.summaryLines.length} 行`);
});

test('短面试不产生摘要（没必要）', () => {
  const c = ctx.buildContext({ entries: makeEntries(2), question: 'q', recentTurns: 8 });
  assert.equal(c.summaryLines.length, 0);
  assert.equal(c.stats.summarizedCount, 0);
});

test('当前问题已在 entries 末尾时不重复，也不产生连续 user', () => {
  const q = '你刚才提到的那个项目，具体怎么做的？';
  const entries = [
    { role: 'them', text: '介绍项目' },
    { role: 'me', text: '订单系统' },
    { role: 'them', text: '好的，' + q },
  ];
  const msgs = prompt.buildMessages({ prefix: 'SYS', question: q, entries });
  const roles = msgs.map((m) => m.role);
  for (let i = 1; i < roles.length; i += 1) {
    assert.notEqual(roles[i], roles[i - 1], `第 ${i} 条与上一条角色相同`);
  }
});

test('带语气词的原话也能去重', () => {
  const q = '性能怎么保证';
  const entries = [{ role: 'them', text: '嗯，那性能怎么保证呢' }];
  const c = ctx.buildContext({ entries, question: q, recentTurns: 8 });
  assert.equal(c.recent.length, 0, '应识别为同一句话');
});

test('空 entries 不崩，仍能构造出提问', () => {
  const msgs = prompt.buildMessages({ prefix: 'SYS', question: '你好', entries: [] });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, 'user');
});

test('未传 entries 时兼容旧的 history 参数', () => {
  const msgs = prompt.buildMessages({
    prefix: 'SYS',
    question: 'q',
    history: [{ role: 'them', text: '上一句' }],
  });
  assert.ok(msgs.some((m) => m.content.includes('上一句')));
});

test('脏 entries 不崩', () => {
  assert.doesNotThrow(() => {
    ctx.buildContext({ entries: [null, 'x', 1, { role: 'them' }], question: 'q' });
  });
  assert.doesNotThrow(() => {
    prompt.buildMessages({ prefix: 'S', question: null, entries: [{}] });
  });
});

test('长会话的提示词体积可控：不随条数线性膨胀', () => {
  const small = prompt.buildMessages({
    prefix: 'SYS', question: 'q', entries: makeEntries(5),
  });
  const huge = prompt.buildMessages({
    prefix: 'SYS', question: 'q', entries: makeEntries(200),
  });
  const sizeOf = (m) => m.reduce((n, x) => n + x.content.length, 0);
  const s1 = sizeOf(small);
  const s2 = sizeOf(huge);
  // 200 轮（400 条）相对 5 轮，体积增长应远小于线性（线性会是 ~40 倍）
  assert.ok(s2 < s1 * 8, `体积增长过大: ${s1} -> ${s2}`);
});
