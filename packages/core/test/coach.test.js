'use strict';
/**
 * 教练式追问（Coach）模块单测
 *
 * 重点与复盘测试一致：不验证「能不能生成」，而验证
 *  1. 追问必须挂在真实薄弱点上（没答 / 太短 / 没数字 / 复盘 gap）；
 *  2. 答得好的问题不该被追问；
 *  3. 没配 Key 或模型失败时，本地规则必须产出有效追问，而不是空页。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  localCoach, generateCoach, validateCoach, buildCoachMessages, MAX_QUESTIONS,
} = require('../src/coach');
const { normalizeTranscript } = require('../src/review');
const index = require('../src/index');

const LONG_ANSWER = '去年双十一订单服务雪崩，我通过监控定位到数据库连接池打满，把连接池从 200 调到 500，并降级非核心链路，恢复服务。';
const TRANSCRIPT = normalizeTranscript([
  { role: 'them', text: '说说你处理过最复杂的一次系统故障' },
  { role: 'me', text: LONG_ANSWER },
]);

test('localCoach：没答的问题会生成追问', () => {
  const t = normalizeTranscript([{ role: 'them', text: '你期望的薪资是多少' }]);
  const r = localCoach(t, null);
  assert.equal(r.questions.length, 1);
  assert.ok(r.questions[0].question.includes('你期望的薪资是多少'), '追问要复述原问题');
  assert.equal(r.questions[0].focus, '未回答');
});

test('localCoach：答太短（<20字）会生成追问，要求举例带数字', () => {
  const t = normalizeTranscript([
    { role: 'them', text: '你怎么知道问题解决了' },
    { role: 'me', text: '看错误率回落。' },
  ]);
  const r = localCoach(t, null);
  assert.equal(r.questions.length, 1);
  assert.ok(r.questions[0].question.includes('例子'), JSON.stringify(r.questions));
  assert.ok(r.questions[0].question.includes('数字'));
  assert.equal(r.questions[0].focus, '回答过短');
});

test('localCoach：没有数字的回答会生成追问，要求量化', () => {
  const t = normalizeTranscript([
    { role: 'them', text: '说说你的项目' },
    { role: 'me', text: '我主导了一个订单系统的重构，把老服务拆成了微服务，也做了监控和告警，整体稳定了很多。' },
  ]);
  const r = localCoach(t, null);
  assert.equal(r.questions.length, 1);
  assert.ok(r.questions[0].question.includes('量化'), JSON.stringify(r.questions));
  assert.equal(r.questions[0].focus, '缺少量化');
});

test('localCoach：答得好的问题不生成追问', () => {
  const r = localCoach(TRANSCRIPT, null);
  assert.equal(r.questions.length, 0, '有数字、够长不应追问');
});

test('localCoach：复盘里标为 gap 的点会生成对应追问', () => {
  const review = {
    items: [{
      question: '说说你处理过最复杂的一次系统故障',
      quote: '把连接池从 200 调到 500',
      comment: '有动作，但没给恢复时长',
      tag: 'gap',
    }],
  };
  const r = localCoach(TRANSCRIPT, review);
  assert.equal(r.questions.length, 1);
  assert.ok(r.questions[0].question.includes('连接池'), JSON.stringify(r.questions));
  assert.equal(r.questions[0].focus, '证据薄弱');
  assert.ok(r.questions[0].reason.includes('恢复时长'));
});

test('localCoach：复盘 risk 点也会被追问，且 focus 区分', () => {
  const review = {
    items: [{ question: '为什么离职', quote: '看错误率回落', comment: '回答有风险', tag: 'risk' }],
  };
  const t = TRANSCRIPT;
  const r = localCoach(t, review);
  assert.equal(r.questions[0].focus, '风险点');
});

test('localCoach：相似追问去重（重复薄弱点不重复追问）', () => {
  const t = normalizeTranscript([
    { role: 'them', text: '说说你的项目' },
    { role: 'me', text: '我做了微服务重构' },
    { role: 'them', text: '说说你的项目' },
    { role: 'me', text: '我做了微服务重构' },
  ]);
  const r = localCoach(t, null);
  assert.equal(r.questions.length, 1, '同一薄弱点只追问一次');
});

test('localCoach：不同薄弱点不会被误判为相似', () => {
  const t = normalizeTranscript([
    { role: 'them', text: '你怎么知道问题解决了' },
    { role: 'me', text: '看错误率回落。' },
    { role: 'them', text: '这次故障影响了多少用户' },
    { role: 'me', text: '大概影响了几千人。' },
  ]);
  const r = localCoach(t, null);
  assert.equal(r.questions.length, 2, '两处不同薄弱点应各追问一次');
});

test('localCoach：追问数量上限为 5', () => {
  const history = [];
  for (let i = 0; i < 8; i++) {
    history.push({ role: 'them', text: `问题 ${i}` });
    history.push({ role: 'me', text: '嗯。' });
  }
  const r = localCoach(normalizeTranscript(history), null);
  assert.equal(r.questions.length, MAX_QUESTIONS);
  assert.equal(r.meta.count, MAX_QUESTIONS);
});

test('localCoach：meta.engine 标注为 local', () => {
  const r = localCoach(TRANSCRIPT, null);
  assert.equal(r.meta.engine, 'local');
  assert.equal(r.meta.count, r.questions.length);
});

test('localCoach：脏输入（空 transcript / null review）不崩', () => {
  const a = localCoach([], null);
  assert.equal(a.questions.length, 0);
  assert.equal(a.meta.engine, 'local');
  const b = localCoach(null, null);
  assert.equal(b.questions.length, 0);
  const c = localCoach(undefined, {});
  assert.equal(c.questions.length, 0);
});

test('generateCoach：没配 Key 时 localCoach 也能返回有效追问（降级）', async () => {
  const r = await generateCoach({
    transcript: normalizeTranscript([
      { role: 'them', text: '你期望的薪资是多少' },
    ]),
    review: null,
    llm: {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.meta.engine, 'local');
  assert.ok(r.questions.length >= 1);
});

test('generateCoach：模型失败时退回本地规则并标 degraded', async () => {
  const client = { chat: async () => { throw new Error('429 busy'); } };
  const r = await generateCoach({
    transcript: TRANSCRIPT,
    review: { items: [{ question: '故障', quote: '连接池从 200 调到 500', comment: '缺恢复时长', tag: 'gap' }] },
    cfg: { llm: { apiKey: 'sk-test' }, client },
  });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.equal(r.meta.engine, 'local');
});

test('generateCoach：模型给出合格追问 → 采用，meta.engine 为 llm', async () => {
  const client = {
    chat: async () => ({
      content: JSON.stringify({
        questions: [{
          question: '把连接池从 200 调到 500 之后，服务多久恢复的？',
          focus: '恢复时长',
          reason: '有动作但缺结果',
          quote: '把连接池从 200 调到 500',
        }],
      }),
    }),
  };
  const r = await generateCoach({
    transcript: TRANSCRIPT, review: null,
    cfg: { llm: { apiKey: 'sk-test' }, client },
  });
  assert.equal(r.meta.engine, 'llm');
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].focus, '恢复时长');
});

test('generateCoach：模型编造引述 → 退回本地规则（不返回假追问）', async () => {
  const client = {
    chat: async () => ({
      content: JSON.stringify({
        questions: [{ question: '我重构了整个系统吗？', focus: 'x', quote: '我重构了整个系统' }],
      }),
    }),
  };
  const r = await generateCoach({
    transcript: TRANSCRIPT, review: null,
    cfg: { llm: { apiKey: 'sk-test' }, client },
  });
  assert.equal(r.degraded, true);
  assert.equal(r.meta.engine, 'local');
});

test('generateCoach：空 transcript 返回空追问但不崩', async () => {
  const r = await generateCoach({ transcript: [], review: null, llm: {} });
  assert.equal(r.ok, true);
  assert.equal(r.questions.length, 0);
  assert.equal(r.meta.count, 0);
});

test('validateCoach：引述在记录里找不到 → 拦截', () => {
  const draft = { questions: [{ question: 'x？', quote: '我主导了全部重构' }] };
  const v = validateCoach(draft, TRANSCRIPT);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'QUOTE_NOT_FOUND');
});

test('validateCoach：追问里编造数字 → 拦截', () => {
  const draft = {
    questions: [{
      question: '连接池从 200 调到 500 之后，错误率是不是降到 0.01%？',
      quote: '把连接池从 200 调到 500',
    }],
  };
  const v = validateCoach(draft, TRANSCRIPT);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'NUMBER_NOT_FOUND');
});

test('buildCoachMessages：system 禁止造新话题、要求原样引述', () => {
  const msgs = buildCoachMessages(TRANSCRIPT, null, '简历', '岗位 JD');
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('原样出现'));
  assert.ok(msgs[0].content.includes('禁止'));
  assert.ok(msgs[1].content.includes('问答记录'));
});

test('index：coach 已对外导出', () => {
  assert.equal(typeof index.generateCoach, 'function');
  assert.equal(typeof index.localCoach, 'function');
  assert.equal(typeof index.validateCoach, 'function');
  assert.equal(typeof index.buildCoachMessages, 'function');
});