'use strict';
/**
 * 教练式追问（Coach）——复盘之后，针对答得薄的地方生成下一轮练习用的追问。
 *
 * 与复盘（review.js）的关系：
 *   复盘是「事后回看，指出哪里答薄了」；
 *   Coach 是「顺着这些薄弱点，再追问几句」，让用户在下一轮模拟里补上。
 *
 * 三条硬约束（与 review 对齐，都有代码保证）：
 *  1. **不编造**：追问必须挂在真实的薄弱点上——要么能在问答记录里算出来
 *     （没答 / 太短 / 没数字），要么来自复盘里已标注的 gap，不凭空造问题；
 *  2. **有据可回**：走模型时每条追问都要带一句原文引述（quote），且 quote
 *     必须真的出现在记录里，挂不住的追问直接丢弃；
 *  3. **可降级**：没配 Key、模型繁忙或失败时，用本地规则引擎产出「能在本地
 *     算出来」的追问，不是返回一张空白页。
 */

const { normalizeTranscript, extractNumbers } = require('./review');
const { createClient, parseCardObject } = require('./llm');

const MAX_QUESTIONS = 5;      // 一次最多追问 5 条，多了练不过来
const MIN_ANSWER_CHARS = 20;  // 复用复盘的阈值：不足 20 字撑不起一个完整例子
const QUOTE_MAX_CHARS = 40;   // 引述上限，避免模型整段抄
const MIN_QUOTE_CHARS = 4;    // 太短的引述无法验证

/** 归一化文本：去空白与常见标点，用于「相似追问」判重 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s。，、；：？！,.:;?!()"“”‘’「」《》\-—_·…]+/g, '');
}

/**
 * 相似判重：两条追问归一化后完全相同，或字符 bigram 重叠度过高，
 * 就视为同一薄弱点，只保留先出现的那条。
 */
function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function isSimilar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 很短的问题不做模糊匹配，避免误杀（例如两句不同的问题各 4 个字）
  if (x.length < 6 || y.length < 6) return false;
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const g of bx) if (by.has(g)) inter++;
  const denom = Math.min(bx.size, by.size) || 1;
  return inter / denom >= 0.6;
}

/** 从复盘结果里取出可用的条目数组（容忍 null / 脏结构） */
function reviewItems(review) {
  if (!review || typeof review !== 'object') return [];
  return Array.isArray(review.items) ? review.items.filter(Boolean) : [];
}

/** 把一段原文截成可用作引述的短句 */
function clipQuote(s) {
  return String(s || '').trim().slice(0, QUOTE_MAX_CHARS);
}

/**
 * 本地规则引擎：只追「能在 transcript / review 里算出来」的薄弱点。
 *
 * 覆盖四类真实薄弱点：
 *   ① 没答的问题（answer 为空）        → 追问同一个问题，要求必须答；
 *   ② 答太短（< 20 字）                → 追问「举一个具体例子，带数字」；
 *   ③ 没有数字的回答（无 /\d/）        → 追问「这个结果怎么量化」；
 *   ④ 复盘里标为 gap / risk 的点      → 针对该点生成对应追问。
 *
 * 每条追问都指向一个真实存在过的问答，不会凭空造问题。
 * @param {Array} transcript normalizeTranscript 的结果（也容忍原始流水）
 * @param {object} review 复盘结果（可空）
 * @returns {{questions:Array, meta:object}}
 */
