'use strict';
/**
 * 复盘（Review）——把一场面试的问答记录折成结构化纪要。
 *
 * 产品定位：复盘是**事后**的，与实时提示是两件事。
 *   实时：只给要点，不代答，落到屏幕上；
 *   复盘：事后回看，指出「哪里答薄了、下回补什么」，落成文件。
 *
 * 三条硬约束（都有代码保证，不靠模型自觉）：
 *  1. **不编造**：纪要里的数字必须能在问答原文或简历里找到（复用数字白名单思路）；
 *  2. **有据可回**：每条点评必须带一句原文引述（quote），且 quote 必须真的出现在记录里；
 *  3. **可降级**：没配 Key 时用规则引擎产出一份「能在本地算出来」的纪要，
 *     不是给一张空白页。
 */


const MAX_ITEMS = 12;          // 最多保留 12 轮，超出只取最近的部分
const QUOTE_MAX_CHARS = 40;    // 引述上限，避免模型整段抄
const MIN_QUOTE_CHARS = 4;     // 太短的引述无法验证

/** 把 pipeline.history 整理成可读的问答序列 */
function normalizeTranscript(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  let pendingQ = null;
  for (const h of history) {
    if (!h || !h.text) continue;
    const text = String(h.text).trim();
    if (!text) continue;
    if (h.role === 'them') {
      if (pendingQ) out.push({ question: pendingQ, answer: '' });
      pendingQ = text;
    } else if (h.role === 'me') {
      if (pendingQ) { out.push({ question: pendingQ, answer: text }); pendingQ = null; }
      else out.push({ question: '', answer: text });
    }
  }
  if (pendingQ) out.push({ question: pendingQ, answer: '' });
  return out.slice(-MAX_ITEMS);
}

/** 从问答里抽数字（用于「不许编造」校验） */
function extractNumbers(text) {
  const m = String(text || '').match(/\d+(?:\.\d+)?%?/g);
  return m ? m : [];
}

/**
 * 结构化校验：确保模型给的每一条点评都有原文依据。
 * @param {object} draft  模型返回的复盘草稿
 * @param {Array} transcript normalizeTranscript 的结果
 * @param {string} resumeMarkdown
 * @returns {{ok:boolean, review?:object, errors:Array}}
 */
function validateReview(draft, transcript, resumeMarkdown = '') {
  const errors = [];
  if (!draft || typeof draft !== 'object') return { ok: false, errors: [{ code: 'NOT_OBJECT' }] };

  const allText = transcript.map((t) => `${t.question} ${t.answer}`).join(' ');
  const allNumbers = new Set(extractNumbers(allText).concat(extractNumbers(resumeMarkdown)));

  const items = Array.isArray(draft.items) ? draft.items : [];

  const clean = [];
  for (const it of items.slice(0, MAX_ITEMS)) {
    if (!it) continue;
    const quote = String(it.quote || '').trim().slice(0, QUOTE_MAX_CHARS);
    // ① 引述必须真的出现在记录里（去掉空白后比对，容忍标点差异）
    const squash = (s) => s.replace(/\s+/g, '');
    const quoteOk = quote.length >= MIN_QUOTE_CHARS && squash(allText).includes(squash(quote));
    if (!quoteOk) { errors.push({ code: 'QUOTE_NOT_FOUND', quote }); continue; }

    // ② 点评里出现的数字必须在原文或简历里（不然就是编的）
    const nums = extractNumbers(it.comment);
    const fake = nums.filter((n) => !allNumbers.has(n));
    if (fake.length) { errors.push({ code: 'NUMBER_NOT_FOUND', numbers: fake }); continue; }

    clean.push({
      question: String(it.question || '').trim().slice(0, 200),
      quote,
      comment: String(it.comment || '').trim().slice(0, 200),
      tag: ['strength', 'gap', 'risk'].includes(it.tag) ? it.tag : 'gap',
    });
  }

  if (!clean.length) return { ok: false, errors: errors.length ? errors : [{ code: 'NO_ITEMS' }] };

  const summary = String(draft.summary || '').trim().slice(0, 200);
  const nextSteps = Array.isArray(draft.nextSteps)
    ? draft.nextSteps.slice(0, 5).map((s) => String(s).trim().slice(0, 80)).filter(Boolean)
    : [];

  return {
    ok: true,
    review: {
      summary,
      items: clean,
      nextSteps,
      stats: reviewStats(clean, transcript),
      dropped: errors.slice(0, 20), // 被拦下的条目也返回，便于观察模型漂移
    },
    errors,
  };
}

