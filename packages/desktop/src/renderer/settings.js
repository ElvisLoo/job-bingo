'use strict';
const $ = (id) => document.getElementById(id);

async function load() {
  const { config, hasResume } = await window.copilot.getConfig();
  $('baseUrl').value = config.llm.baseUrl || '';
  $('model').value = config.llm.model || '';
  $('apiKey').value = config.llm.apiKey || '';
  $('jd').value = config.jd || '';
  $('opacity').value = Math.round((config.overlay.opacity ?? 0.94) * 100);
  $('opVal').textContent = `${Math.round((config.overlay.opacity ?? 0.94) * 100)}%`;
  $('through').checked = !!config.overlay.through;
  $('taskbar').checked = !!config.overlay.taskbar;
  $('solid').checked = !!config.overlay.solid;
  $('taskbarNote').textContent = `当前：${config.overlay.taskbar ? '在任务栏显示' : '不在任务栏显示'}${config.overlay.solid ? ' · 兼容模式' : ''}`;
  $('retryMin').value = config.busy?.retryMinutes ?? 5;
  $('maxMin').value = config.busy?.maxWaitMinutes ?? 60;
  $('resumeNote').textContent = hasResume ? '已导入（锚点可校验）' : '未导入';
  $('saveNote').textContent = config.llm.apiKey ? '已配置 Key' : '未配置 Key · 演示模式';
}

$('save').onclick = async () => {
  await window.copilot.setConfig({
    llm: { baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim(), apiKey: $('apiKey').value.trim() },
    jd: $('jd').value,
  });
  $('saveNote').textContent = $('apiKey').value.trim() ? '已保存 · Key 已配置' : '已保存 · 演示模式';
};

$('warmup').onclick = async () => {
  $('saveNote').textContent = '预热中…';
  await window.copilot.warmup();
  $('saveNote').textContent = '预热完成（首题更快）';
};

$('importResume').onclick = async () => {
  const r = await window.copilot.loadResume();
  if (r.canceled) return;
  if (!r.ok) { $('resumeNote').textContent = '导入失败：' + (r.error || '格式不符'); return; }
  $('resumeNote').textContent = `已导入 · ${r.anchors} 个锚点 · ${r.numbers} 个可用数字`;
};

$('askBtn').onclick = async () => {
  const q = $('askInput').value.trim();
  if (!q) { $('askNote').textContent = '先输入问题'; return; }
  $('askNote').textContent = '生成中…';
  const r = await window.copilot.ask(q);
  if (!r.ok) {
    $('askNote').textContent = r.error ? '失败：' + r.error : '校验未通过（详见浮窗）';
    if (r.errors) showPreview(null, r.errors);
    return;
  }
  $('askNote').textContent = r.mocked ? '演示模式（未配置 Key）' : `完成 · 尝试 ${r.attempts} 次`;
  showPreview(r.card, null);
};