function localCoach(transcriptIn, review) {
  // 容忍调用方直接传原始流水（带 role），内部统一配对成问答
  const raw = Array.isArray(transcriptIn) ? transcriptIn : [];
  const looksRaw = raw.some((x) => x && (x.role === 'them' || x.role === 'me'));
  const transcript = looksRaw ? normalizeTranscript(raw) : raw;

  const questions = [];
  const seen = new Set();     // 已追问过的原问题（归一化），用于去重

  const push = (q) => {
    if (!q || !q.question) return;
    const anchorKey = norm(q.anchor || q.focus);
    const key = norm(q.focus + '|' + anchorKey);
    if (seen.has(key)) return;
    // 追问句多为同一模板，逐字比对会被模板淹没；真正区分薄弱点的是 anchor
    // （原问题或原文引述）。因此相似判重只看 anchor，锚点相近才算同一处。
    for (const prev of questions) {
      if (prev.anchorNorm && anchorKey && isSimilar(prev.anchorNorm, anchorKey)) return;
    }
    seen.add(key);
    questions.push({
      question: String(q.question).slice(0, 200),
      focus: String(q.focus || '薄弱点').slice(0, 40),
      reason: String(q.reason || '').slice(0, 200),
      anchor: String(q.anchor || '').slice(0, 200),
      anchorNorm: anchorKey,
    });
  };

  // ①②③ 逐轮扫描问答记录，按「没答 > 太短 > 没数字」的优先级判薄弱点
  for (const t of transcript) {
    if (!t || !t.question) continue;
    const q = String(t.question).trim();
    if (!q) continue;
    const a = String(t.answer || '').trim();

    if (!a) {
      // ① 没答：追问同一个问题，要求正面回应
      push({
        question: `刚才「${q.slice(0, 60)}」你还没回答。这一轮请正面回应它，别绕开。`,
        focus: '未回答',
        reason: '记录里这个问题没有任何回答，是最直接的缺口',
        anchor: q,
      });
      continue;
    }

    if (a.length < MIN_ANSWER_CHARS) {
      // ② 太短：要求举一个带数字的具体例子
      push({
        question: `「${q.slice(0, 60)}」你只答了 ${a.length} 个字。能不能举一个具体的例子，带上数字？`,
        focus: '回答过短',
        reason: `回答仅 ${a.length} 字，撑不起一个完整的例子`,
        anchor: q,
      });
      continue;
    }

    if (!/\d/.test(a)) {
      // ③ 没数字：追问结果怎么量化
      push({
        question: `你提到「${clipQuote(a).slice(0, 24)}」，这个结果怎么量化？给我一个能验证的数字。`,
        focus: '缺少量化',
        reason: '回答里没有任何数字，结果是不可验证的',
        anchor: q,
      });
      // 答得够长也有数字 → 站得住，不追问
    }
  }

  // ④ 复盘里标为 gap / risk 的点：针对该点生成对应追问
  for (const it of reviewItems(review)) {
    const tag = it.tag;
    if (tag !== 'gap' && tag !== 'risk') continue;
    const q = String(it.question || '').trim();
    const anchor = q || clipQuote(it.quote);
    if (!anchor) continue;
    const isRisk = tag === 'risk';
    // 追问要指向具体的薄弱证据（原文引述），而不是泛泛复述问题
    const evidence = clipQuote(it.quote) || anchor.slice(0, 40);
    const tail = isRisk
      ? '这里如果被面试官深挖，你会怎么回应？'
      : '这里能不能再补一个具体的动作和结果？';
    push({
      question: `你提到「${evidence}」，我再追问一句：${tail}`,
      focus: isRisk ? '风险点' : '证据薄弱',
      reason: String(it.comment || '').trim().slice(0, 200) || '复盘标记此处答得薄',
      anchor,
    });
  }

  return {
    questions: questions.slice(0, MAX_QUESTIONS).map(({ anchorNorm, ...rest }) => rest),
    meta: { engine: 'local', count: Math.min(questions.length, MAX_QUESTIONS) },
  };
}

