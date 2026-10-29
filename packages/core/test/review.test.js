'use strict';
/**
 * 复盘模块单测
 *
 * 重点不是「能不能生成」，而是**能不能拦住模型胡编**：
 *  1. 引述必须真的出现在记录里；
 *  2. 点评里的数字必须能在原文/简历里找到；
 *  3. 没配 Key 或模型失败时，必须给出可验证的本地结论，而不是空页。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeTranscript, validateReview, localReview, generateReview,
  buildReviewMessages, reviewToMarkdown, extractNumbers,
} = require('../src/review');

const HISTORY = [
  { role: 'them', text: '说说你处理过最复杂的一次系统故障' },
  { role: 'me', text: '去年双十一流量突增，订单服务雪崩，我通过监控定位到数据库连接池打满，把连接池从 200 调到 500，并降级了非核心链路，恢复了服务。' },
  { role: 'them', text: '你怎么知道问题解决了' },
  { role: 'me', text: '看错误率回落。' },
];

const TRANSCRIPT = normalizeTranscript(HISTORY);

test('normalizeTranscript：把问与答配对', () => {
  assert.equal(TRANSCRIPT.length, 2);
  assert.equal(TRANSCRIPT[0].question, '说说你处理过最复杂的一次系统故障');
  assert.ok(TRANSCRIPT[0].answer.includes('连接池'));
  assert.equal(TRANSCRIPT[1].answer, '看错误率回落。');
});

test('normalizeTranscript：只有问没有答也保留（用于指出「没答」）', () => {
  const t = normalizeTranscript([{ role: 'them', text: '你期望的薪资是多少' }]);
  assert.equal(t.length, 1);
  assert.equal(t[0].answer, '');
});

test('normalizeTranscript：非数组输入返回空', () => {
  assert.deepEqual(normalizeTranscript(null), []);
  assert.deepEqual(normalizeTranscript('abc'), []);
});

test('extractNumbers：抽数字与百分比', () => {
  assert.deepEqual(extractNumbers('从 200 调到 500，提升 60%'), ['200', '500', '60%']);
});

test('validateReview：引述真实存在 → 通过', () => {
  const draft = {
    summary: '整体有例子，但结果不可验证',
    items: [{
      question: '说说你处理过最复杂的一次系统故障',
      quote: '连接池从 200 调到 500',
      comment: '有具体动作，但没给恢复时长',
      tag: 'strength',
    }],
    nextSteps: ['补一个恢复时长的数字'],
  };
  const r = validateReview(draft, TRANSCRIPT);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.review.items.length, 1);
});

test('validateReview：引述在记录里找不到 → 拦截', () => {
  const draft = {
    summary: 'x',
    items: [{ quote: '我主导了全部重构', comment: '很好', tag: 'strength' }],
  };
  const r = validateReview(draft, TRANSCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'QUOTE_NOT_FOUND');
});

test('validateReview：点评里编造数字 → 拦截', () => {
  const draft = {
    summary: 'x',
    items: [{
      quote: '看错误率回落',
      comment: '错误率降到 0.01%，很好',  // 0.01% 原文没有
      tag: 'strength',
    }],
  };
  const r = validateReview(draft, TRANSCRIPT);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'NUMBER_NOT_FOUND');
});

test('validateReview：数字来自简历也算有据', () => {
  const draft = {
    summary: 'x',
    items: [{ quote: '看错误率回落', comment: '和你简历里 99.95% 可用性口径一致', tag: 'strength' }],
  };
  const r = validateReview(draft, TRANSCRIPT, '负责系统可用性 99.95%');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateReview：引述过短（<4 字）不算有效依据', () => {
  const draft = { summary: 'x', items: [{ quote: '好', comment: 'x' }] };
  const r = validateReview(draft, TRANSCRIPT);
  assert.equal(r.ok, false);
});

test('validateReview：全部被拦时整体失败，不返回半成品', () => {
  const draft = { summary: 'x', items: [{ quote: '不存在的引述', comment: 'y' }] };
  const r = validateReview(draft, TRANSCRIPT);
  assert.equal(r.ok, false);
});

test('validateReview：非法 tag 归一为 gap', () => {
  const draft = { summary: 'x', items: [{ quote: '看错误率回落', comment: '短了', tag: 'unknown' }] };
  const r = validateReview(draft, TRANSCRIPT);
  assert.equal(r.review.items[0].tag, 'gap');
});

test('localReview：回答过短 → 标为 gap', () => {
  const r = localReview(TRANSCRIPT);
  const short = r.items.find((i) => i.quote.includes('看错误率回落'));
  assert.equal(short.tag, 'gap');
  assert.ok(short.comment.includes('7 字'));
});

test('localReview：未回答 → 明确指出没答', () => {
  const r = localReview(normalizeTranscript([{ role: 'them', text: '你期望的薪资是多少' }]));
  assert.equal(r.items[0].tag, 'gap');
  assert.ok(r.items[0].comment.includes('没有对应回答'));
});

test('localReview：有数字且够长 → 标为 strength', () => {
  const r = localReview(TRANSCRIPT);
  const long = r.items.find((i) => i.question.includes('最复杂'));
  assert.equal(long.tag, 'strength');
});

test('localReview：给出可执行的下一步', () => {
  const r = localReview(TRANSCRIPT);
  assert.ok(r.nextSteps.length >= 1);
  assert.equal(r.meta.engine, 'local');
});

test('generateReview：无 Key 时走本地规则，不抛错', async () => {
  const r = await generateReview({ transcript: TRANSCRIPT, llm: {} });
  assert.equal(r.ok, true);
  assert.equal(r.review.meta.engine, 'local');
});

test('generateReview：空记录返回失败而不是空复盘', async () => {
  const r = await generateReview({ transcript: [], llm: {} });
  assert.equal(r.ok, false);
});

test('generateReview：模型给出合格草稿 → 采用', async () => {
  const client = {
    chat: async () => ({
      content: JSON.stringify({
        summary: '有具体动作，但结果不可验证',
        items: [{ question: '故障', quote: '连接池从 200 调到 500', comment: '动作具体', tag: 'strength' }],
        nextSteps: ['补恢复时长'],
      }),
    }),
  };
  const r = await generateReview({ transcript: TRANSCRIPT, llm: { apiKey: 'sk-test' }, client });
  assert.equal(r.review.meta.engine, 'llm');
  assert.equal(r.review.items.length, 1);
});

test('generateReview：模型胡编 → 自动退回本地规则（不返回假点评）', async () => {
  const client = {
    chat: async () => ({
      content: JSON.stringify({
        summary: 'x',
        items: [{ quote: '我重构了整个系统', comment: '非常出色', tag: 'strength' }],
      }),
    }),
  };
  const r = await generateReview({ transcript: TRANSCRIPT, llm: { apiKey: 'sk-test' }, client });
  assert.equal(r.degraded, true);
  assert.equal(r.review.meta.engine, 'local');
});

test('generateReview：模型抛错 → 退回本地规则', async () => {
  const client = { chat: async () => { throw new Error('429 rate limit'); } };
  const r = await generateReview({ transcript: TRANSCRIPT, llm: { apiKey: 'sk-test' }, client });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
});

test('buildReviewMessages：system 明确禁止代答、要求原样引述', () => {
  const msgs = buildReviewMessages(TRANSCRIPT, '简历内容', '岗位 JD');
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('原样出现'));
  assert.ok(msgs[0].content.includes('禁止编造'));
  assert.ok(msgs[1].content.includes('简历内容'));
  assert.ok(msgs[1].content.includes('问答记录'));
});

test('reviewToMarkdown：包含标题、逐条与下一步', () => {
  const r = localReview(TRANSCRIPT);
  const md = reviewToMarkdown(r, { jd: '信息化经理' });
  assert.ok(md.startsWith('# 面试复盘'));
  assert.ok(md.includes('## 逐条'));
  assert.ok(md.includes('## 下一步'));
  assert.ok(md.includes('信息化经理'));
});

test('reviewToMarkdown：空复盘不崩', () => {
  const md = reviewToMarkdown(null);
  assert.ok(md.includes('复盘'));
});

test('generateReview：直接传原始流水（带 role）会自动配对', async () => {
  const r = await generateReview({ transcript: HISTORY, llm: {} });
  assert.equal(r.review.stats.rounds, 2, '两问两答应配成 2 轮');
  assert.equal(r.review.items.length, 2);
});
