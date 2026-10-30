'use strict';
/**
 * 场次单测。
 *
 * 风险点：
 *   1. 切场时把上一场弄丢（用户面完二面，回头想看一面）；
 *   2. 存档失败打断面试（最不能接受）；
 *   3. 场次无限增长把磁盘撑满。
 * 这里用一个内存 storage 桩逐条锁住。
 */
const test = require('node:test');
const assert = require('node:assert');
const { SessionStore, newSessionId, MAX_ENTRIES_PER_SESSION } = require('../src/session');

/** 内存版 storage adapter，行为与 fs 版一致 */
function memStorage() {
  const files = new Map();
  return {
    files,
    list() { return [...files.values()].map((v) => JSON.parse(JSON.stringify(v))); },
    read(id) { return files.has(id) ? JSON.parse(JSON.stringify(files.get(id))) : null; },
    write(id, obj) { files.set(id, JSON.parse(JSON.stringify(obj))); },
    remove(id) { files.delete(id); },
  };
}

test('newSessionId 按时间有序且带随机后缀', () => {
  const a = newSessionId(1700000000000, () => 0.1);
  const b = newSessionId(1700000005000, () => 0.2);
  assert.ok(a < b, '后生成的 id 应排在后面');
  assert.match(a, /^\d{8}-\d{6}-[0-9a-f]{3}$/);
});

test('新开场次：id 唯一、起始时间正确', () => {
  let t = 1000;
  const s = new SessionStore({ now: () => t });
  const a = s.start();
  t = 2000;
  const b = s.start();
  assert.notEqual(a.id, b.id);
  assert.equal(b.startedAt, 2000);
});

test('记录能写进当前场次', () => {
  const s = new SessionStore({ now: () => 1000 });
  s.push('them', '说说你的项目');
  s.push('me', '做过一个 ERP');
  const e = s.entries();
  assert.equal(e.length, 2);
  assert.equal(e[0].role, 'them');
  assert.equal(e[1].role, 'me');
});

test('空文本不入库', () => {
  const s = new SessionStore({ now: () => 1000 });
  s.push('them', '');
  s.push('them', '   ');
  assert.equal(s.entries().length, 0);
});

test('切场后旧场次仍可读回（二面不影响一面）', () => {
  const storage = memStorage();
  let t = 1000;
  const s = new SessionStore({ storage, now: () => t });

  s.start({ jd: '一面' });
  const first = s.currentId();
  s.push('them', '一面问题');
  t = 5000;

  s.start({ jd: '二面' });
  const second = s.currentId();
  s.push('them', '二面问题');

  assert.notEqual(first, second);
  assert.equal(s.read(first).entries.length, 1, '一面记录不应被二面覆盖');
  assert.equal(s.read(second).entries[0].text, '二面问题');
});

test('list 按时间倒序，新的在前', () => {
  const storage = memStorage();
  let t = 1000;
  const s = new SessionStore({ storage, now: () => t });
  s.start(); t = 2000;
  s.start(); t = 3000;
  s.start();
  const ids = s.list().map((x) => x.id);
  assert.equal(ids.length, 3);
  assert.equal(ids[0], s.currentId(), '最新的应排第一');
});

test('end 会写 endedAt', () => {
  const storage = memStorage();
  let t = 1000;
  const s = new SessionStore({ storage, now: () => t });
  s.start();
  s.push('them', 'q');
  t = 9000;
  const r = s.end();
  assert.equal(r.entries, 1);
  assert.equal(s.read(r.id).endedAt, 9000);
});

test('存档失败不抛异常，只记录原因', () => {
  const bad = {
    list() { return []; },
    read() { return null; },
    write() { throw new Error('磁盘只读'); },
    remove() {},
  };
  const s = new SessionStore({ storage: bad, now: () => 1000 });
  assert.doesNotThrow(() => s.start());
  assert.doesNotThrow(() => s.push('them', '面试还在继续'));
  assert.equal(s.saveErrors.length >= 1, true);
  assert.match(s.saveErrors[0].reason, /磁盘只读/);
  assert.equal(s.entries().length, 1, '内存副本必须还在，面试不能中断');
});

test('单场记录数有上限，超出后保留最近的', () => {
  const s = new SessionStore({ now: () => 1000 });
  for (let i = 0; i < MAX_ENTRIES_PER_SESSION + 20; i++) s.push('them', `问题${i}`);
  const e = s.entries();
  assert.equal(e.length, MAX_ENTRIES_PER_SESSION);
  assert.match(e[e.length - 1].text, new RegExp(String(MAX_ENTRIES_PER_SESSION + 19)));
});

test('场次数量超限时清理最老的，但保留当前场', () => {
  const storage = memStorage();
  let t = 1000;
  const s = new SessionStore({ storage, maxSessions: 3, now: () => t });
  for (let i = 0; i < 6; i++) { s.start(); t += 1000; }
  const all = s.list();
  assert.ok(all.length <= 3, `应清理到 ≤3，实际 ${all.length}`);
  assert.ok(all.some((x) => x.id === s.currentId()), '当前场不能被清掉');
});

test('remove 能删除指定场次', () => {
  const storage = memStorage();
  const s = new SessionStore({ storage, now: () => 1000 });
  s.start();
  const id = s.currentId();
  assert.ok(s.read(id));
  const r = s.remove(id);
  assert.equal(r.ok, true);
  assert.equal(s.read(id), null);
});

test('没有 storage 时退化为纯内存，不报错', () => {
  const s = new SessionStore({ now: () => 1000 });
  s.start();
  s.push('them', 'x');
  assert.equal(s.entries().length, 1);
  assert.deepEqual(s.list(), []);
});

test('ensure 在没有场次时自动开场', () => {
  const s = new SessionStore({ now: () => 1000 });
  assert.equal(s.currentId(), null);
  s.push('them', '第一句');
  assert.ok(s.currentId(), '应自动创建场次');
});