/** 生成 Coach 用的提示词（稳定指令 + 记录 + 复盘，便于 KV cache 复用） */
function buildCoachMessages(transcript, review, resumeMarkdown = '', jd = '') {
  const lines = transcript.map((t, i) => {
    const q = (t && t.question) || '（无提问）';
    const a = (t && t.answer) || '（未回答）';
    return `${i + 1}. 问：${q}\n   答：${a}`;
  }).join('\n');

  const items = reviewItems(review);
  const gaps = items
    .filter((it) => it.tag === 'gap' || it.tag === 'risk')
    .map((it) => `- [${it.tag}] ${it.question || it.quote}：${it.comment || ''}`)
    .join('\n');

  const system = [
    '你是一名严格的面试教练。用户刚结束一场模拟面试，现在你要针对答得薄的地方，',
    '出几条**下一轮练习用的追问**，像真实面试官那样顺着一个点往深里挖。',
    '',
    '硬性要求：',
    '1. 只能追问问答记录里真实出现过的内容，禁止凭空造新话题；',
    '2. 每条追问必须带 quote，且 quote 必须是问答记录里**原样出现**的一段（4–40 字）；',
    '3. question 里出现的任何数字，都必须能在问答记录或简历里找到，禁止编造；',
    '4. 只出追问，不给完整答案、不替用户写话术；',
    '5. 语气像真人面试官，自然、直接，不要生硬堆模板。',
    '',
    '输出 JSON：{"questions": [{"question": "", "focus": "", "reason": "", "quote": ""}]}',
    'questions 最多 5 条，focus 是薄弱点主题，reason 说明为什么要追问这个。',
  ].join('\n');

  const context = [
    jd ? `岗位：${jd}` : '',
    resumeMarkdown ? `简历：\n${resumeMarkdown}` : '',
    gaps ? `复盘标出的薄弱点：\n${gaps}` : '',
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${context}\n\n问答记录：\n${lines}` },
  ];
}

/**
 * 结构化校验：确保模型给的每条追问都挂在真实记录上（不编造）。
 * @param {object} draft 模型返回的草稿
 * @param {Array} transcript normalizeTranscript 的结果
 * @param {string} resumeMarkdown
 * @returns {{ok:boolean, questions?:Array, errors:Array}}
 */
function validateCoach(draft, transcript, resumeMarkdown = '') {
  const errors = [];
  if (!draft || typeof draft !== 'object') return { ok: false, errors: [{ code: 'NOT_OBJECT' }] };

  const allText = transcript.map((t) => `${(t && t.question) || ''} ${(t && t.answer) || ''}`).join(' ');
  const squash = (s) => String(s || '').replace(/\s+/g, '');
  const allNumbers = new Set(
    extractNumbers(allText).concat(extractNumbers(resumeMarkdown))
  );

  const list = Array.isArray(draft.questions) ? draft.questions : [];
  const clean = [];
  for (const it of list.slice(0, MAX_QUESTIONS)) {
    if (!it) continue;
    const question = String(it.question || '').trim().slice(0, 200);
    if (!question) { errors.push({ code: 'EMPTY_QUESTION' }); continue; }

    // ① 引述必须真的出现在记录里（追问要挂在真实问答上）
    const quote = String(it.quote || '').trim().slice(0, QUOTE_MAX_CHARS);
    const quoteOk = quote.length >= MIN_QUOTE_CHARS && squash(allText).includes(squash(quote));
    if (!quoteOk) { errors.push({ code: 'QUOTE_NOT_FOUND', quote }); continue; }

    // ② 追问里出现的数字必须在原文或简历里（不然就是编的）
    const nums = extractNumbers(question);
    const fake = nums.filter((n) => !allNumbers.has(n));
    if (fake.length) { errors.push({ code: 'NUMBER_NOT_FOUND', numbers: fake }); continue; }

    clean.push({
      question,
      focus: String(it.focus || '薄弱点').trim().slice(0, 40),
      reason: String(it.reason || '').trim().slice(0, 200),
      anchor: quote,
    });
  }

  if (!clean.length) {
    return { ok: false, errors: errors.length ? errors : [{ code: 'NO_QUESTIONS' }] };
  }
  return { ok: true, questions: clean, errors };
}

/**
 * 生成教练式追问。有 Key 走模型（失败 / 繁忙 / 校验不过则退回本地规则），无 Key 直接本地。
 * @param {object} cfgIn {transcript, review, resumeMarkdown, jd, cfg:{llm, client}}
 * @returns {Promise<{ok:boolean, questions:Array, meta:{engine:string,count:number}, degraded?:boolean}>}
 */
async function generateCoach(cfgIn = {}) {
  const { review, resumeMarkdown = '', jd = '' } = cfgIn;
  const sub = cfgIn.cfg || {};
  const llm = sub.llm || cfgIn.llm || {};

  const raw = Array.isArray(cfgIn.transcript) ? cfgIn.transcript : [];
  const looksRaw = raw.some((x) => x && (x.role === 'them' || x.role === 'me'));
  const transcript = looksRaw ? normalizeTranscript(raw) : raw;

  // 没有任何问答记录时仍返回有效结构，只是没有可追问的点（不崩、不编造）
  if (!transcript.length) {
    return { ok: true, questions: [], meta: { engine: 'local', count: 0 } };
  }

  const fallback = () => {
    const local = localCoach(transcript, review);
    return { ok: true, questions: local.questions, meta: local.meta };
  };

  if (!llm.apiKey) return fallback();

  const client = sub.client && sub.client.chat ? sub.client : createClient(llm);
  try {
    const messages = buildCoachMessages(transcript, review, resumeMarkdown, jd);
    const res = await client.chat(messages, { maxTokens: 700, temperature: 0.3 });
    let draft = null;
    try { draft = parseCardObject(res.content); } catch (_) { draft = null; }
    if (draft) {
      const v = validateCoach(draft, transcript, resumeMarkdown);
      if (v.ok) {
        return {
          ok: true,
          questions: v.questions.slice(0, MAX_QUESTIONS),
          meta: { engine: 'llm', count: Math.min(v.questions.length, MAX_QUESTIONS) },
        };
      }
    }
  } catch (_) { /* 模型失败不阻断 Coach，走本地兜底 */ }

  const local = fallback();
  return { ...local, degraded: true };
}

module.exports = {
  localCoach,
  generateCoach,
  buildCoachMessages,
  validateCoach,
  MAX_QUESTIONS,
  MIN_ANSWER_CHARS,
};