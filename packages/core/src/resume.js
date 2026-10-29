'use strict';
/**
 * 简历 → 锚点索引
 *
 * 「思路必须锚定简历里的具体项目」这条产品红线，靠这里落地：
 * 模型只能从 anchors 里挑 id，挑了不在索引里的 id 会被校验器判失败。
 * 用数据结构约束模型，比用祈使句约束模型有效得多。
 *
 * 兼容魔方简历 ResumeData（localStorage key: resume-storage 的 state.data）。
 */

const KIND_LABEL = {
  experience: '经历',
  project: '项目',
  education: '教育',
  skill: '技能',
};

function pickId(item, kind, idx) {
  const raw = item.id ?? item.uuid ?? item.key;
  // FIX: 数值型 id（部分简历导出给自增数字）必须转成字符串，否则模型回传的字符串 id 在 Set 里永远匹配不上，所有带锚点的卡都会被判失败
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return `${kind}:${idx}`;
}

/** 从一段文本里抽出所有数字，作为「可用数字白名单」 */
function extractNumbers(text) {
  const out = new Set();
  const m = String(text || '').match(/\d+(\.\d+)?/g);
  if (m) for (const n of m) out.add(n);
  return out;
}

/**
 * @param {object} data ResumeData（魔方简历导出 JSON 或 localStorage 里的 state.data）
 * @returns {{anchors: Array, numbers: Set<string>, ids: Set<string>, markdown: string}}
 */
function indexResume(data) {
  // FIX: 用户导入的 JSON 可能不是对象（null / 字符串 / 数组），原来只要 data 是 falsy 之外的情况就会在取字段时崩
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const anchors = [];
  const numbers = new Set();
  const ids = new Set();
  const md = [];

  const add = (kind, item, idx, labelParts, bodyParts) => {
    let id = pickId(item, kind, idx);
    // FIX: 重复 id 会让两段经历共用同一个 [id] 锚点，模型选中后无法判断指向哪一条
    if (ids.has(id)) {
      let n = 2;
      while (ids.has(`${id}#${n}`)) n++;
      id = `${id}#${n}`;
    }
    const label = labelParts.filter(Boolean).join(' · ');
    const body = bodyParts.filter(Boolean).join('\n');
    anchors.push({ id, kind, label: `${KIND_LABEL[kind] || kind} ${label}`.trim(), text: body });
    ids.add(id);
    const all = [label, body].join('\n');
    for (const n of extractNumbers(all)) numbers.add(n);
    md.push(`[${id}] ${label}\n${body}`);
  };

  const each = (list, fn) => {
    // FIX: 数组里混进 null/undefined（导出丢字段很常见）会让 e.company 抛 TypeError，整份简历索引失败
    const arr = Array.isArray(list) ? list : [];
    arr.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      fn(item, i);
    });
  };

  each(src.experience, (e, i) => {
    add('experience', e, i,
      [e.company, e.position, e.date || e.startDate],
      [e.details, e.description]);
  });

  each(src.projects, (p, i) => {
    add('project', p, i,
      [p.name, p.role, p.date || p.startDate],
      [p.description, p.details, p.tech]);
  });

  each(src.education, (e, i) => {
    add('education', e, i,
      [e.school, e.major, e.degree],
      [e.description, e.details]);
  });

  if (src.skillContent) {
    add('skill', { id: 'skill:0' }, 0, ['技能'], [String(src.skillContent)]);
  }
  if (src.selfEvaluationContent) {
    add('skill', { id: 'self:0' }, 0, ['自我评价'], [String(src.selfEvaluationContent)]);
  }

  const basic = src.basic && typeof src.basic === 'object' ? src.basic : {};
  if (basic.name || basic.title) {
    md.unshift(`候选人：${[basic.name, basic.title].filter(Boolean).join(' / ')}`);
  }

  return { anchors, numbers, ids, markdown: md.join('\n\n') };
}

/** 生成一份简历摘要 markdown（用于 prompt 前缀） */
function toMarkdown(data) {
  return indexResume(data).markdown;
}

module.exports = { indexResume, toMarkdown, extractNumbers };
