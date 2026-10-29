'use strict';
/** 主流程端到端：用假的 globalThis.fetch 覆盖「出卡 / 修正重试 / 彻底失败 / 网络抖动」四条路径 */
const test = require('node:test');
const assert = require('node:assert');
const { generateHintCard, warmup, mockHintCard, validateHintCard } = require('../src/index');

const RESUME = {
  basic: { name: '张三', title: 'ERP 实施顾问' },
  experience: [{
    id: 'exp-1',
    company: '淮北万金天宇',
    position: 'ERP 实施顾问',
    details: '处理负库存 1000 件，余额 −3994.58，用 INVQ01 查流水、INV102 做成本重算',
  }],
  skillContent: '熟悉 INVQ01 库存明细查询',
};

const GOOD_CARD = {
  anchor: { resumeId: 'exp-1', label: '经历 淮北万金天宇 · ERP 实施顾问' },
  points: [
    { kind: 'fact', text: '账面 1000 pcs / 余额 -3994.58' },
    { kind: 'path', text: 'INVQ01 流水 → INV102 成本重算' },
    { kind: 'key', text: '出入库异动类型 + 暂估凭证' },
  ],
  caution: '别急着说改好了',
};

const SCRIPTED_CARD = {
  anchor: { resumeId: 'exp-1', label: '经历 淮北万金天宇' },
  points: [
    { kind: 'fact', text: '我在万金天宇做过 ERP 库存成本治理项目。' },
    { kind: 'path', text: '首先查流水，然后重算成本' },
  ],
};

function installFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init, n: calls.length });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const okRes = (content) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  async text() { return JSON.stringify({ choices: [{ message: { content } }] }); },
});

