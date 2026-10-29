'use strict';
/** LLM 网关：离线用假的 globalThis.fetch 覆盖全部路径 */
const test = require('node:test');
const assert = require('node:assert');
const { createClient, parseCardObject, normalizeBaseUrl } = require('../src/llm');

function installFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = orig; },
  };
}

const okRes = (content) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  async text() {
    return JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 12 } });
  },
});

const errRes = (status, statusText, body) => ({
  ok: false,
  status,
  statusText,
  async text() { return body; },
});

test('normalizeBaseUrl：默认值 / 去尾斜杠 / 补协议', () => {
  assert.strictEqual(normalizeBaseUrl(), 'https://api.openai.com/v1');
  assert.strictEqual(normalizeBaseUrl(''), 'https://api.openai.com/v1');
  assert.strictEqual(normalizeBaseUrl(null), 'https://api.openai.com/v1');
  assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
  assert.strictEqual(normalizeBaseUrl('https://api.openai.com/v1///'), 'https://api.openai.com/v1');
  assert.strictEqual(normalizeBaseUrl('  https://api.openai.com/v1  '), 'https://api.openai.com/v1');
  assert.strictEqual(normalizeBaseUrl('api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
  assert.strictEqual(normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
});

test('parseCardObject：纯 JSON / 代码块 / 前后废话', () => {
  const obj = { anchor: { label: 'a' }, points: [{ text: 'x' }] };
  assert.deepStrictEqual(parseCardObject(JSON.stringify(obj)), obj);
  assert.deepStrictEqual(parseCardObject('```json\n' + JSON.stringify(obj) + '\n```'), obj);
  assert.deepStrictEqual(parseCardObject('好的：\n' + JSON.stringify(obj) + '\n需要我继续吗？'), obj);
  assert.deepStrictEqual(parseCardObject('```\n' + JSON.stringify(obj) + '\n```'), obj);
});

test('parseCardObject：嵌套对象不会被截错', () => {
  const nested = {
    anchor: { resumeId: 'exp-1', label: '经历 A' },
    points: [{ text: '现象' }, { text: '路径' }, { text: '关键' }, { text: '收尾' }],
    meta: { inner: { deep: { n: 1 } } },
  };
  assert.deepStrictEqual(parseCardObject(JSON.stringify(nested)), nested);
});

test('parseCardObject：JSON 后面还有带 } 的解释也不会切错（原逻辑会白扔一次重试）', () => {
  const obj = { anchor: { label: 'a' }, points: [{ text: '{注意} 括号' }] };
  const content = JSON.stringify(obj) + '\n上面这张卡说明了 {首段} 的用法，需要的话我再改。';
  assert.deepStrictEqual(parseCardObject(content), obj);
});

test('parseCardObject：字符串里的花括号不算结构', () => {
  const obj = { alias: 'REPLACE_ME_A', anchor: { label: '占位 ${VAR} 未替换' } };
  assert.deepStrictEqual(parseCardObject(JSON.stringify(obj)), obj);
});

test('parseCardObject：没有 JSON / JSON 截断时报错而不是返回半截', () => {
  assert.throws(() => parseCardObject('我不是 JSON'), /没有 JSON 对象/);
  assert.throws(() => parseCardObject(''), /没有 JSON 对象/);
  assert.throws(() => parseCardObject(null), /没有 JSON 对象/);
  assert.throws(() => parseCardObject('{"anchor":'), /没有 JSON 对象/);
  assert.throws(() => parseCardObject('{"anchor": "a",,}'), SyntaxError);
});

test('chat：成功路径', async () => {
  const f = installFetch(async () => okRes('{"anchor":{"label":"a"}}'));
  try {
    const c = createClient({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'm1' });
    const r = await c.chat([{ role: 'user', content: 'hi' }], { maxTokens: 64 });
    assert.strictEqual(r.content, '{"anchor":{"label":"a"}}');
    assert.deepStrictEqual(r.usage, { total_tokens: 12 });
    assert.ok(r.latencyMs >= 0);
    assert.strictEqual(f.calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(f.calls[0].init.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(f.calls[0].init.body);
    assert.strictEqual(body.model, 'm1');
    assert.strictEqual(body.max_tokens, 64);
    assert.deepStrictEqual(body.response_format, { type: 'json_object' });
    assert.strictEqual(typeof f.calls[0].init.signal, 'object');
  } finally {
    f.restore();
  }
});

test('chat：jsonMode=false 时不带 response_format', async () => {
  const f = installFetch(async () => okRes('ok'));
  try {
    const c = createClient({ apiKey: 'k' });
    const r = await c.chat([{ role: 'user', content: 'hi' }], { jsonMode: false });
    assert.strictEqual(r.content, 'ok');
    assert.strictEqual(JSON.parse(f.calls[0].init.body).response_format, undefined);
    assert.strictEqual(JSON.parse(f.calls[0].init.body).model, 'gpt-4o-mini');
  } finally {
    f.restore();
  }
});

test('chat：非 2xx 时错误信息带状态码与响应体', async () => {
  const f = installFetch(async () => errRes(401, 'Unauthorized', '{"error":{"message":"Incorrect API key"}}'));
  try {
    const c = createClient({ apiKey: 'bad' });
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'hi' }]),
      (e) => /LLM 401 Unauthorized/.test(e.message) && /Incorrect API key/.test(e.message),
    );
  } finally {
    f.restore();
  }
});

test('chat：2xx 但返回体不是 JSON 时给出可读错误', async () => {
  const f = installFetch(async () => ({
    ok: true, status: 200, statusText: 'OK',
    async text() { return '<html>502 Bad Gateway</html>'; },
  }));
  try {
    const c = createClient({ apiKey: 'k' });
    await assert.rejects(() => c.chat([{ role: 'user', content: 'hi' }]), /返回体不是 JSON/);
  } finally {
    f.restore();
  }
});

test('chat：超时按 AbortController 中断，并报「超时」而不是裸 AbortError', async () => {
  const f = installFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }));
  try {
    const c = createClient({ apiKey: 'k', timeoutMs: 40 });
    await assert.rejects(() => c.chat([{ role: 'user', content: 'hi' }]), /请求超时/);
  } finally {
    f.restore();
  }
});

test('chat：非法 timeoutMs（0/负数/NaN）不能让请求刚发出就被中断', async () => {
  let aborted = false;
  const f = installFetch((_url, init) => new Promise((resolve, reject) => {
    // 故意延迟一拍：0ms 的 setTimeout 会先于本 fake 的返回被触发
    setTimeout(() => resolve(okRes('late but fine')), 5);
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }));
  try {
    for (const bad of [0, -1, NaN, '100', undefined, null]) {
      const c = createClient({ apiKey: 'k', timeoutMs: bad });
      const r = await c.chat([{ role: 'user', content: 'hi' }]);
      assert.strictEqual(r.content, 'late but fine');
      assert.strictEqual(aborted, false, `timeoutMs=${bad} 不应触发中断`);
    }
  } finally {
    f.restore();
  }
});

test('chat：网络异常原样上抛（由 generateHintCard 决定重试）', async () => {
  const f = installFetch(async () => { throw new Error('ECONNREFUSED'); });
  try {
    const c = createClient({ apiKey: 'k' });
    await assert.rejects(() => c.chat([{ role: 'user', content: 'hi' }]), /ECONNREFUSED/);
  } finally {
    f.restore();
  }
});
