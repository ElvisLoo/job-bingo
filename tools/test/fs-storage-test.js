'use strict';
/**
 * 场次文件存储：路径安全与容错。
 *
 * fs-storage 的 id 直接来自 IPC（渲染层传入），
 * 虽然平时是内部生成的，但一旦渲染进程被注入
 * （比如用户导入的简历 JSON 里藏了脚本），
 * 就能借 '../../xxx' 读写任意 .json 文件。
 *
 * 这里守两件事：
 *   1. 恶意 id 不能逃出存储目录；
 *   2. 单个坏文件不能让整份列表读不出来。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFsStorage } = require('../packages/desktop/src/main/fs-storage');

/** 每个用例一个干净目录，测完删掉 */
function withDir(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fsstore-'));
  const sess = path.join(base, 'sessions');
  fs.mkdirSync(sess, { recursive: true });
  try {
    return fn(base, sess, createFsStorage(sess));
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  }
}

test('正常 id 可以写入并读回', () => {
  withDir((base, sess, st) => {
    st.write('20261102-1200-abc', { id: '20261102-1200-abc', entries: [] });
    const got = st.read('20261102-1200-abc');
    assert.ok(got);
    assert.strictEqual(got.id, '20261102-1200-abc');
  });
});

test('恶意 id 不能写到目录外（写入）', () => {
  withDir((base, sess, st) => {
    const evil = '../../escaped-' + Date.now();
    let threw = false;
    try {
      st.write(evil, { pwned: true });
    } catch (_) {
      threw = true;
    }
    const outside = path.resolve(sess, evil + '.json');
    const leaked = fs.existsSync(outside);
    if (leaked) fs.unlinkSync(outside);
    assert.ok(threw || !leaked, '要么抛错，要么根本没写出去 —— 不能静默写到目录外');
  });
});

test('恶意 id 不能读到目录外（读取）', () => {
  withDir((base, sess, st) => {
    fs.writeFileSync(path.join(base, 'secret.json'), '{"secret":"leaked"}');
    let leaked = null;
    try {
      leaked = st.read('../../secret');
    } catch (_) {
      // 抛错也算防护生效
    }
    if (leaked) {
      assert.fail('读到了目录外文件: ' + JSON.stringify(leaked));
    }
  });
});

test('绝对路径 id 不能绕过目录限制', () => {
  withDir((base, sess, st) => {
    const target = path.join(base, 'abs.json');
    let threw = false;
    try {
      st.write(target, { pwned: true });
    } catch (_) {
      threw = true;
    }
    const leaked = fs.existsSync(target);
    if (leaked) fs.unlinkSync(target);
    assert.ok(threw || !leaked, '绝对路径同样不能写出去');
  });
});

test('单个坏文件不影响列表', () => {
  withDir((base, sess, st) => {
    fs.writeFileSync(path.join(sess, 'broken.json'), '{ 这不是 JSON');
    st.write('good-1', { id: 'good-1' });
    st.write('good-2', { id: 'good-2' });
    const list = st.list();
    assert.strictEqual(list.length, 2, '坏的跳过，好的照常列出');
  });
});

test('目录不存在时 list 返回空数组而不是抛错', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fsstore2-'));
  try {
    const st = createFsStorage(path.join(base, 'nope'));
    assert.deepStrictEqual(st.list(), []);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  }
});

test('read 不存在的 id 返回 null', () => {
  withDir((base, sess, st) => {
    assert.strictEqual(st.read('no-such'), null);
  });
});

test('remove 不存在的 id 不抛错', () => {
  withDir((base, sess, st) => {
    assert.doesNotThrow(() => st.remove('no-such'));
  });
});