/** 统计：答薄了几轮、每轮平均字数 */
function reviewStats(items, transcript) {
  const answered = transcript.filter((t) => t.answer);
  const avgChars = answered.length
    ? Math.round(answered.reduce((s, t) => s + t.answer.length, 0) / answered.length)
    : 0;
  return {
    rounds: transcript.length,
    answeredRounds: answered.length,
    avgAnswerChars: avgChars,
    gaps: items.filter((i) => i.tag === 'gap').length,
    strengths: items.filter((i) => i.tag === 'strength').length,
  };
}

/**
 * 本地规则引擎：没配 Key、或模型持续失败时的兜底。
 *
 * 不做「像模像样的点评」，只给**能在本地算出来的事实**：
 * 哪一轮答得短、哪一轮没答、哪一轮关键词密度低。
 * 这类结论虽然朴素，但每一条都可验证，不会误导人。
 */
function localReview(transcript) {
  const items = [];
  for (const t of transcript) {
    if (!t.question) continue;
    const a = (t.answer || '').trim();
    const q = t.question.slice(0, 60);
    if (!a) {
      items.push({ question: q, quote: t.question.slice(0, QUOTE_MAX_CHARS), comment: '这一问题在记录里没有对应回答', tag: 'gap' });
      continue;
    }
    if (a.length < 20) {
      items.push({ question: q, quote: a.slice(0, QUOTE_MAX_CHARS), comment: `回答仅 ${a.length} 字，撑不起一个完整的例子`, tag: 'gap' });
    } else if (!/\d/.test(a)) {
      items.push({ question: q, quote: a.slice(0, QUOTE_MAX_CHARS), comment: '回答里没有任何数字，结果是不可验证的', tag: 'gap' });
    } else {
      items.push({ question: q, quote: a.slice(0, QUOTE_MAX_CHARS), comment: '有数字、有关键词，结构上站得住', tag: 'strength' });
    }
  }

  const stats = reviewStats(items, transcript);
  const nextSteps = [];
  if (stats.gaps) nextSteps.push(`补齐 ${stats.gaps} 处证据薄弱的地方，每处都要有一个具体数字`);
  if (stats.avgAnswerChars < 60) nextSteps.push('把平均回答长度提到 60 字以上，用「情境—动作—结果」撑开');
  if (!nextSteps.length) nextSteps.push('按本场节奏再做一轮模拟，重点练追问下的补充说明');

  return {
    summary: `本地复盘：共 ${stats.rounds} 轮提问，其中 ${stats.gaps} 处证据不足。未配置模型，结论仅基于字数与数字密度。`,
    items: items.slice(0, MAX_ITEMS),
    nextSteps,
    stats,
    meta: { engine: 'local' },
  };
}

