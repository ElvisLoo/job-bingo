'use strict';
/** 流水线自测：提问判定 / 去重 / 自己的声音 / 演示模式 / 真链路 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Pipeline, isQuestion, similarity } = require('../../packages/desktop/src/main/pipeline');

const GOOD_CARD = {
  anchor: { resumeId: 'proj:0', label: '项目 ERP 成本分析' },
  points: [
    { kind: 'fact', text: '库存 1000 pcs / 余额 -3994.58' },
    { kind: 'path', text: 'INVQ01 流水 → INV102 重算' },
  ],
  caution: null,
};

test('提问判定：疑问句是问题', () => {
  for (const t of ['说说你处理过最复杂的一次库存异常', '这个问题你怎么定位的？', '介绍一下你自己', '还有吗', '继续']) {
    assert.equal(isQuestion(t), true, `应判定为提问：${t}`);
  }
});

test('提问判定：陈述句不是问题', () => {
  for (const t of ['好的我知道了', '嗯没错是这样', '谢谢']) {
    assert.equal(isQuestion(t), false, `不应判定为提问：${t}`);
  }
});

test('相似度去重：近似文本应被判重复', () => {
  assert.ok(similarity('说说你处理过最复杂的库存异常', '说说你处理过最复杂的一次库存异常') > 0.72);
  assert.ok(similarity('介绍一下你自己', '你的期望薪资是多少') < 0.5);
});

function mkPipeline(llmConfig, pushed) {
  return new Pipeline({
    getConfig: () => ({ llm: llmConfig, jd: '' }),
    // 注意：卡片里出现的每个数字都必须在简历原文中存在，否则会被
    // NUMBER_NOT_IN_RESUME 闸门拦截 —— 这正是校验器该做的事。
    getResume: () => ({
      projects: [{
        id: 'proj:0', name: 'ERP 成本分析',
        description: '排查库存 1000 pcs 但余额 -3994.58 的成本异常，用 INVQ01 流水与 INV102 重算',
      }],
    }),
    pushCard: (p) => pushed.push(p),
  });
}

test('自己的发言不生成卡片，只进上下文', async () => {
  const pushed = [];
  const p = mkPipeline({ apiKey: 'k' }, pushed);
  const r = await p.ingest('我觉得应该先从单据层查起', { role: 'me' });
  assert.equal(r.skipped, 'own-voice');
  assert.equal(pushed.length, 0);
  assert.equal(p.history.length, 1);
});

test('太短的片段与非提问片段被丢弃', async () => {
  const pushed = [];
  const p = mkPipeline({ apiKey: 'k' }, pushed);
  assert.equal((await p.ingest('嗯', {})).skipped, 'too-short');
  assert.equal((await p.ingest('好的我明白了', {})).skipped, 'not-question');
  assert.equal(pushed.length, 0);
});

test('未配置 Key 时返回演示卡，不抛网络错误', async () => {
  const pushed = [];
  const p = mkPipeline({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }, pushed);
  const r = await p.ingest('介绍一下你自己', { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.mocked, true);
  assert.ok(r.card.points.length >= 2);
});

test('同一问题再次到达会被去重（过了时间窗之后）', async () => {
  const pushed = [];
  const p = mkPipeline({ apiKey: '' }, pushed);
  await p.ingest('介绍一下你自己', { force: true });

  // 先验证时间窗本身生效
  const tooSoon = await p.ingest('介绍一下你自己', {});
  assert.equal(tooSoon.skipped, 'too-soon');

  // 清掉时间窗，验证相似度去重单独生效
  p.lastAskAt = 0;
  const dup = await p.ingest('介绍一下你自己', {});
  assert.equal(dup.skipped, 'duplicate');
});

test('接入真实 LLM 端点时能产出通过校验的卡片', async (t) => {
  // 内置一个假的 OpenAI 兼容服务，避免依赖外部网络
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD_CARD) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => server.close());

  const pushed = [];
  const p = mkPipeline({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'm' }, pushed);
  const r = await p.ingest('说说那次库存成本异常', { force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(pushed[0].type, 'card');
  assert.equal(pushed[0].card.anchor.resumeId, 'proj:0');
});

// ---------------- 全场记录（复盘数据源） ----------------

test('全场记录不随 history 截断，可完整复盘', async () => {
  const pushed = [];
  const { Pipeline } = require('../../packages/desktop/src/main/pipeline');
  const p = new Pipeline({
    getConfig: () => ({ llm: { apiKey: '' }, jd: '' }),
    getResume: () => ({}),
    pushCard: (x) => pushed.push(x),
  });

  // 连续 10 轮问答：history 只留 12 条（6 轮），transcript 应保留全部 20 条
  for (let i = 0; i < 10; i++) {
    await p.ingest(`这是第 ${i} 个问题吗`, { force: true });
    await p.ingest(`这是第 ${i} 个回答的内容`, { role: 'me' });
  }

  const t = p.getTranscript();
  assert.equal(t.length, 20, `transcript 应保留 20 条，实际 ${t.length}`);
  assert.ok(p.history.length <= 12, `history 应被截断，实际 ${p.history.length}`);
  assert.equal(t[0].role, 'them');
  assert.equal(t[1].role, 'me');
  assert.ok(t[0].at > 0, '每条记录应带时间戳');
});

test('reset 会同时清空全场记录', async () => {
  const { Pipeline } = require('../../packages/desktop/src/main/pipeline');
  const p = new Pipeline({
    getConfig: () => ({ llm: { apiKey: '' }, jd: '' }),
    getResume: () => ({}),
    pushCard: () => {},
  });
  await p.ingest('这个问题会被记录吗', { force: true });
  assert.ok(p.getTranscript().length >= 1);
  p.reset();
  assert.equal(p.getTranscript().length, 0);
});

// ---------------- M2 手机端音频入口 ----------------

test('手机录音默认按「我在回答」处理：只进上下文，不出卡', async () => {
  const asr = require('@job-bingo/asr');
  const { Pipeline } = require('../../packages/desktop/src/main/pipeline');
  const pushed = [];
  const p = new Pipeline({
    getConfig: () => ({ llm: { apiKey: '' }, jd: '' }),
    getResume: () => ({}),
    pushCard: (x) => pushed.push(x),
  });

  const pcm = asr.synthSpeechLike({ cycles: 1, silenceSec: 0.3, speechSec: 0.8, freq: 440, amp: 0.35 });
  const wav = asr.encodeWav(pcm, 16000);
  // 不传 role 时也必须按 me 处理：手机麦克风录到的是用户自己
  const r = await p.feedWav(wav, { split: false });
  assert.equal(r.ok, true);
  assert.equal(pushed.filter((x) => x.type === 'card').length, 0, '不应出卡');
  assert.ok(p.getTranscript().some((h) => h.role === 'me'), '应写入上下文');
});

test('手机录音标为「对方在问」时才出卡', async () => {
  const asr = require('@job-bingo/asr');
  const { Pipeline } = require('../../packages/desktop/src/main/pipeline');
  const pushed = [];
  const p = new Pipeline({
    getConfig: () => ({ llm: { apiKey: '' }, jd: '' }),
    getResume: () => ({}),
    pushCard: (x) => pushed.push(x),
  });
  const pcm = asr.synthSpeechLike({ cycles: 1, silenceSec: 0.3, speechSec: 0.8, freq: 440, amp: 0.35 });
  await p.feedWav(asr.encodeWav(pcm, 16000), { role: 'them', split: false });
  assert.ok(pushed.filter((x) => x.type === 'card').length >= 1);
});

test('split=false：一句话只转写一次，不被再切段', async () => {
  const asr = require('@job-bingo/asr');
  const { Pipeline } = require('../../packages/desktop/src/main/pipeline');
  const p = new Pipeline({
    getConfig: () => ({ llm: { apiKey: '' }, jd: '' }),
    getResume: () => ({}),
    pushCard: () => {},
  });
  // 三段语音的音频：若被切段应得 3 段
  const pcm = asr.synthSpeechLike({ cycles: 3, silenceSec: 0.5, speechSec: 0.9, freq: 440, amp: 0.35 });
  const wav = asr.encodeWav(pcm, 16000);

  const a = await p.feedWav(wav, { role: 'them', split: false });
  assert.equal(a.segments, 1, 'split=false 应只有 1 段');

  p.reset();
  const b = await p.feedWav(wav, { role: 'them', split: true });
  assert.ok(b.segments >= 3, `split=true 应切出多段，实际 ${b.segments}`);
});
