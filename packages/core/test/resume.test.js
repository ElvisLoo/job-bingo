'use strict';
/** 简历 → 锚点索引：这是「锚点必须真实存在」这条红线的地基 */
const test = require('node:test');
const assert = require('node:assert');
const { indexResume, toMarkdown, extractNumbers } = require('../src/resume');

const RESUME = {
  basic: { name: '张三', title: 'ERP 实施顾问' },
  experience: [
    {
      id: 'exp-1',
      company: '淮北万金天宇',
      position: 'ERP 实施顾问',
      date: '2021.03-2024.06',
      details: '负责 ERP 库存成本模块，处理负库存问题 1000 件，余额 −3994.58',
    },
    {
      company: '某某科技',
      position: '开发工程师',
      description: '做过支付网关，QPS 2000 提升到 6000',
    },
  ],
  projects: [{ id: 'p-1', name: '库存成本治理', role: '负责人', tech: 'INVQ01 / INV102' }],
  education: [{ school: '某某大学', major: '信息管理', degree: '本科' }],
  skillContent: '熟悉 INVQ01 库存明细查询',
  selfEvaluationContent: '做事稳，愿意啃硬骨头',
};

test('extractNumbers', () => {
  assert.deepStrictEqual([...extractNumbers('余额 −3994.58，共 1000 件')], ['3994.58', '1000']);
  assert.deepStrictEqual([...extractNumbers('没有数字')], []);
  assert.deepStrictEqual([...extractNumbers(null)], []);
  assert.deepStrictEqual([...extractNumbers(undefined)], []);
  assert.deepStrictEqual([...extractNumbers(42)], ['42']);
});

test('indexResume：正常简历产出锚点 / ids / 数字 / markdown', () => {
  const idx = indexResume(RESUME);
  assert.strictEqual(idx.anchors.length, 6); // 2 经历 + 1 项目 + 1 教育 + 技能 + 自我评价
  assert.ok(idx.ids.has('exp-1') && idx.ids.has('p-1'));
  assert.strictEqual(idx.ids.size, idx.anchors.length, 'id 不应重复');
  assert.ok(idx.numbers.has('3994.58'));
  assert.ok(idx.numbers.has('1000'));
  assert.ok(idx.numbers.has('6000'));
  assert.match(idx.markdown, /候选人：张三 \/ ERP 实施顾问/);
  assert.match(idx.markdown, /\[exp-1\] 淮北万金天宇 · ERP 实施顾问 · 2021\.03-2024\.06/);
  for (const a of idx.anchors) {
    assert.strictEqual(typeof a.id, 'string');
    assert.ok(a.id.length > 0);
    assert.strictEqual(typeof a.label, 'string');
    assert.ok(a.label.length > 0);
  }
});

test('indexResume：缺 id 时按 kind:idx 兜底', () => {
  const idx = indexResume({ experience: [{ company: 'A' }], education: [{ school: 'B' }] });
  assert.ok(idx.ids.has('experience:0'));
  assert.ok(idx.ids.has('education:0'));
});

test('indexResume：数值型 id 必须转成字符串（否则模型回传的字符串 id 永远匹配不上）', () => {
  const idx = indexResume({ experience: [{ id: 7, company: 'A' }] });
  assert.strictEqual(idx.anchors[0].id, '7');
  assert.ok(idx.ids.has('7'));
});

test('indexResume：重复 id 必须消歧，不能两段经历共用一个锚点', () => {
  const idx = indexResume({ experience: [{ id: 'dup', company: 'A' }, { id: 'dup', company: 'B' }] });
  assert.strictEqual(idx.ids.size, 2);
  assert.strictEqual(idx.anchors[0].id, 'dup');
  assert.strictEqual(idx.anchors[1].id, 'dup#2');
  assert.match(idx.markdown, /\[dup#2\]/);
});

test('indexResume：脏数据不崩', () => {
  for (const bad of [null, undefined, '', 42, 'abc', [], [1, 2], true]) {
    const idx = indexResume(bad);
    assert.deepStrictEqual(idx.anchors, [], `输入 ${JSON.stringify(bad)} 应得到空锚点`);
    assert.strictEqual(idx.numbers.size, 0);
    assert.strictEqual(idx.markdown, '');
  }
  // 数组里混进 null / undefined / 字符串 / 数字
  const idx = indexResume({
    experience: [null, { company: 'A' }, undefined, 'xx', 7],
    projects: undefined,
    education: [null],
    basic: 'not an object',
  });
  assert.strictEqual(idx.anchors.length, 1);
  assert.strictEqual(idx.anchors[0].id, 'experience:1');
});

test('indexResume：字段缺失 / 字段类型异常也能出锚点', () => {
  const idx = indexResume({
    experience: [{ company: null, position: undefined, details: 0 }],
    projects: [{ name: '', role: '', tech: ['a', 'b'] }],
  });
  assert.strictEqual(idx.anchors.length, 2);
  assert.ok(idx.anchors.every((a) => typeof a.label === 'string'));
});

test('indexResume：技能与自我评价各占一个互不冲突的锚点', () => {
  const idx = indexResume({ skillContent: 'SQL', selfEvaluationContent: '稳' });
  assert.deepStrictEqual(idx.anchors.map((a) => a.id), ['skill:0', 'self:0']);
});

test('indexResume：简历里没有任何数字时白名单为空（数字闸门退化为全拦）', () => {
  const idx = indexResume({ experience: [{ company: 'A', details: '做了很多优化' }] });
  assert.strictEqual(idx.numbers.size, 0);
});

test('toMarkdown 等价于 indexResume().markdown', () => {
  assert.strictEqual(toMarkdown(RESUME), indexResume(RESUME).markdown);
  assert.strictEqual(toMarkdown(null), '');
});