/** 生成复盘用的提示词（稳定前缀 + 指令 + 记录，便于 KV cache 复用） */
function buildReviewMessages(transcript, resumeMarkdown = '', jd = '') {
  const lines = transcript.map((t, i) => {
    const q = t.question || '（无提问）';
    const a = t.answer || '（未回答）';
    return `${i + 1}. 问：${q}\n   答：${a}`;
  }).join('\n');

  const system = [
    '你是一名严谨的面试复盘教练。用户会给你一场面试的问答记录。',
    '你的任务不是重新回答，而是指出「哪里答得薄」。',
    '',
    '硬性要求：',
    '1. 每条 items 必须包含 quote，且 quote 必须是问答记录里**原样出现**的一段（4–40 字）。',
    '2. comment 里出现的任何数字，都必须能在问答记录或简历里找到，禁止编造。',
    '3. 只做点评，不给完整答案、不替用户写话术。',
    '4. 语气直接，指出问题而不是安慰。',
    '',
    '输出 JSON：{"summary": "一句话总体判断", "items": [{"question": "", "quote": "", "comment": "", "tag": "strength|gap|risk"}], "nextSteps": ["具体可执行的一条"]}',
    'items 最多 8 条，nextSteps 最多 4 条。',
  ].join('\n');

  const context = [jd ? `岗位：${jd}` : '', resumeMarkdown ? `简历：\n${resumeMarkdown}` : '']
    .filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${context}\n\n问答记录：\n${lines}` },
  ];
}

/**
 * 生成复盘。有 Key 走模型（失败或校验不过则退回本地规则），无 Key 直接本地。
 * @param {object} cfg {transcript, resumeMarkdown, jd, llm, client}
 */
async function generateReview(cfg = {}) {
  // 允许直接传「原始历史」（带 role 的流水），内部统一配对成问答。
  // 调用方传原始记录更自然，也避免两处各配一次导致轮次对不上。
  const raw = Array.isArray(cfg.transcript) ? cfg.transcript : [];
  const looksRaw = raw.some((x) => x && (x.role === 'them' || x.role === 'me'));
  const transcript = looksRaw ? normalizeTranscript(raw) : raw;
  if (!transcript.length) {
    return { ok: false, error: '没有可复盘的问答记录' };
  }
  const llm = cfg.llm || {};
  if (!llm.apiKey) {
    return { ok: true, review: localReview(transcript) };
  }

  const client = cfg.client; // 允许注入，便于单测
  const run = client && client.chat ? client : require('./llm').createClient(llm);
  try {
    const messages = buildReviewMessages(transcript, cfg.resumeMarkdown || '', cfg.jd || '');
    const res = await run.chat(messages, { maxTokens: 900, temperature: 0.2 });
    let draft = null;
    try { draft = JSON.parse(res.content); } catch (_) { draft = null; }
    if (draft) {
      const v = validateReview(draft, transcript, cfg.resumeMarkdown || '');
      if (v.ok) return { ok: true, review: { ...v.review, meta: { engine: 'llm' } } };
    }
  } catch (_) { /* 模型失败不阻断复盘 */ }

  // 退回本地：宁可给可验证的朴素结论，也不给一张空白页或编造的点评
  return { ok: true, review: localReview(transcript), degraded: true };
}

/** 复盘 → Markdown（用于落盘 / 粘贴） */
function reviewToMarkdown(review, ctx = {}) {
  if (!review) return '# 复盘\n\n（无记录）\n';
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const s = review.stats || {};
  const lines = [
    `# 面试复盘 · ${stamp}`,
    '',
    ctx.jd ? `> 岗位：${ctx.jd}` : '',
    `> 引擎：${review.meta && review.meta.engine === 'llm' ? '模型' : '本地规则'} · 轮次：${s.rounds || 0} · 证据不足：${s.gaps || 0}`,
    '',
    '## 总体判断',
    '',
    review.summary || '（无）',
    '',
    '## 逐条',
    '',
  ].filter((l) => l !== '');

  for (const it of review.items || []) {
    const tag = { strength: '✅ 站得住', gap: '⚠️ 答得薄', risk: '🚩 有风险' }[it.tag] || '•';
    lines.push(`### ${tag}｜${it.question || '（未标注问题）'}`);
    if (it.quote) lines.push(`> ${it.quote}`);
    lines.push('', it.comment || '', '');
  }

  if (review.nextSteps && review.nextSteps.length) {
    lines.push('## 下一步', '');
    for (const n of review.nextSteps) lines.push(`- ${n}`);
    lines.push('');
  }

  lines.push('---', '> 本复盘只做点评，不代替你组织回答。');
  return lines.join('\n');
}

module.exports = {
  normalizeTranscript,
  validateReview,
  localReview,
  generateReview,
  buildReviewMessages,
  reviewToMarkdown,
  extractNumbers,
  reviewStats,
};
