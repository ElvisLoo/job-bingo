'use strict';
/**
 * 思路卡校验器测试 —— 这是「不代答」红线的最后一道防线，
 * 所以五道闸门每条都必须同时有「应当拦截」和「应当放行」的对比例子。
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  MAX_POINT_CHARS, MIN_POINTS, MAX_POINTS, CONNECTIVES,
  countCJK, validatePoint, validateHintCard, buildRepairInstruction,
} = require('../src/hint-card');

const hasCode = (r, code) => r.errors.some((e) => e.code === code);

test('countCJK 只统计汉字', () => {
  assert.strictEqual(countCJK('账面 1000 pcs'), 2);
  assert.strictEqual(countCJK('INVQ01 流水 → INV102'), 2);
  assert.strictEqual(countCJK(''), 0);
  assert.strictEqual(countCJK(null), 0);
  assert.strictEqual(countCJK(undefined), 0);
  assert.strictEqual(countCJK('一二三四五'), 5);
});

test('闸门 1（句末标点）：应当拦截', () => {
  const cases = [
    '负责支付链路重构。',
    'Payment gateway refactor.',
    '负责库存模块！',
    '库存余额是负的？',
    '余额 −3994.58；',
    '余额 −3994.58;',
    '负责库存模块…',
    '负责库存模块．',
    '"负责库存模块。"',      // FIX: 结尾引号包裹，过去漏判
    '负责库存模块。」',
    '负责库存模块。\n',       // trim 之后仍应判出
  ];
  for (const text of cases) {
    const r = validatePoint({ kind: 'fact', text });
    assert.strictEqual(r.ok, false, `应拦截：${text}`);
    assert.strictEqual(r.code, 'SENTENCE_END', `错的闸门：${text} → ${r.code}`);
  }
});

test('闸门 1（句末标点）：应当放行', () => {
  const cases = [
    '账面 1000 pcs / 余额 -3994.58',
    'INVQ01 流水 → INV102 成本重算',
    '出入库异动类型 + 暂估凭证',
    '定位到单据层，不是调总数',   // 句中逗号不算成稿
  ];
  for (const text of cases) {
    assert.strictEqual(validatePoint({ text }).ok, true, `应放行：${text}`);
  }
});

test('闸门 2（以「我」开头）：应当拦截', () => {
  for (const text of ['我负责过支付网关的库存', '我在万金天宇做过 ERP', '我的排查路径是先查流水']) {
    const r = validatePoint({ text });
    assert.strictEqual(r.ok, false, `应拦截：${text}`);
    assert.strictEqual(r.code, 'FIRST_PERSON');
  }
});

test('闸门 2：句首空白仍要认出来，句中「我」按规格放行', () => {
  assert.strictEqual(validatePoint({ text: '  我负责过支付网关' }).code, 'FIRST_PERSON');
  // 规格只禁止"我……"开头，句中的「我」不在闸门范围内（有意为之，非 bug）
  assert.strictEqual(validatePoint({ text: '排查路径：我先看流水' }).ok, true);
  assert.strictEqual(validatePoint({ text: '腾讯支付网关重构' }).ok, true);
});

test('闸门 3（18 汉字上限）：边界', () => {
  const exact = '一二三四五六七八九十' + '一二三四五六七八'; // 18
  assert.strictEqual(countCJK(exact), MAX_POINT_CHARS);
  assert.strictEqual(validatePoint({ text: exact }).ok, true);

  const over = exact + '九'; // 19
  const r = validatePoint({ text: over });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'TOO_LONG');
  assert.match(r.reason, /19 汉字/);
});

test('闸门 3：英文/数字不计入 18 字预算（刻意设计）', () => {
  const long = 'Payment gateway latency optimization after refactor';
  assert.strictEqual(validatePoint({ text: long }).ok, true);
});

test('闸门 4（连接词）：应当拦截', () => {
  for (const c of CONNECTIVES) {
    const r = validatePoint({ text: `${c}讲现象` });
    assert.strictEqual(r.ok, false, `应拦截连接词：${c}`);
    assert.strictEqual(r.code, 'CONNECTIVE');
  }
  // 埋在句中间也要拦
  assert.strictEqual(validatePoint({ text: '排查路径，最后定位到单据' }).code, 'CONNECTIVE');
});

test('闸门 4：应当放行', () => {
  for (const text of ['现象：账面库存与余额不符', '路径：先流水后成本', '关键：异动类型']) {
    assert.strictEqual(validatePoint({ text }).ok, true, `应放行：${text}`);
  }
});

test('validatePoint 形状异常不崩', () => {
  for (const bad of [undefined, null, '', 0, 123, true, [], {}, { text: 123 }, { text: null }, { text: {} }]) {
    const r = validatePoint(bad);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'SHAPE');
  }
  assert.strictEqual(validatePoint({ text: '   ' }).code, 'EMPTY');
  assert.strictEqual(validatePoint({ text: '\n\t\u3000' }).code, 'EMPTY');
});

test('validateHintCard：合法卡通过', () => {
  const card = {
    anchor: { resumeId: 'exp:0', label: '经历 万金天宇 · ERP' },
    points: [
      { kind: 'fact', text: '账面 1000 pcs / 余额 -3994.58' },
      { kind: 'path', text: 'INVQ01 流水 → INV102 成本重算' },
      { kind: 'key', text: '出入库异动类型 + 暂估凭证' },
    ],
    caution: '别急着说改好了',
  };
  // 白名单与 indexResume 的口径一致：连写在标识符里的数字（INVQ01 → "01"）也算数字
  const r = validateHintCard(card, new Set(['1000', '3994.58', '01', '102']), new Set(['exp:0']));
  assert.deepStrictEqual(r, { ok: true, errors: [] });
});

test('validateHintCard：锚点缺失 / 越界', () => {
  const base = { points: [{ text: '现象' }, { text: '路径' }] };
  assert.ok(hasCode(validateHintCard({ ...base }, null, null), 'NO_ANCHOR'));
  assert.ok(hasCode(validateHintCard({ ...base, anchor: {} }, null, new Set(['a'])), 'NO_ANCHOR'));
  assert.ok(hasCode(validateHintCard({ ...base, anchor: { resumeId: 'ghost', label: 'x' } }, null, new Set(['a'])), 'ANCHOR_UNKNOWN'));
  // 简历里真没有对应内容时允许 resumeId 为 null / 缺省
  const okNull = validateHintCard({ ...base, anchor: { resumeId: null, label: '无直接对应' } }, null, new Set(['a']));
  assert.strictEqual(okNull.ok, true);
  const okEmpty = validateHintCard({ ...base, anchor: { label: '无直接对应' } }, null, new Set(['a']));
  assert.strictEqual(okEmpty.ok, true);
});

test('validateHintCard：要点条数', () => {
  const mk = (n) => ({ anchor: { label: 'x' }, points: Array.from({ length: n }, (_, i) => ({ text: `要点${i}` })) });
  for (const n of [0, 1]) assert.ok(hasCode(validateHintCard(mk(n), null, null), 'POINT_COUNT'), `n=${n}`);
  for (const n of [MIN_POINTS, 3, MAX_POINTS]) assert.strictEqual(validateHintCard(mk(n), null, null).ok, true, `n=${n}`);
  assert.ok(hasCode(validateHintCard(mk(5), null, null), 'POINT_COUNT'));
  // points 不是数组也不能崩
  assert.ok(hasCode(validateHintCard({ anchor: { label: 'x' }, points: '现象' }, null, null), 'POINT_COUNT'));
  assert.ok(hasCode(validateHintCard({ anchor: { label: 'x' } }, null, null), 'POINT_COUNT'));
});

test('validateHintCard：points 混进 null / 非对象时不崩（原会抛 TypeError）', () => {
  const card = { anchor: { label: 'x' }, points: [null, { text: '现象' }, 42, '路径', undefined] };
  const r = validateHintCard(card, new Set(['9']), null);
  assert.ok(hasCode(r, 'SHAPE'));
  assert.strictEqual(typeof r.ok, 'boolean');
});

test('validateHintCard：数字必须来自简历', () => {
  const mk = (text) => ({ anchor: { label: 'x' }, points: [{ text }, { text: '路径' }] });
  const allowed = new Set(['1000', '3994.58', '3']);
  assert.strictEqual(validateHintCard(mk('余额 −3994.58'), allowed, null).ok, true);
  assert.strictEqual(validateHintCard(mk('带 3 人团队'), allowed, null).ok, true);

  const bad = validateHintCard(mk('性能提升 80%'), allowed, null);
  assert.ok(hasCode(bad, 'NUMBER_NOT_IN_RESUME'));
  assert.match(bad.errors[0].reason, /80/);

  // 小数不匹配整数白名单：只写 3994 而简历里是 3994.58，仍然判失败
  assert.ok(hasCode(validateHintCard(mk('余额 3994'), allowed, null), 'NUMBER_NOT_IN_RESUME'));
  // 不传白名单 = 不校验数字
  assert.strictEqual(validateHintCard(mk('性能提升 80%'), null, null).ok, true);
});

test('validateHintCard：整卡形状', () => {
  assert.deepStrictEqual(validateHintCard(null, null, null).errors, [{ code: 'SHAPE', reason: '不是对象' }]);
  assert.deepStrictEqual(validateHintCard('card', null, null).errors, [{ code: 'SHAPE', reason: '不是对象' }]);
  const badCaution = validateHintCard({ anchor: { label: 'x' }, points: [{ text: 'a' }, { text: 'b' }], caution: 42 }, null, null);
  assert.ok(hasCode(badCaution, 'SHAPE'));
  const okCaution = validateHintCard({ anchor: { label: 'x' }, points: [{ text: 'a' }, { text: 'b' }], caution: null }, null, null);
  assert.strictEqual(okCaution.ok, true);
});

test('validateHintCard：多条问题一次报全（便于一次性修正）', () => {
  // 单条要点只报最先命中的那道闸门，所以要靠多条要点把四个问题暴露出来
  const card = {
    anchor: { resumeId: 'ghost', label: 'x' },
    points: [{ text: '负责 ERP 重构。' }, { text: '我带 3 人做这件事' }, { text: '首先讲现象' }],
  };
  const codes = validateHintCard(card, new Set(['3']), new Set(['a'])).errors.map((e) => e.code);
  assert.ok(codes.includes('ANCHOR_UNKNOWN'));
  assert.ok(codes.includes('SENTENCE_END'));
  assert.ok(codes.includes('FIRST_PERSON'));
  assert.ok(codes.includes('CONNECTIVE'));
});

test('buildRepairInstruction', () => {
  const s = buildRepairInstruction([{ code: 'TOO_LONG', reason: '19 汉字' }]);
  assert.match(s, /19 汉字/);
  assert.match(s, /≤18 汉字/);
  assert.match(s, /不要句末标点/);
  assert.strictEqual(typeof buildRepairInstruction([]), 'string');
});
