'use strict';
/**
 * 复盘记录截断：回归测试。
 *
 * 背景：一场 40 分钟的面试可能几十轮，不可能整段塞给模型。
 * 但「只取最近 N 轮」会把开场全部丢掉 —— 而开场（自我介绍、讲项目）
 * 恰恰是最有复盘价值的部分，中后段往往是一串同质化追问。
 */
const test = require('node:test');
const assert = require('node:assert');
const review = require('../src/review');

function makeRounds(n) {
  const h = [];
  for (let i = 0; i < n; i += 1) {
    h.push({ role: 'them', text: `问题${i}：说说你的项目经验` });
    h.push({ role: 'me', text: `回答${i}：做过电商系统` });
  }
  return h;
}

test('短记录全量保留，不标注省略', () => {
  const t = review.normalizeTranscript(makeRounds(5));
  assert.strictEqual(t.length, 5);
  assert.strictEqual(t.skipped, undefined);
});

test('长记录头尾各留一半，开场不丢', () => {
  const t = review.normalizeTranscript(makeRounds(30));
  assert.strictEqual(t.length, 12);
  assert.strictEqual(t.skipped, 18);
  assert.strictEqual(t[0].question, '问题0：说说你的项目经验', '开场必须保留');
  assert.strictEqual(t[t.length - 1].question, '问题29：说说你的项目经验', '结尾必须保留');
});

test('省略数是真实丢弃的轮数', () => {
  for (const n of [13, 20, 50]) {
    const t = review.normalizeTranscript(makeRounds(n));
    assert.strictEqual(t.length + t.skipped, n, `n=${n} 时总数应对得上`);
  }
});

test('省略标记不污染数据：不会插入占位项', () => {
  const t = review.normalizeTranscript(makeRounds(30));
  for (const item of t) {
    // 占位项会表现为空问题空回答同时出现
    assert.ok(item.question || item.answer, '每条都应有实际内容');
  }
});

test('省略标记不出现在 JSON 化结果里（非枚举）', () => {
  const t = review.normalizeTranscript(makeRounds(30));
  const json = JSON.stringify(t);
  assert.ok(!json.includes('skipped'), '序列化时不应带出内部标记');
});

test('提示词明确告知省略，避免误判上下文不连贯', () => {
  const t = review.normalizeTranscript(makeRounds(30));
  const msgs = review.buildReviewMessages(t, '简历', 'JD');
  const user = msgs.find((m) => m.role === 'user').content;
  assert.ok(user.includes('中间省略 18 轮'), '应写明省略了多少轮');
  assert.ok(user.includes('不要因为前后不衔接'), '应阻止模型误判承接关系');
});

test('未截断时提示词不提省略', () => {
  const t = review.normalizeTranscript(makeRounds(4));
  const msgs = review.buildReviewMessages(t, '', '');
  const user = msgs.find((m) => m.role === 'user').content;
  assert.ok(!user.includes('中间省略'));
});

test('transcriptMeta 读得到省略数', () => {
  const t = review.normalizeTranscript(makeRounds(30));
  assert.strictEqual(review.transcriptMeta(t).skipped, 18);
  assert.strictEqual(review.transcriptMeta([]).skipped, 0);
  assert.strictEqual(review.transcriptMeta(null).skipped, 0);
});

test('脏输入不崩', () => {
  assert.doesNotThrow(() => review.normalizeTranscript(null));
  assert.doesNotThrow(() => review.normalizeTranscript([null, 'x', {}, { role: 'them' }]));
  assert.deepStrictEqual(review.normalizeTranscript(null), []);
});