test('generateHintCard：一次命中，返回卡与元信息', async () => {
  const f = installFetch(async () => okRes(JSON.stringify(GOOD_CARD)));
  try {
    const r = await generateHintCard({
      question: '说说你处理过最棘手的一次故障',
      resume: RESUME,
      llm: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-t', model: 'm1' },
    });
    assert.ok(r.card, JSON.stringify(r.errors));
    assert.strictEqual(r.attempts, 1);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.card.meta.attempt, 1);
    assert.strictEqual(r.card.meta.model, 'm1');
    assert.ok(r.card.meta.anchorCount >= 2);
    assert.strictEqual(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test('generateHintCard：成稿卡被拦 → 带修正指令重试 → 第二次通过', async () => {
  const f = installFetch(async ({ n }) => okRes(JSON.stringify(n === 1 ? SCRIPTED_CARD : GOOD_CARD)));
  try {
    const r = await generateHintCard({ question: '说说最难的一次故障', resume: RESUME, llm: { apiKey: 'k' } });
    assert.ok(r.card, JSON.stringify(r.errors));
    assert.strictEqual(r.attempts, 2);
    const repairTurn = JSON.parse(f.calls[1].init.body).messages.at(-1);
    assert.strictEqual(repairTurn.role, 'user');
    assert.match(repairTurn.content, /未通过校验/);
    assert.match(repairTurn.content, /≤18 汉字/);
  } finally {
    f.restore();
  }
});

test('generateHintCard：三次都不通过时返回结构化错误而不是抛异常', async () => {
  const f = installFetch(async () => okRes(JSON.stringify(SCRIPTED_CARD)));
  try {
    const r = await generateHintCard({ question: '问点什么', resume: RESUME, llm: { apiKey: 'k' } });
    assert.strictEqual(r.card, null);
    assert.strictEqual(r.attempts, 3);
    assert.ok(r.errors.length > 0);
    assert.ok(r.errors.every((e) => e.code && e.reason));
    assert.ok(typeof r.raw === 'string' && r.raw.length > 0);
    assert.strictEqual(f.calls.length, 3);
  } finally {
    f.restore();
  }
});

test('generateHintCard：JSON 解析失败也算一次尝试，并继续重试', async () => {
  const f = installFetch(async ({ n }) => okRes(n === 1 ? '抱歉，我输出错了' : JSON.stringify(GOOD_CARD)));
  try {
    const r = await generateHintCard({ question: '问点什么', resume: RESUME, llm: { apiKey: 'k' } });
    assert.ok(r.card);
    assert.strictEqual(r.attempts, 2);
  } finally {
    f.restore();
  }
});

test('generateHintCard：网络抖动不炸流程，会重试并在成功后出卡', async () => {
  const f = installFetch(async ({ n }) => {
    if (n === 1) throw new Error('ECONNREFUSED 127.0.0.1:1234');
    return okRes(JSON.stringify(GOOD_CARD));
  });
  try {
    const r = await generateHintCard({ question: '问点什么', resume: RESUME, llm: { apiKey: 'k' } });
    assert.ok(r.card);
    assert.strictEqual(r.attempts, 2);
  } finally {
    f.restore();
  }
});

test('generateHintCard：一直网络失败时降级返回 LLM_ERROR', async () => {
  const f = installFetch(async () => { throw new Error('ENOTFOUND api.example.com'); });
  try {
    const r = await generateHintCard({ question: '问点什么', resume: RESUME, llm: { apiKey: 'k' }, maxAttempts: 2 });
    assert.strictEqual(r.card, null);
    assert.strictEqual(r.attempts, 2);
    assert.ok(r.errors[0].code === 'LLM_ERROR', JSON.stringify(r.errors));
    assert.match(r.errors[0].reason, /ENOTFOUND/);
  } finally {
    f.restore();
  }
});

test('generateHintCard：maxAttempts 被夹紧（异常配置不能引发请求风暴）', async () => {
  for (const [input, expectedCalls] of [[0, 1], [-3, 1], [NaN, 3], [99, 5], ['x', 3], ['2', 2], [2.7, 2], [undefined, 3]]) {
    const f = installFetch(async () => okRes(JSON.stringify(SCRIPTED_CARD)));
    try {
      const r = await generateHintCard({ question: 'q', resume: RESUME, llm: { apiKey: 'k' }, maxAttempts: input });
      assert.strictEqual(f.calls.length, expectedCalls, `maxAttempts=${input}`);
      assert.strictEqual(r.attempts, expectedCalls);
    } finally {
      f.restore();
    }
  }
});

test('generateHintCard：简历为空 / 未配置 llm 也不崩', async () => {
  const f = installFetch(async () => okRes(JSON.stringify({
    anchor: { resumeId: null, label: '无直接对应' },
    points: [{ text: '先确认对方说的场景' }, { text: '再讲通用排查路径' }],
  })));
  try {
    for (const resume of [null, undefined, {}, 'garbage']) {
      const r = await generateHintCard({ question: 'q', resume, llm: undefined });
      assert.ok(r.card, JSON.stringify(r.errors));
    }
  } finally {
    f.restore();
  }
});

test('generateHintCard：锚点不在简历里会被拦（编造项目出不去）', async () => {
  const fake = {
    anchor: { resumeId: 'exp-ghost', label: '经历 不存在的公司' },
    points: [{ text: '账面 1000 pcs / 余额 -3994.58' }, { text: 'INVQ01 流水 → 成本重算' }],
  };
  const f = installFetch(async () => okRes(JSON.stringify(fake)));
  try {
    const r = await generateHintCard({ question: 'q', resume: RESUME, llm: { apiKey: 'k' }, maxAttempts: 1 });
    assert.strictEqual(r.card, null);
    assert.ok(r.errors.some((e) => e.code === 'ANCHOR_UNKNOWN'), JSON.stringify(r.errors));
  } finally {
    f.restore();
  }
});

test('generateHintCard：虚构数字会被拦（背调杀手）', async () => {
  const fake = {
    anchor: { resumeId: 'exp-1', label: '经历 淮北万金天宇' },
    points: [{ text: '性能提升 80%' }, { text: '带过 20 人团队' }],
  };
  const f = installFetch(async () => okRes(JSON.stringify(fake)));
  try {
    const r = await generateHintCard({ question: 'q', resume: RESUME, llm: { apiKey: 'k' }, maxAttempts: 1 });
    assert.strictEqual(r.card, null);
    assert.ok(r.errors.some((e) => e.code === 'NUMBER_NOT_IN_RESUME'), JSON.stringify(r.errors));
  } finally {
    f.restore();
  }
});

test('warmup：单发一次请求，返回前缀字节数', async () => {
  const f = installFetch(async () => okRes('好'));
  try {
    const w = await warmup({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }, RESUME, 'JD 文本');
    assert.strictEqual(f.calls.length, 1);
    const body = JSON.parse(f.calls[0].init.body);
    assert.strictEqual(body.max_tokens, 1);
    assert.strictEqual(body.temperature, 0);
    assert.ok(w.prefixBytes > 0);
    assert.ok(w.latencyMs >= 0);
  } finally {
    f.restore();
  }
});

test('warmup：不同 JD 前缀长度不同（缓存 key 会变，属预期）', async () => {
  const f = installFetch(async () => okRes('好'));
  try {
    const a = await warmup({}, RESUME, '');
    const b = await warmup({}, RESUME, '招 ERP 实施顾问');
    assert.ok(b.prefixBytes > a.prefixBytes);
  } finally {
    f.restore();
  }
});

test('mockHintCard：演示卡自己也要过自家校验器', () => {
  for (const q of ['介绍一下你自己', '说说你处理过的一个难题？', '你为什么离职。', '', undefined, '面试官问了一个特别特别特别长的问题足足有三十个字']) {
    const card = mockHintCard(q);
    const r = validateHintCard(card, null, null);
    assert.strictEqual(r.ok, true, `${q} → ${JSON.stringify(r.errors)}`);
  }
  const card = mockHintCard('介绍一下你自己？');
  assert.strictEqual(card.points[0].text, '识别到：介绍一下你自己');
  assert.strictEqual(card.meta.model, 'mock');
  assert.strictEqual(card.meta.anchorCount, 0);
  assert.strictEqual(card.anchor.resumeId, null);
});

test('index.js 仍导出全部对外 API', () => {
  const api = require('../src/index');
  for (const fn of ['generateHintCard', 'warmup', 'mockHintCard', 'indexResume', 'toMarkdown',
    'buildStablePrefix', 'buildMessages', 'buildWarmupMessages', 'validateHintCard',
    'buildRepairInstruction', 'countCJK', 'createClient', 'parseCardObject']) {
    assert.strictEqual(typeof api[fn], 'function', `缺少导出 ${fn}`);
  }
});
