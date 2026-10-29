'use strict';
/** 端到端：合成音频 → WAV → VAD 分段 → ASR 转写 → pipeline → 思路卡 */
const assert = require('node:assert');
const test = require('node:test');
const asr = require('@job-bingo/asr');
const { Pipeline } = require('../../packages/desktop/src/main/pipeline');

function mkPipeline(pushed, llm, asrCfg) {
  return new Pipeline({
    getConfig: () => ({ llm: llm || { apiKey: '' }, asr: asrCfg, jd: '' }),
    getResume: () => ({ projects: [{ id: 'proj:0', name: 'ERP 成本分析', description: 'INVQ01 INV102' }] }),
    pushCard: (p) => pushed.push(p),
  });
}

const GOOD_CARD = JSON.stringify({
  anchor: { resumeId: 'proj:0', label: 'ERP 成本分析' },
  points: [
    { kind: 'fact', text: 'INVQ01 流水核对' },
    { kind: 'path', text: 'INV102 成本重算' },
  ],
  caution: null,
});

test('ASR 层可用且不含 electron 依赖', () => {
  assert.ok(asr, 'ASR 应能被 require');
  assert.ok(typeof asr.createAsrRouter === 'function');
  assert.ok(typeof asr.segmentPcm === 'function');
  assert.ok(typeof asr.encodeWav === 'function');
});

test('完整链路：合成音频 → WAV → 分段 → 转写 → 出思路卡', async () => {
  const pushed = [];
  const p = mkPipeline(pushed);

  const pcm = asr.synthSpeechLike({ cycles: 3, silenceSec: 0.5, speechSec: 0.9, freq: 440, amp: 0.35 });
  const wav = asr.encodeWav(pcm, 16000);

  // 显式标注「对方在问」：feedWav 默认按 me 处理（外部音频多为自己），
  // 只有标 them 才会出卡。这里测的是完整出卡链路。
  const r = await p.feedWav(wav, { role: 'them' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.segments >= 3, `应切出 ≥3 段，实际 ${r.segments}`);

  // 段长 = 语音 0.9s + preRoll 0.3s + hangover 0.3s ≈ 1.5s。
  // feedPcm 按实际 PCM 长度算（含前后缓冲），所以上限放宽到 2.0。
  for (const s of r.results) {
    assert.ok(s.durationSec > 0.6 && s.durationSec < 2.0, `段长异常 ${s.durationSec}`);
  }

  const cards = pushed.filter((x) => x.type === 'card');
  assert.ok(cards.length >= 3, `应至少出 3 张卡，实际 ${cards.length}`);
  for (const c of cards) {
    assert.ok(c.card.points.length >= 2, '每张卡至少 2 条要点');
    assert.equal(c.from, 'asr');
  }
});

test('无语音的静音 WAV 不产生卡片也不报错', async () => {
  const pushed = [];
  const p = mkPipeline(pushed);
  const silence = new Float32Array(16000 * 2);
  const r = await p.feedWav(asr.encodeWav(silence, 16000));
  assert.equal(r.ok, true);
  assert.equal(r.segments, 0);
  assert.equal(pushed.filter((x) => x.type === 'card').length, 0);
});

test('ASR 与 LLM 可分离配置，且 ASR 请求体合规', async (t) => {
  const http = require('node:http');

  // ASR 与 LLM 必须是两个独立端点：真实部署中用户会分别选供应商
  // （例如 ASR 用硅基流动、LLM 用 DeepSeek）。共用端口会让两者互相覆盖。
  const asrSeen = [];
  const asrServer = http.createServer((req, res) => {
    let body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(body);
      asrSeen.push({ url: req.url, auth: req.headers.authorization, buf });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: '说说库存成本异常怎么定位' }));
    });
  });
  const llmServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_CARD } }] }));
    });
  });

  await new Promise((r) => asrServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
  const asrPort = asrServer.address().port;
  const llmPort = llmServer.address().port;
  t.after(() => { asrServer.close(); llmServer.close(); });

  const pushed = [];
  const p = mkPipeline(
    pushed,
    { baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'llm-key', model: 'llm-model' },
    { baseUrl: `http://127.0.0.1:${asrPort}/v1`, apiKey: 'asr-key', model: 'asr-model' },
  );

  const pcm = asr.synthSpeechLike({ cycles: 1, silenceSec: 0.4, speechSec: 0.9 });
  const r = await p.feedWav(asr.encodeWav(pcm, 16000));

  assert.ok(asrSeen.length >= 1, 'ASR 端点应收到请求');
  const hit = asrSeen.find((s) => s.buf.includes(Buffer.from('name="file"')));
  assert.ok(hit, 'ASR multipart 应含 file 字段');
  assert.ok(String(hit.auth || '').includes('asr-key'), 'ASR 应用自己的 Key，不能串用 LLM 的');
  assert.ok(hit.url.includes('/audio/transcriptions'), `ASR 路径不对：${hit.url}`);
  assert.ok(r.results.length >= 1);
  // 真引擎有返回文本时应直接用，不能被 mock 占位文本覆盖
  assert.equal(r.results[0].text, '说说库存成本异常怎么定位');
  assert.equal(r.results[0].engine, 'cloud');
});

// ---------------- v0.1.1：双轨回声门（自我触发回归） ----------------

test('我方语音只进上下文，不出卡（回环自我触发的核心回归）', async () => {
  const pushed = [];
  const p = mkPipeline(pushed);
  const pcm = asr.synthSpeechLike({ cycles: 1, silenceSec: 0.3, speechSec: 0.8, freq: 440, amp: 0.35 });

  const r = await p.feedPcm(pcm, { role: 'me' });
  assert.equal(r.role, 'me');
  assert.equal(pushed.filter((x) => x.type === 'card').length, 0, '我方语音不应出卡');
  assert.ok(p.history.some((h) => h.role === 'me'), '应当写入上下文供 LLM 消歧');
  // 我方语音不套演示问题（那不是识别失败）
  assert.ok(!p.history.some((h) => h.role === 'me' && /请先做一个自我介绍/.test(h.text)));
});

test('同一段音频判为对方时才出卡', async () => {
  const pushed = [];
  const p = mkPipeline(pushed);
  const pcm = asr.synthSpeechLike({ cycles: 1, silenceSec: 0.3, speechSec: 0.8, freq: 440, amp: 0.35 });
  const r = await p.feedPcm(pcm, { role: 'them' });
  assert.equal(r.role, 'them');
  assert.ok(pushed.filter((x) => x.type === 'card').length >= 1, '对方语音应出卡');
});

test('回声门判定为对方 → 我方回答进入上下文后，下一问仍能出卡', async () => {
  const pushed = [];
  const p = mkPipeline(pushed);
  const pcm = asr.synthSpeechLike({ cycles: 1, silenceSec: 0.3, speechSec: 0.8, freq: 440, amp: 0.35 });
  await p.feedPcm(pcm, { role: 'me' });
  const before = pushed.filter((x) => x.type === 'card').length;
  await p.feedPcm(pcm, { role: 'them' });
  const after = pushed.filter((x) => x.type === 'card').length;
  assert.equal(before, 0);
  assert.ok(after >= 1);
});

test('不确定归属（unknown）时宁多出一张卡，也不漏掉对方问题', () => {
  const { DualTrackEchoGate } = asr;
  const gate = new DualTrackEchoGate();
  const r = gate.classify(null, new Float32Array(1600).fill(0.1));
  assert.equal(r.role, 'unknown');
});
