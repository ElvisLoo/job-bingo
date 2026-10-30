'use strict';
/**
 * 提示词构造
 *
 * 关键设计：前缀必须「逐字节稳定」—— 系统提示 + 简历 + JD。
 * 这样可以在面试开始前发一个 max_tokens=1 的空请求把 provider 侧 KV cache 预热，
 * 之后每题的 prefill 都命中缓存：首 token 更快、成本约 1/10。
 * （借鉴 MeetingCopilot 的 prefix-cache 预热思路）
 */

const context = require('./context');

const SYSTEM_PROMPT = [
  '你是面试思路助手。你的唯一职责：帮候选人在面试现场快速组织回答。',
  '',
  '【绝对红线】',
  '1. 你只能输出「要点」，不能输出成稿答案。要点必须是不完整的短语，',
  '   用户需要自己补主语和连接词才能说出口。',
  '2. 每条要点 ≤18 个汉字。',
  '3. 输出 2-4 条要点，不多不少。',
  '4. 禁止句末标点（。！？；）。有句号就意味着那是可直接念出的句子。',
  '5. 禁止以「我」开头。',
  '6. 禁止使用「首先/其次/然后/最后/因此/总之」等连接词。',
  '7. 所有数字、公司名、技术名词只能取自下方简历原文，禁止编造。',
  '8. 必须从简历锚点列表中选择一个 resumeId 作为 anchor。',
  '   若简历中确实没有对应内容，anchor.resumeId 设为 null，',
  '   anchor.label 填「无直接对应」。这本身是有用信息，不要硬凑。',
  '',
  '【要点类型】按现象→路径→关键→收尾的顺序组织，每条用一个类型标签：',
  '- fact：可验证的事实/数字',
  '- path：排查或实施路径',
  '- key：最关键的一个判断',
  '- close：收尾时要落到哪一层',
  '',
  '【输出格式】只输出 JSON，不要解释，不要 markdown 代码块：',
  '{"anchor":{"resumeId":"<id 或 null>","label":"<锚点标题>"},',
  ' "points":[{"kind":"fact","text":"<≤18 汉字>"}],',
  ' "caution":"<一句提醒，≤24 汉字，可 null>"}',
].join('\n');

/**
 * 稳定前缀：面试期间不变的部分。
 * 必须保证每次调用返回完全相同的字符串（不要插入时间戳、随机 id）。
 */
function buildStablePrefix(resumeMarkdown, jdText) {
  const parts = [SYSTEM_PROMPT, '', '===== 候选人简历 =====', resumeMarkdown || '（未提供简历）'];
  if (jdText && jdText.trim()) {
    parts.push('', '===== 目标岗位 JD =====', jdText.trim());
  }
  parts.push('', '===== 锚点 id 列表（只能从这里选）=====');
  parts.push('见上方简历中每段的 [id] 标记。');
  return parts.join('\n');
}

/** 构造一次提问的完整 messages */
/**
 * 构造一次提问的完整 messages。
 *
 * 上下文分三层（见 context.js）：
 *   1. 近层原文 —— 最近几轮逐字保留，追问几乎都落在这里；
 *   2. 早期摘要 —— 更早的问答压成「问｜答」骨架，让模型知道聊过什么；
 *   3. 追问回溯 —— 当前问题与早期某话题高度相关时，把那几句原文捞回来。
 *
 * 只带最近 6 条时，面试官说「你刚才提到的那个项目」，模型完全无从得知
 * 指代对象，只能编。这是长面试里最伤的一类错误。
 */
function buildMessages({ prefix, question, history, entries, contextOpts }) {
  const messages = [];

  const q = String(question ?? '').trim();
  // entries 是本场完整记录；没传就退回 history，保持向后兼容
  const pool = Array.isArray(entries) ? entries : (Array.isArray(history) ? history : []);
  const ctx = context.buildContext({ entries: pool, question: q, ...(contextOpts || {}) });

  // ---- 摘要层 + 追问回溯 ----
  // 两段合并进同一条 system 消息，而不是各推一条：
  // 多数 OpenAI 兼容网关只接受「开头一条 system」，中间再出现 system
  // 会被判 400 或被悄悄丢掉 —— 那样回溯就白做了。
  // 也不混进对话轮次，否则模型会把摘要当成自己说过的话去引用。
  const sysBlocks = [];
  if (ctx.summaryLines.length) {
    sysBlocks.push(
      '【本场面试此前的问答概要（已压缩，仅供判断已经聊过什么，不要复述给用户）】\n'
      + ctx.summaryLines.join('\n')
    );
  }
  if (ctx.related.length) {
    const lines = ctx.related.map((e) => {
      const who = e.role === 'them' ? '面试官' : '我';
      return `- ${who}：${String(e.text || '').slice(0, 300)}`;
    });
    sysBlocks.push(
      '【当前问题可能是在追问以下早前内容，请依据指代关系作答，不要重复已给过的要点】\n'
      + lines.join('\n')
    );
  }
  // 前缀（系统提示 + 简历 + JD）与上下文段合成一条 system。
  // 拆成两条时严格网关只认第一条，第二段被丢掉 —— 表现为「偶尔追问失效」，
  // 而且前缀命中 KV cache，从延迟上根本看不出来。
  // 前缀（系统提示 + 简历 + JD）与上下文段合成一条 system。
  // 拆成两条时严格网关只认第一条，第二段被丢掉 —— 表现为「偶尔追问失效」，
  // 而且前缀命中 KV cache，从延迟上根本看不出来。
  const NL = String.fromCharCode(10, 10);
  const systemContent = [prefix].concat(sysBlocks).join(NL);
  messages.push({ role: 'system', content: systemContent });
  // ---- 近层原文：真正的对话轮次 ----
  for (const t of ctx.recent) {
    // history 里混进 null / 字符串会让 t.role 抛 TypeError，整条流水线挂掉；
    // 空文本消息还会被部分网关判 400
    if (!t || typeof t !== 'object') continue;
    const text = String(t.text ?? '').trim();
    if (!text) continue;
    if (t.role === 'them') messages.push({ role: 'user', content: `（面试官说）${text}` });
    else if (t.role === 'me') messages.push({ role: 'assistant', content: `（我答）${text}` });
  }

  messages.push({
    role: 'user',
    content: `面试官刚才问：${q}\n\n请给出思路要点（JSON）。`,
  });
  return messages;
}

/** 预热请求：max_tokens=1，只为让 provider 缓存 prefill */
function buildWarmupMessages(prefix) {
  return [
    { role: 'system', content: prefix },
    { role: 'user', content: '（面试开始前的预热，请只回复一个字：好）' },
  ];
}

module.exports = { SYSTEM_PROMPT, buildStablePrefix, buildMessages, buildWarmupMessages };
