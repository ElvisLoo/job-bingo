'use strict';
/**
 * 长面试上下文管理
 *
 * 问题：一场面试可能 40-60 分钟、上百条对话。原来的做法是
 * `history.slice(-6)` —— 只带最近 6 条进提示词。后果有两个：
 *   1. 后面问到「你刚才说的那个项目，具体怎么做的」，模型根本不知道
 *      「那个项目」是什么，只能瞎猜；
 *   2. 面试官问到前面已经答过的内容，模型无法察觉，给出重复要点。
 *
 * 直接把全场塞进去也不行：token 线性增长，成本翻倍、延迟上升，
 * 而且早期的寒暄对当前问题毫无价值。
 *
 * 方案（三层）：
 *   - 近层：最近 N 条原文，逐字保留 —— 追问几乎都发生在这里；
 *   - 摘要层：更早的问答压成「一问一答一行」的骨架，保留主题与关键实体，
 *             让模型知道「聊过什么」，但不需要逐字；
 *   - 追问检测：当前问题与早期主题有明显重叠时，把对应原文单独捞回来。
 *
 * 全部是纯函数，不碰网络、不碰 fs —— 三端共享，可以单独测。
 */

/** 关系统计：粗粒度汉字/字母数字切分，够用来算重叠，且不依赖分词器 */
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  // 英文/数字串整体作为一个 token（React、K8s、MySQL 这类词不该被切开）
  const re = /[a-z0-9][a-z0-9_+#.-]*|[\u4e00-\u9fa5]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const piece = m[0];
    if (/^[a-z0-9]/.test(piece)) {
      out.push(piece);
      continue;
    }
    // 中文段用滑动二元组，而不是每两字一截：
    // 「订单履约系统」切成 订单/履约/系统，
    // 而「说说你做的订单履约系统」会切成 说说/你做/的订/单履/约系 ——
    // 两边一个都对不上，相似度恒为 0，追问检测完全失效。
    if (piece.length === 1) {
      out.push(piece);
    } else {
      for (let i = 0; i + 1 < piece.length; i += 1) {
        out.push(piece.slice(i, i + 2));
      }
    }
  }
  return out;
}

/** 中文虚词/口头语：出现在所有句子里，不能用来判断"在聊同一件事" */
const STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '然后',
  '就是', '但是', '因为', '所以', '如果', '已经', '一个', '一些', '的话',
  '这样', '那样', '还是', '或者', '而且', '不过', '其实', '应该', '需要',
  '进行', '通过', '对于', '关于', '以及', '还有', '没有', '不是', '这些',
  '那些', '一下', '时候', '问题', '方面', '情况',
]);

/**
 * 从文本里提取"主题词"：去停用词、去纯数字、去单字。
 * 这些词才是判断「在聊同一件事」的依据。
 */
function keywords(text, limit = 24) {
  const seen = new Set();
  const out = [];
  for (const t of tokens(text)) {
    if (t.length < 2) continue;
    if (STOP.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Jaccard 相似度 */
function similarity(aWords, bWords) {
  if (!aWords.length || !bWords.length) return 0;
  const bs = new Set(bWords);
  let inter = 0;
  for (const w of aWords) if (bs.has(w)) inter += 1;
  if (inter === 0) return 0;
  const union = new Set([...aWords, ...bWords]).size;
  const jaccard = union === 0 ? 0 : inter / union;
  // 追问句通常比原句长得多（「那个…你刚说…怎么…」），
  // 纯 Jaccard 会被长度差稀释到几乎为 0。
  // 再看一眼「占较短一方的比例」，两者取高。
  const containment = inter / Math.min(aWords.length, bWords.length);
  return Math.max(jaccard, containment * 0.6);
}

/**
 * 把早期的问答记录压成骨架。
 * 一条面试官问题 + 紧随其后的一条回答 = 一组。
 * 只保留前 40 字，够看出主题即可。
 */
function summarize(entries, opts = {}) {
  const perLine = opts.charsPerLine || 40;
  const lines = [];
  let pendingQ = null;

  const clip = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > perLine ? t.slice(0, perLine) + '…' : t;
  };

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const text = String(e.text || '').trim();
    if (!text) continue;
    if (e.role === 'them') {
      if (pendingQ !== null) lines.push(`问：${pendingQ}｜答：（未答）`);
      pendingQ = clip(text);
    } else {
      if (pendingQ !== null) {
        lines.push(`问：${pendingQ}｜答：${clip(text)}`);
        pendingQ = null;
      } else {
        lines.push(`答：${clip(text)}`);
      }
    }
  }
  if (pendingQ !== null) lines.push(`问：${pendingQ}｜答：（未答）`);
  return lines;
}

/**
 * 检测当前问题是不是在追问早期话题。
 * 返回命中的早期条目（原文），没有命中返回空数组。
 *
 * 阈值 0.12 偏保守：宁可多带一点早期原文，也不要在用户被追问时
 * 让模型完全不知道"那个东西"指什么。代价只是几百 token。
 */
function findRelated(entries, question, opts = {}) {
  const minScore = opts.minScore ?? 0.12;
  const maxHits = opts.maxHits ?? 4;
  const qWords = keywords(question);
  if (qWords.length === 0) return [];

  const scored = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;
    const text = String(e.text || '');
    if (!text) continue;
    const score = similarity(qWords, keywords(text));
    if (score >= minScore) scored.push({ i, score, entry: e });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxHits).map((s) => s.entry);
}

