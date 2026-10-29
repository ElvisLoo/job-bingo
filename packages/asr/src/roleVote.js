'use strict';
/**
 * 段归属投票：把一串瞬时判定（me/them/unknown/silence）折成一个角色。
 *
 * 从「回声门 + VAD」这条链路里单独抽出来的纯函数，因为这里的取舍是产品级的：
 *   误判 them → 多出一张卡，用户看得见、可以忽略；
 *   误判 me   → 漏掉对方的一个问题，用户当场答不上来。
 * 两者代价不对称，所以判 me 的门槛必须高于一半，且只在「有效票」里算
 * （unknown/silence 不含信息，不该稀释票数）。
 */

const DEFAULT_ME_RATIO = 0.6;

/**
 * @param {Array<{role:string}>} verdicts 时间序，旧 → 新
 * @param {number} [meRatio] 判 me 所需的最低占比
 * @returns {'me'|'them'}
 */
function voteRole(verdicts, meRatio = DEFAULT_ME_RATIO) {
  if (!Array.isArray(verdicts) || !verdicts.length) return 'them';
  const valid = verdicts.filter((v) => v && (v.role === 'me' || v.role === 'them'));
  if (!valid.length) return 'them';
  const me = valid.filter((v) => v.role === 'me').length;
  return me / valid.length >= meRatio ? 'me' : 'them';
}

module.exports = { voteRole, DEFAULT_ME_RATIO };