$('askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('askBtn').click(); });

$('mock').onclick = async () => {
  const r = await window.copilot.mock($('askInput').value.trim() || '介绍一下你自己');
  showPreview(r.card, null);
};

function showPreview(card, errors) {
  const p = $('preview');
  p.hidden = false;
  if (!card) {
    p.className = 'preview err';
    // 不能用 innerHTML 拼 reason：它来自模型原始输出，
    // 未转义就等于把模型/代理返回的字符串当 HTML 执行。
    const head = document.createElement('div');
    head.className = 'anchor';
    head.textContent = '生成失败 · 校验器拦截';
    const pre = document.createElement('pre');
    pre.textContent = (errors || []).map((e) => "· " + ((e && e.reason) || "未知原因")).join(String.fromCharCode(10));
    p.replaceChildren(head, pre);
    return;
  }
  p.className = 'preview';
  p.innerHTML = `
    <div class="anchor">锚点：${escapeHtml(card.anchor?.label || '—')}</div>
    <ul>${(card.points || []).map((x) => `<li>${escapeHtml(x.text)}</li>`).join('')}</ul>
    ${card.caution ? `<div class="caution">⚠ ${escapeHtml(card.caution)}</div>` : ''}
    <div class="meta">${escapeHtml(card.meta?.model || '')} · 尝试 ${card.meta?.attempt || 1} 次 · 锚点库 ${card.meta?.anchorCount ?? 0} 条</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('opacity').oninput = async () => {
  $('opVal').textContent = `${$('opacity').value}%`;
  await window.copilot.setConfig({ overlay: { opacity: Number($('opacity').value) / 100 } });
};
$('through').onchange = async () => { await window.copilot.setThrough($('through').checked); };
$('taskbar').onchange = async () => {
  await window.copilot.setTaskbar($('taskbar').checked);
  $('taskbarNote').textContent = `当前：${$('taskbar').checked ? '在任务栏显示' : '不在任务栏显示'}${$('solid').checked ? ' · 兼容模式' : ''}`;
};
$('solid').onchange = async () => {
  await window.copilot.setSolid($('solid').checked);
  $('taskbarNote').textContent = `当前：${$('taskbar').checked ? '在任务栏显示' : '不在任务栏显示'}${$('solid').checked ? ' · 兼容模式' : ''}`;
};
$('toggle').onclick = async () => { await window.copilot.hide(); };
$('mockRun').onclick = async () => {
  await window.copilot.pipelineStart('mock');
  $('askNote').textContent = '模拟采集中 · 每 9 秒自动出一张卡';
};
$('mockStop').onclick = async () => {
  await window.copilot.pipelineStop();
  $('askNote').textContent = '已停止采集';
};

$('demoWav').onclick = async () => {
  $('asrNote').textContent = '识别中…';
  const r = await window.copilot.asrDemoWav();
  if (r.ok) $('asrNote').textContent = `切出 ${r.segments} 段语音，已出 ${(r.results || []).length} 张卡`;
  else $('asrNote').textContent = '失败：' + (r.error || '未知');
};

$('feedWav').onclick = async () => {
  $('asrNote').textContent = '识别中…';
  const r = await window.copilot.asrFeedWav();
  if (r.canceled) { $('asrNote').textContent = '已取消'; return; }
  if (r.ok) $('asrNote').textContent = `切出 ${r.segments} 段语音，已出 ${(r.results || []).length} 张卡`;
  else $('asrNote').textContent = '失败：' + (r.error || '未知');
};

(async () => {
  const s = await window.copilot.asrStatus();
  $('asrNote').textContent = s.available ? 'ASR 层：已加载（VAD + 转写可用）' : 'ASR 层：未加载';
})();

$('capStart').onclick = async () => {
  await window.copilot.captureStart();
  $('capNote').textContent = '已启动采集，等待语音…';
};
$('capStop').onclick = async () => {
  await window.copilot.captureStop();
  $('capNote').textContent = '已停止';
};
setInterval(async () => {
  try {
    const s = await window.copilot.captureStatus();
    if (s.active) {
      $('capNote').textContent = `采集中 · 帧 ${s.frames} · 语音段 ${s.segs}${s.sampleRate ? ' · ' + s.sampleRate + 'Hz' : ''}${s.lastError ? ' · 错误：' + s.lastError : ''}`;
    }
  } catch (_) { /* 主进程忙时静默 */ }
}, 2000);

window.copilot.onCard((payload) => {
  if (payload && payload.type === 'card') showPreview(payload.card, null);
});

$('pReset').onclick = async () => { await window.copilot.pipelineReset(); refreshStats(); };

async function refreshStats() {
  try {
    const s = await window.copilot.pipelineStatus();
    $('pIngest').textContent = `收到 ${s.stats.ingested}`;
    $('pDup').textContent = `去重跳过 ${s.stats.droppedDup + s.stats.droppedShort}`;
    $('pGen').textContent = `出卡 ${s.stats.generated}`;
  } catch (e) { /* 主进程未就绪时静默 */ }
}
setInterval(refreshStats, 1500);
refreshStats();

$('retryMin').onchange = $('maxMin').onchange = async () => {
  await window.copilot.setConfig({
    busy: {
      retryMinutes: Math.min(60, Math.max(1, Number($('retryMin').value) || 5)),
      maxWaitMinutes: Math.min(600, Math.max(1, Number($('maxMin').value) || 60)),
    },
  });
};

$('busyStop').onclick = async () => {
  const r = await window.copilot.busyCancel();
  $('busyNote').textContent = r.ok ? '已请求停止' : '当前不在等待中';
};

load();

// ---------- 复盘 ----------
async function refreshReviewCount() {
  try {
    const r = await window.copilot.reviewCount();
    if (r && typeof r.count === 'number') {
      $('reviewNote').textContent = r.count ? `已记录 ${r.count} 条，可复盘` : '尚未记录';
    }
  } catch (_) { /* 主进程未就绪时静默 */ }
}

$('reviewRun').onclick = async () => {
  $('reviewNote').textContent = '生成中…';
  $('reviewOut').hidden = true;
  try {
    const r = await window.copilot.reviewGenerate();
    if (!r.ok) { $('reviewNote').textContent = r.error || '复盘失败'; return; }
    $('reviewOut').textContent = r.markdown || '';
    $('reviewOut').hidden = false;
    const bits = [];
    if (r.file) bits.push('已保存：' + r.file);
    if (r.saveError) bits.push('保存失败（' + r.saveError + '），可复制上方内容');
    if (r.degraded) bits.push('模型不可用，已用本地规则');
    $('reviewNote').textContent = bits.join(' · ') || '完成';
    refreshReviewCount();
  } catch (e) {
    $('reviewNote').textContent = '复盘异常：' + e.message;
  }
};

$('reviewFolder').onclick = async () => {
  const r = await window.copilot.reviewOpenFolder();
  $('reviewNote').textContent = r.ok ? '已打开：' + r.dir : ('打开失败：' + (r.error || '未知'));
};

$('reviewClear').onclick = async () => {
  await window.copilot.reviewClear();
  $('reviewOut').hidden = true;
  $('reviewNote').textContent = '已清空本场记录';
};

window.copilot.onReviewRequest(() => { if ($('reviewRun')) $('reviewRun').click(); });
setInterval(refreshReviewCount, 3000);
refreshReviewCount();

// ---------- 版本与侧栏状态 ----------
(async () => {
  try {
    const res = await window.copilot.getConfig();
    const cfg = (res && res.config) || res || {};
    const appVer = (res && res.version) || (cfg && cfg.version);
    if (appVer && $('ver')) $('ver').textContent = 'v' + appVer;
    const on = !!(cfg.llm && cfg.llm.apiKey);
    if ($('sideDot')) $('sideDot').className = 'dot' + (on ? ' on' : '');
    if ($('sideStatus')) $('sideStatus').textContent = on ? '已连接模型' : '未配置 Key';
  } catch (_) { /* 主进程未就绪 */ }
})();

// 侧栏高亮跟随滚动
const navItems = Array.from(document.querySelectorAll('.nav-item'));
const sections = navItems.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
const main = document.querySelector('.main');
if (main && sections.length) {
  main.addEventListener('scroll', () => {
    const top = main.scrollTop + 40;
    let idx = 0;
    sections.forEach((sec, i) => { if (sec.offsetTop <= top) idx = i; });
    navItems.forEach((a, i) => a.classList.toggle('active', i === idx));
  }, { passive: true });
}
