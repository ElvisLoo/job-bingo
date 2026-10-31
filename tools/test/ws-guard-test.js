'use strict';
/**
 * 手机通道（WS）的输入防护：回归测试。
 *
 * 这条通道绑在 0.0.0.0 上，同一 Wi-Fi 下任何能拿到配对码的进程都能连。
 * 配对码是本机设置页显示的，但一旦泄露（截图、录屏），
 * 防护就只剩"代码里写没写上限"。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'index.js'),
  'utf8'
);

test('WS 帧大小有上限，不交给对端决定', () => {
  assert.ok(/maxPayload:\s*\d+\s*\*\s*1024\s*\*\s*1024/.test(src), '应设置 maxPayload');
  const m = src.match(/maxPayload:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
  const mb = Number(m[1]);
  assert.ok(mb > 0 && mb <= 64, `上限应合理，实际 ${mb}MB`);
});

test('音频消息有独立的 base64 长度上限', () => {
  assert.ok(src.includes('MAX_B64'), '应有音频长度上限');
  assert.match(src, /rawB64\.length\s*>\s*MAX_B64/, '超限时应提前返回');
});

test('超限音频返回明确错误而不是静默丢弃', () => {
  const idx = src.indexOf('MAX_B64');
  const seg = src.slice(idx, idx + 700);
  assert.ok(seg.includes('audio:ack'), '应回执');
  assert.ok(seg.includes('ok: false'), '应标记失败');
});

test('手机端带来的 history 被截断与清洗', () => {
  assert.match(src, /Array\.isArray\(msg\.history\)\s*\?\s*msg\.history\.slice\(-12\)/, '应限制条数');
  assert.ok(src.includes('String(h.text).slice(0, 2000)'), '应限制单条长度');
});

test('端口被占用时给用户可见提示', () => {
  assert.ok(src.includes('EADDRINUSE'), '应识别端口占用');
  const idx = src.indexOf('EADDRINUSE');
  const seg = src.slice(idx - 300, idx + 600);
  assert.ok(seg.includes('pushCard'), '应推送提示卡');
  assert.ok(seg.includes('被占用'), '文案应说明原因');
});

test('WS 错误不会变成未捕获异常', () => {
  assert.ok(/wss\.on\('error'/.test(src), '应有 error 监听');
});
