'use strict';
/**
 * 思路卡（HintCard）数据契约 + 校验器
 *
 * 产品红线：本模块是「不代答」的技术保证。
 * 提示词只是建议，validateHintCard 才是法律 —— 模型迟早会飘，
 * 校验器不会。任何一条要点只要长得像可直接念出的成稿，一律判失败。
 *
 * 规格来源：docs/10-思路卡输出规格.md
 */

const MAX_POINT_CHARS = 18; // 汉字数上限
const MIN_POINTS = 2;
const MAX_POINTS = 4;

// 连接词是一篇成稿的骨架。去掉它，用户必须自己组织逻辑。
const CONNECTIVES = [
  '首先', '其次', '再次', '然后', '接着', '最后', '总之', '综上',
  '因此', '所以', '而且', '并且', '另外', '此外', '与此同时',
  '一方面', '另一方面', '总的来说', '简而言之',
];

// 句末标点 = 成稿的标志。要点不该有句号。
const SENTENCE_END = /[。！？；.!?;．…]$/;

// FIX: 句末标点后面跟着引号/括号时（模型爱给要点加引号）原正则漏判，放行了一眼看得出是成稿的要点
const CLOSERS = /[\s"'”’」』）)》】\]]+$/;

const CJK = /[\u4e00-\u9fa5]/g;

/** 统计汉字数（非汉字字符不计入 18 字预算，避免数字/英文被误杀） */
function countCJK(text) {
  const m = String(text || '').match(CJK);
  return m ? m.length : 0;
}

/**
 * 校验单条要点
 * @returns {{ok: boolean, reason?: string, code?: string}}
 */
function validatePoint(point) {
  if (!point || typeof point.text !== 'string') {
    return { ok: false, code: 'SHAPE', reason: '要点缺少 text 字段' };
  }
  const text = point.text.trim();

  if (text.length === 0) {
    return { ok: false, code: 'EMPTY', reason: '要点为空' };
  }

  // 闸门 1：防代答 —— 有句末标点就是一句成稿
  const tail = text.replace(CLOSERS, '') || text;
  if (SENTENCE_END.test(tail)) {
    return { ok: false, code: 'SENTENCE_END', reason: `检测为完整句子（句末标点）：${text}` };
  }

  // 闸门 2：防代答 —— 以「我」开头即为可直接念出的回答
  if (/^我/.test(text)) {
    return { ok: false, code: 'FIRST_PERSON', reason: `以「我」开头，属成稿而非要点：${text}` };
  }

  // 闸门 3：长度
  const n = countCJK(text);
  if (n > MAX_POINT_CHARS) {
    return { ok: false, code: 'TOO_LONG', reason: `${n} 汉字 > ${MAX_POINT_CHARS}：${text}` };
  }

  // 闸门 4：连接词
  for (const c of CONNECTIVES) {
    if (text.includes(c)) {
      return { ok: false, code: 'CONNECTIVE', reason: `含连接词「${c}」，属成稿骨架：${text}` };
    }
  }

  return { ok: true };
}

/**
 * 校验整张思路卡
 * @param {object} card
 * @param {Set<string>|null} allowedNumbers 简历中出现过的数字白名单；null = 不校验
 * @param {Set<string>|null} allowedResumeIds 简历条目 id 集合；null = 不校验锚点
 * @returns {{ok: boolean, errors: Array<{code:string,reason:string}>}}
 */
function validateHintCard(card, allowedNumbers, allowedResumeIds) {
  const errors = [];
  const fail = (code, reason) => errors.push({ code, reason });

  if (!card || typeof card !== 'object') {
    return { ok: false, errors: [{ code: 'SHAPE', reason: '不是对象' }] };
  }

  // 锚点：不是形式，是防火墙。必须存在。
  if (!card.anchor || typeof card.anchor.label !== 'string') {
    fail('NO_ANCHOR', '缺少锚点（anchor.label）');
  } else if (allowedResumeIds && card.anchor.resumeId && !allowedResumeIds.has(card.anchor.resumeId)) {
    fail('ANCHOR_UNKNOWN', `锚点 resumeId 不在简历中：${card.anchor.resumeId}`);
  }

  const points = Array.isArray(card.points) ? card.points : [];
  if (points.length < MIN_POINTS || points.length > MAX_POINTS) {
    fail('POINT_COUNT', `要点数 ${points.length}，要求 ${MIN_POINTS}-${MAX_POINTS} 条`);
  }

  for (const p of points) {
    const r = validatePoint(p);
    if (!r.ok) fail(r.code, r.reason);
  }

  // 数字必须来自简历 —— 治幻觉的硬手段
  if (allowedNumbers) {
    for (const p of points) {
      // FIX: points 里混进 null / 数字元素是模型的常见输出，直接取 p.text 会抛 TypeError，整张卡连同重试一起崩
      const raw = p && typeof p === 'object' ? String(p.text || '') : '';
      const nums = raw.match(/\d+(\.\d+)?/g) || [];
      for (const n of nums) {
        if (!allowedNumbers.has(n)) {
          fail('NUMBER_NOT_IN_RESUME', `数字「${n}」未出现在简历中：${p.text}`);
        }
      }
    }
  }

  if (card.caution != null && typeof card.caution !== 'string') {
    fail('SHAPE', 'caution 必须是字符串或 null');
  }

  return { ok: errors.length === 0, errors };
}

/** 把校验失败原因压缩成一句给模型看的修正指令（用于重生成） */
function buildRepairInstruction(errors) {
  const lines = errors.map((e) => `- ${e.reason}`).join('\n');
  return [
    '你上一次的输出未通过校验，必须修正后重新输出：',
    lines,
    '',
    '硬性要求：每条要点 ≤18 汉字；不要句末标点；不要以「我」开头；',
    '不要使用「首先/其次/最后」等连接词；数字只能取自简历原文。',
  ].join('\n');
}

module.exports = {
  MAX_POINT_CHARS,
  MIN_POINTS,
  MAX_POINTS,
  CONNECTIVES,
  countCJK,
  validatePoint,
  validateHintCard,
  buildRepairInstruction,
};
