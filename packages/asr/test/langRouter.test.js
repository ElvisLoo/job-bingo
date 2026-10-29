'use strict';
/**
 * 语言路由单测（node:test）
 * 覆盖：中文优先、英文判定、空文本兜底、粘性策略（短段/低置信度沿用上次语言）、按语种选引擎。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  LanguageRouter,
  detectLangFromText,
  pickEngine,
  DEFAULT_ROUTER_OPTIONS,
} = require('../src/langRouter');

test('detectLangFromText：纯中文 → chinese', () => {
  const r = detectLangFromText('请介绍一下你做过的项目，以及你在其中承担的角色');
  assert.strictEqual(r.lang, 'chinese');
  assert.strictEqual(r.latin, 0);
  assert.ok(r.cjk > 10);
  assert.ok(r.confident, '纯文本应自信');
  assert.strictEqual(r.zhRatio, 1);
});

test('detectLangFromText：纯英文 → english', () => {
  const r = detectLangFromText('Tell me about a challenging project you worked on.');
  assert.strictEqual(r.lang, 'english');
  assert.strictEqual(r.cjk, 0);
  assert.ok(r.confident);
});

test('detectLangFromText：中英混合按多数，平票时中文优先', () => {
  const zhHeavy = detectLangFromText('我们用 Redis 做缓存，把接口的平均响应时间从八百毫秒降到了八十毫秒');
  assert.strictEqual(zhHeavy.lang, 'chinese', '中文字符占多数时判中文');

  const enHeavy = detectLangFromText('We use Redis to cache the 热点数据 in this system');
  assert.strictEqual(enHeavy.lang, 'english', '英文占多数时判英文');

  const tie = detectLangFromText('中文 en');
  assert.strictEqual(tie.lang, 'chinese', '平票 → 中文优先');
  assert.strictEqual(tie.margin, 0);
  assert.strictEqual(tie.confident, false, '平票视为不自信');
});

test('detectLangFromText：无可判别字符时按初始语言兜底', () => {
  const r = detectLangFromText('12345！！！  ');
  assert.strictEqual(r.lang, 'chinese', '默认中文优先');
  assert.strictEqual(r.confident, false);
  assert.strictEqual(detectLangFromText('').lang, 'chinese');
  assert.strictEqual(detectLangFromText(null).lang, 'chinese');
});

test('LanguageRouter：短段与低置信度沿用上一次语言（粘性）', () => {
  const r = new LanguageRouter();
  assert.strictEqual(r.currentLang, 'chinese', '默认中文');

  // 音频太短 → 不信任 LID
  assert.strictEqual(r.decide(500, { lang: 'english', margin: 5 }), 'chinese');
  // 置信度不足 → 不信任 LID
  assert.strictEqual(r.decide(3000, { lang: 'english', margin: 0.5 }), 'chinese');
  // 又长又自信 → 切换
  assert.strictEqual(r.decide(3000, { lang: 'english', margin: 2 }), 'english');
  assert.strictEqual(r.currentLang, 'english');
  // 之后即使 LID 缺失也保持上次结果
  assert.strictEqual(r.decide(3000, null), 'english');

  r.reset();
  assert.strictEqual(r.currentLang, 'chinese');
});

test('LanguageRouter.shouldRunLid 与 decideByText', () => {
  const r = new LanguageRouter();
  assert.strictEqual(r.shouldRunLid(1500), true);
  assert.strictEqual(r.shouldRunLid(300), false);
  assert.strictEqual(DEFAULT_ROUTER_OPTIONS.minAudioMsForLid, 1200);

  const d = r.decideByText('Could you describe your experience with distributed systems?');
  assert.strictEqual(d.detected.lang, 'english');
  assert.strictEqual(d.lang, 'english');

  const d2 = r.decideByText('嗯'); // 不自信 → 沿用
  assert.strictEqual(d2.detected.confident, false);
  assert.strictEqual(d2.lang, 'english', '不自信时沿用上一次语言');
});

test('pickEngine：按语种取引擎，缺失时回落到 default/chinese', () => {
  const zh = { name: 'zh-engine' };
  const en = { name: 'en-engine' };
  assert.strictEqual(pickEngine('chinese', { chinese: zh, english: en }), zh);
  assert.strictEqual(pickEngine('english', { chinese: zh, english: en }), en);
  assert.strictEqual(pickEngine('english', { chinese: zh }), zh, '缺 english → 回落 chinese');
  assert.strictEqual(pickEngine('chinese', { default: { name: 'd' }, chinese: zh }), zh, '优先精确匹配');
  assert.strictEqual(pickEngine('english', { default: { name: 'd' } }).name, 'd');
  assert.strictEqual(pickEngine('chinese', {}), null);
});
