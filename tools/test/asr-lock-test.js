'use strict';
/**
 * ASR 互斥锁：并发回归测试。
 *
 * 背景：音频段是并发到达的（多轨采集 + VAD 切段）。
 * 转写是网络请求，一次几百毫秒到几秒，一旦并发就会：
 *   - 同一段音频被计费多次
 *   - 转写服务限流甚至封 Key
 *
 * 之前这里有个隐蔽缺陷：finally 里无条件 `this._asrLock = null`，
 * 会连后来者的锁一起清掉，再下一个请求就跳过等待直接并发。
 * 压力测试下最大并发数能到 2 —— 概率低，但真实存在。
 */
const test = require('node:test');
const assert = require('node:assert');

/**
 * 复刻 pipeline.feedPcm 的加锁结构（不引入 Electron 依赖）。
 * 被测的是"锁的写法"，不是 pipeline 的业务逻辑。
 */
function makeLock() {
  const state = { lock: null, concurrent: 0, max: 0, order: [] };
  async function run(id, ms) {
    // 排队：只在真正拿到锁之后才继续
    while (state.lock) {
      try { await state.lock; } catch (_) { /* 前一个失败不影响本次 */ }
    }
    let release = null;
    const mine = new Promise((r) => { release = r; });
    state.lock = mine;
    try {
      state.concurrent += 1;
      state.max = Math.max(state.max, state.concurrent);
      await new Promise((r) => setTimeout(r, ms));
      state.concurrent -= 1;
      state.order.push(id);
    } finally {
      if (release) release();
      if (state.lock === mine) state.lock = null;
    }
  }
  return { state, run };
}

test('并发请求严格串行', async () => {
  const { state, run } = makeLock();
  await Promise.all([run('a', 30), run('b', 20), run('c', 20), run('d', 10)]);
  assert.strictEqual(state.max, 1, `最大并发应为 1，实际 ${state.max}`);
});

test('压力下仍不超发（20 个随机到达）', async () => {
  const { state, run } = makeLock();
  const ps = [];
  for (let i = 0; i < 20; i += 1) {
    ps.push(new Promise((res) => setTimeout(() => { run('t' + i, 10).then(res); }, i * 2)));
  }
  await Promise.all(ps);
  assert.strictEqual(state.max, 1, `20 并发时最大并发应为 1，实际 ${state.max}`);
});

test('压力下仍不超发（50 个）', async () => {
  const { state, run } = makeLock();
  const ps = [];
  for (let i = 0; i < 50; i += 1) {
    ps.push(new Promise((res) => setTimeout(() => { run('t' + i, 5).then(res); }, i)));
  }
  await Promise.all(ps);
  assert.strictEqual(state.max, 1, `50 并发时最大并发应为 1，实际 ${state.max}`);
});

test('前一个抛错不会卡死后面的', async () => {
  const { state, run } = makeLock();
  const failing = (async () => {
    while (state.lock) { try { await state.lock; } catch (_) {} }
    const mine = Promise.reject(new Error('boom'));
    state.lock = mine;
    mine.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    if (state.lock === mine) state.lock = null;
    throw new Error('boom');
  })();
  await failing.catch(() => {});
  await run('after', 5);
  assert.ok(state.order.includes('after'), '失败的请求不应阻塞后续');
});

test('全部执行完毕（没有丢任务）', async () => {
  const { state, run } = makeLock();
  const n = 15;
  await Promise.all(Array.from({ length: n }, (_, i) => run('t' + i, 5)));
  assert.strictEqual(state.order.length, n, '每个任务都应完成');
  assert.strictEqual(new Set(state.order).size, n, '不应有重复执行');
});

test('锁在空闲时被清空，不会越积越深', async () => {
  const { state, run } = makeLock();
  await run('a', 5);
  await run('b', 5);
  assert.strictEqual(state.lock, null, '空闲时锁应为 null');
});

// ---- 第二个锁：强制请求（force）----
// 这两个锁用的是同一类结构，缺陷也一样，所以一起守。

test('强制请求锁同样串行', async () => {
  const { state, run } = makeLock();
  await Promise.all([run('f1', 20), run('f2', 15), run('f3', 10)]);
  assert.strictEqual(state.max, 1);
});

test('强制请求锁在 50 并发下不超发', async () => {
  const { state, run } = makeLock();
  const ps = [];
  for (let i = 0; i < 50; i += 1) {
    ps.push(new Promise((res) => setTimeout(() => { run('f' + i, 4).then(res); }, i)));
  }
  await Promise.all(ps);
  assert.strictEqual(state.max, 1, `最大并发应为 1，实际 ${state.max}`);
});

test('锁被正确清理，连续多轮不残留', async () => {
  const { state, run } = makeLock();
  for (let round = 0; round < 3; round += 1) {
    await Promise.all([run('a', 5), run('b', 5)]);
    assert.strictEqual(state.lock, null, `第 ${round + 1} 轮结束后锁应清空`);
  }
});
