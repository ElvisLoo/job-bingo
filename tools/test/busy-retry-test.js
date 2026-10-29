'use strict';
/** 繁忙退避自测：429/503/繁忙 → 等待 → 自动重试 → 成功 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const core = require('@job-bingo/core');

const RESUME = {
  projects: [{ id: 'proj:0', name: 'ERP', description: '库存 1000 pcs 余额 -3994.58 INVQ01 INV102' }],
};

const GOOD = JSON.stringify({
  anchor: { resumeId: 'proj:0', label: 'ERP' },
  points: [{ kind: 'fact', text: '库存 1000 pcs' }, { kind: 'path', text: 'INVQ01 核对' }],
  caution: null,
});

function mkServer(behavior) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      n++;
      const act = behavior(n);
      res.writeHead(act.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(act.body));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

test('classifyError 能识别各类繁忙信号', () => {
  const cases = [
    [{ status: 429, message: 'Too Many Requests' }, true],
    [{ status: 503, message: 'Service Unavailable' }, true],
    [{ message: '模型繁忙，请稍后再试' }, true],
    [{ message: 'server is overloaded' }, true],
    [{ message: 'rate limit exceeded' }, true],
    [{ status: 401, message: 'Unauthorized' }, false],   // 鉴权错不该重试
    [{ message: '返回体不是 JSON：<html>' }, false],        // 配置错不该重试
  ];
  for (const [err, expectBusy] of cases) {
    assert.equal(core.classifyError ? core.classifyError(err).busy : null, expectBusy, JSON.stringify(err));
  }
});

test('繁忙时按间隔自动重试直到成功', async (t) => {
  const { server, port } = await mkServer((n) => (n === 1
    ? { status: 429, body: { error: { message: '模型繁忙 busy' } } }
    : { status: 200, body: { choices: [{ message: { content: GOOD } }] } }));
  t.after(() => server.close());

  const events = [];
  const r = await core.generateHintCard({
    question: '说说库存异常',
    resume: RESUME,
    llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' },
    busy: { intervalMs: 250, maxWaitMs: 5000 },   // 测试用小间隔
    hooks: {
      onBusy: (i) => events.push(['busy', i.round, i.waitMs]),
      onTick: (t2) => events.push(['tick', t2.secondsLeft]),
      onRetry: (i) => events.push(['retry', i.round]),
    },
  });

  assert.equal(r.card !== null, true, JSON.stringify(r.errors));
  assert.equal(r.busyRounds, 1);
  assert.ok(events.some((e) => e[0] === 'busy'), '应触发 onBusy');
  assert.ok(events.some((e) => e[0] === 'retry'), '应触发 onRetry');
});

test('一直繁忙时超时退出，不无限等待', async (t) => {
  const { server, port } = await mkServer(() => ({ status: 503, body: { error: { message: 'overloaded' } } }));
  t.after(() => server.close());

  const r = await core.generateHintCard({
    question: 'x', resume: RESUME,
    llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
    busy: { intervalMs: 100, maxWaitMs: 350 },
  });
  assert.equal(r.card, null);
  assert.equal(r.timedOut, true);
  assert.equal(r.errors[0].code, 'BUSY_TIMEOUT');
  assert.ok(r.busyRounds >= 2, `应重试过多轮，实际 ${r.busyRounds}`);
});

test('用户叫停会抛出 ABORTED，不继续等待', async (t) => {
  const { server, port } = await mkServer(() => ({ status: 429, body: { error: { message: 'busy' } } }));
  t.after(() => server.close());

  let stop = false;
  setTimeout(() => { stop = true; }, 150);

  await assert.rejects(
    core.generateHintCard({
      question: 'x', resume: RESUME,
      llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' },
      busy: { intervalMs: 5000, maxWaitMs: 600000 },
      hooks: { shouldStop: () => stop },
    }),
    (e) => e.code === 'ABORTED',
  );
});

test('鉴权错误不触发繁忙重试（避免白等）', async (t) => {
  const { server, port } = await mkServer(() => ({ status: 401, body: { error: { message: 'Unauthorized' } } }));
  t.after(() => server.close());

  let busyCalled = 0;
  const r = await core.generateHintCard({
    question: 'x', resume: RESUME,
    llm: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bad' },
    busy: { intervalMs: 100, maxWaitMs: 1000 },
    hooks: { onBusy: () => { busyCalled++; } },
  });
  assert.equal(busyCalled, 0, '401 不该被当成繁忙');
  assert.equal(r.card, null);
  assert.ok(!r.busyRounds, `401 不该进入繁忙重试，busyRounds=${r.busyRounds}`);
});
