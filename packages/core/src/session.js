'use strict';
/**
 * 场次（Session）：把一场面试的问答记录独立出来。
 *
 * 为什么需要：
 *   原来全场记录只有一份，连着二面、三面时会被混在一起，
 *   复盘把两场的问题搅在一块，看不出「这一场答得怎么样」。
 *
 * 为什么不在 core 里直接用 fs：
 *   这里是三端共享的纯逻辑层（Windows / Android / 未来 Web）。
 *   持久化由调用方注入 storage adapter —— 桌面端用 fs，手机端用 Capacitor Filesystem。
 *
 * 设计要点：
 *   1. 每场独立存，切场不清空别的；
 *   2. 存档失败不能让正在进行的面试中断 —— 内存里始终有最新副本；
 *   3. 场次数量有上限，老的自动清理，避免无限膨胀。
 */

const DEFAULT_MAX_SESSIONS = 50;
const MAX_ENTRIES_PER_SESSION = 800;

/** 生成场次 id：时间戳 + 随机后缀，按时间天然有序 */
function newSessionId(now = Date.now(), rand = Math.random) {
  const t = new Date(now);
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}`
    + `-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
  const tail = Math.floor(rand() * 0x1000).toString(16).padStart(3, '0');
  return `${stamp}-${tail}`;
}

/**
 * storage adapter 契约：
 *   list()        → [{ id, startedAt, endedAt, entries, jd }]
 *   read(id)      → 完整场次对象 或 null
 *   write(id, obj) → 抛错表示失败
 *   remove(id)    → 抛错表示失败
 */
class SessionStore {
  /**
   * @param {object} opts
   * @param {object} opts.storage 持久化适配器（可省略，纯内存模式）
   * @param {number} [opts.maxSessions] 最多保留多少场
   * @param {() => number} [opts.now] 可注入时钟（测试用）
   */
  constructor(opts = {}) {
    this.storage = opts.storage || null;
    this.maxSessions = opts.maxSessions || DEFAULT_MAX_SESSIONS;
    this.now = opts.now || (() => Date.now());
    this.current = null;          // { id, startedAt, endedAt, jd, entries: [] }
    this.saveErrors = [];         // 落盘失败记录，供 UI 提示
  }

  /** 开始新的一场。若已有进行中的场次，先落盘归档。 */
  start(meta = {}) {
    if (this.current) this.flush();
    this.current = {
      id: newSessionId(this.now()),
      startedAt: this.now(),
      endedAt: null,
      jd: meta.jd || '',
      entries: [],
    };
    this.flush();
    return { id: this.current.id, startedAt: this.current.startedAt };
  }

  /** 确保有场次；没有就开一场 */
  ensure() {
    if (!this.current) this.start();
    return this.current.id;
  }

  /**
   * 追加一条记录。
   * @param {object} [opts]
   * @param {boolean} [opts.persist] 是否立即落盘，默认 true。
   *   必须默认落盘：只在内存里攒着等下一次 flush，进程崩了最后几句就没了，
   *   而那几句往往正是「刚才那个关键问题」。
   */
  push(role, text, at, opts = {}) {
    this.ensure();
    // 必须先 trim 再判空：只写空格的消息会让复盘里出现空条目
    const raw = String(text || '').trim();
    if (!raw) return;
    this.current.entries.push({
      role: role === 'me' ? 'me' : 'them',
      text: raw.slice(0, 2000),
      at: at || this.now(),
    });
    // 单场上限，防止超长会话把内存和文件撑爆
    if (this.current.entries.length > MAX_ENTRIES_PER_SESSION) {
      this.current.entries = this.current.entries.slice(-MAX_ENTRIES_PER_SESSION);
    }
    if (opts.persist !== false) this.flush();
  }

  /** 当前场次的记录副本 */
  entries() {
    return this.current ? this.current.entries.slice() : [];
  }

  /** 当前场次 id */
  currentId() {
    return this.current ? this.current.id : null;
  }

  /** 结束当前场次（不删，可继续复盘） */
  end() {
    if (!this.current) return null;
    this.current.endedAt = this.now();
    this.flush();
    return { id: this.current.id, entries: this.current.entries.length };
  }

  /** 列出所有场次（新的在前） */
  list() {
    if (!this.storage) return [];
    let raw = [];
    try { raw = this.storage.list() || []; } catch (_) { return []; }
    const out = [];
    for (const d of raw) {
      if (!d || !d.id) continue;
      out.push({
        id: d.id,
        startedAt: d.startedAt || 0,
        endedAt: d.endedAt || null,
        entries: (d.entries || []).length,
        jd: d.jd || '',
      });
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 读取指定场次 */
  read(id) {
    if (!this.storage) return null;
    try { return this.storage.read(id); } catch (_) { return null; }
  }

  /** 删除指定场次 */
  remove(id) {
    if (!this.storage) return { ok: false, reason: 'no storage' };
    try {
      this.storage.remove(id);
      if (this.current && this.current.id === id) this.current = null;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  /** 落盘当前场次；失败只记录，不抛（面试不能被存档失败打断） */
  flush() {
    if (!this.current || !this.storage) return { ok: true, skipped: true };
    try {
      this.storage.write(this.current.id, this.current);
      this.prune();
      return { ok: true };
    } catch (e) {
      const reason = String(e && e.message || e).slice(0, 200);
      this.saveErrors.push({ at: this.now(), reason });
      if (this.saveErrors.length > 20) this.saveErrors.shift();
      return { ok: false, reason };
    }
  }

  /** 超出上限时删最老的 */
  prune() {
    const all = this.list();
    if (all.length <= this.maxSessions) return 0;
    let n = 0;
    for (const s of all.slice(this.maxSessions)) {
      // 别删正在进行的那一场
      if (this.current && s.id === this.current.id) continue;
      if (this.remove(s.id).ok) n++;
    }
    return n;
  }
}

module.exports = {
  SessionStore,
  newSessionId,
  DEFAULT_MAX_SESSIONS,
  MAX_ENTRIES_PER_SESSION,
};
