'use strict';
/**
 * 浮窗渲染层
 *
 * 刻意的三个「不做」：不做逐字流式、不做打字机、不做彩色高亮动画。
 * 面试时任何动的东西都会把视线从面试官身上拽走；
 * 整卡到达后一次性淡入 120ms，已经足够。
 */
const $ = (id) => document.getElementById(id);
const KIND_TEXT = { fact: '事实', path: '路径', key: '关键', close: '收尾' };

function setDot(state) {
  const d = $('dot');
  const cls = state === 'live' ? ' live' : state === 'err' ? ' err' : state === 'wait' ? ' wait' : '';
  d.className = 'dot' + cls;
}

function renderCard(card, question, from) {
  $('empty').hidden = true;
  $('question').hidden = true;

  const c = $('card');
  c.hidden = false;

  const anchor = $('anchor');
  const wrap = anchor.parentElement;
  const noMatch = !card.anchor || !card.anchor.resumeId || /无直接对应/.test(card.anchor.label || '');
  anchor.textContent = card.anchor?.label || '—';
  wrap.className = 'anchor' + (noMatch ? ' no-match' : '');

  const ul = $('points');
  ul.innerHTML = '';
  for (const p of (card.points || [])) {
    const li = document.createElement('li');
    li.className = 'kind-' + (p.kind || 'fact');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = KIND_TEXT[p.kind] || '要点';
    const t = document.createElement('span');
    t.textContent = p.text;
    li.appendChild(k);
    li.appendChild(t);
    ul.appendChild(li);
  }

  const ca = $('caution');
  if (card.caution) { ca.hidden = false; ca.textContent = '⚠ ' + card.caution; }
  else ca.hidden = true;

  if (question) {
    $('question').hidden = false;
    $('question').textContent = `问：${question}`;
  }

  // 重放入场动画（整卡一次淡入，不逐字）
  c.style.animation = 'none';
  void c.offsetWidth;
  c.style.animation = '';

  setDot('live');
  $('src').textContent = from === 'phone' ? '手机采集' : '电脑采集';
  $('lat').textContent = card.meta?.latencyMs ? `${card.meta.latencyMs}ms · ${card.meta.attempt || 1}次` : '—';
}

function renderError(payload) {
  $('empty').hidden = true;
  $('card').hidden = false;
  $('points').innerHTML = '';
  $('anchor').textContent = '生成失败（校验未通过）';
  $('anchor').parentElement.className = 'anchor no-match';
  const li = document.createElement('div');
  li.className = 'err';
  li.textContent = (payload.errors || []).map((e) => `· ${e.reason}`).join('\n') || '未知错误';
  $('points').appendChild(li);
  $('caution').hidden = true;
  setDot('err');
}

window.copilot.onMode((m) => {
  $('mode').textContent = m.mouseThrough ? '穿透' : '可操作';
});

function fmtMMSS(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderBusy(p) {
  $('empty').hidden = true;
  $('card').hidden = false;
  $('caution').hidden = true;

  const existing = document.getElementById('busyBox');
  const box = existing || document.createElement('div');
  box.id = 'busyBox';
  box.className = 'busy';

  if (p.phase === 'tick' || p.phase === 'wait') {
    box.innerHTML = `<span class="spin"></span>模型繁忙 · 第 ${p.round || 1} 次等待 · `
      + `<b>${fmtMMSS(p.secondsLeft)}</b> 后自动重试`;
  } else if (p.phase === 'retry') {
    box.innerHTML = `<span class="spin"></span>正在重试第 ${p.round || 1} 次…`;
  }

  if (!existing) $('card').appendChild(box);
  setDot('wait');
  $('src').textContent = '等待模型额度';
  $('lat').textContent = '';
}

/** 卡片切换时清掉遗留的忙碌提示 */
function clearBusy() {
  const box = document.getElementById('busyBox');
  if (box) box.remove();
}

window.copilot.onCard((payload) => {
  if (!payload) return;
  if (payload.type === 'card') { clearBusy(); renderCard(payload.card, payload.question, payload.from); }
  else if (payload.type === 'error') { clearBusy(); renderError(payload); }
  else if (payload.type === 'busy') renderBusy(payload);
  else if (payload.type === 'status') {
    setDot('live');
    $('src').textContent = payload.text;
  }
});

// 双指/滚轮调节字号（穿透模式下不可达，属预期）
document.addEventListener('keydown', (e) => {
  const ul = $('points');
  let size = parseFloat(getComputedStyle(ul.querySelector('li') || ul).fontSize || 21);
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) size += 1;
  else if (e.ctrlKey && e.key === '-') size -= 1;
  else return;
  ul.style.fontSize = size + 'px';
  document.querySelectorAll('.points li').forEach((li) => { li.style.fontSize = size + 'px'; });
});