/**
 * 组装提供给模型的上下文。
 *
 * @param {object} opts
 * @param {Array}  opts.entries    本场全部记录（按时间正序）
 * @param {string} opts.question   当前问题
 * @param {number} [opts.recentTurns] 近层保留多少条原文（默认 8，约 4 轮）
 * @param {number} [opts.maxSummaryLines] 摘要最多多少行（默认 24）
 * @returns {{ recent, summaryLines, related, stats }}
 */
function buildContext(opts = {}) {
  const entries = Array.isArray(opts.entries) ? opts.entries.filter((e) => e && typeof e === 'object') : [];
  const question = String(opts.question || '');
  const recentTurns = Math.max(2, opts.recentTurns ?? 8);
  const maxSummaryLines = Math.max(4, opts.maxSummaryLines ?? 24);

  // 当前问题可能已经作为最后一条 push 进 entries（转写先落库、再出卡）。
  // 必须去掉，否则同一句话会既出现在近层原文、又作为结尾提问重复一次，
  // 而且会形成连续两条 user 消息 —— 部分网关直接判 400。
  const body = entries.slice();
  const qNorm = question.replace(/\s+/g, '').trim();
  if (qNorm) {
    for (let i = body.length - 1; i >= 0; i -= 1) {
      const e = body[i];
      if (!e || typeof e !== 'object') continue;
      const t = String(e.text || '').replace(/\s+/g, '').trim();
      // 用"包含"而不是"相等"：面试官原话常带语气词
      //（「好的，你刚才提到的那个项目…」），相等匹配会漏掉，
      // 于是同一句话既在近层原文、又作为结尾提问，出现连续两条 user。
      if (t === qNorm || t.includes(qNorm) || qNorm.includes(t)) {
        body.splice(i, 1);
        break;
      }
      // 只回看最后几条：更早的同句是用户真的重复问过，不该删
      if (body.length - i > 3) break;
    }
  }

  const splitAt = Math.max(0, body.length - recentTurns);
  const older = body.slice(0, splitAt);
  const recent = body.slice(splitAt);

  // 摘要只保留最近的部分行：一场 100 条的面试，早期内容全部压成骨架
  let summaryLines = summarize(older);
  const droppedLines = Math.max(0, summaryLines.length - maxSummaryLines);
  if (droppedLines > 0) {
    summaryLines = [
      `（更早的 ${droppedLines} 组问答已省略）`,
      ...summaryLines.slice(-maxSummaryLines),
    ];
  }

  // 追问检测只在"早期"里找：近层已经在原文里了，不必重复
  const related = older.length ? findRelated(older, question) : [];
  // 命中的条目若已出现在摘要里，仍要单独给原文 —— 摘要只有 40 字，
  // 追问时往往需要原话里的细节（数字、技术名词）。
  const relatedDedup = [];
  const seen = new Set();
  for (const r of related) {
    const key = String(r.text || '').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    relatedDedup.push(r);
  }

  return {
    recent,
    summaryLines,
    related: relatedDedup,
    stats: {
      totalEntries: entries.length,
      recentCount: recent.length,
      summarizedCount: older.length,
      relatedCount: relatedDedup.length,
      droppedLines,
    },
  };
}

module.exports = {
  tokens,
  keywords,
  similarity,
  summarize,
  findRelated,
  buildContext,
};
