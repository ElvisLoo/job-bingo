'use strict';
const $ = (id) => document.getElementById(id);

// 主进程不再回传明文 Key，这里只用 hasLlmKey 表示「有没有配」
let hasKey = false;

async function load() {
  const { config, hasResume, hasLlmKey, credentialsOk, credentialsReason } = await window.copilot.getConfig();
  hasKey = !!hasLlmKey;
  $('baseUrl').value = config.llm.baseUrl || '';
  $('model').value = config.llm.model || '';
  // 不回填明文：留空表示「保持原值」，用户要换就重新输入
  $('apiKey').value = '';
  $('apiKey').placeholder = hasKey ? '已配置（留空则不修改）' : 'sk-...';
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
  if (credentialsOk === false) {
    // 换了机器或系统用户时密文解不开，必须说清楚，否则用户以为 Key 丢了
    $('saveNote').textContent = '凭据读取失败，请重新填写 Key（' + (credentialsReason || '未知原因').slice(0, 60) + '）';
  } else {
    $('saveNote').textContent = hasKey ? '已配置 Key（加密存储）' : '未配置 Key · 演示模式';
  }
}

$('save').onclick = async () => {
  const typed = $('apiKey').value.trim();
  const patch = {
    llm: { baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim() },
    jd: $('jd').value,
  };
  // 只有真的输入了新 Key 才覆盖；留空表示沿用已加密保存的那个
  if (typed) patch.llm.apiKey = typed;
  const r = await window.copilot.setConfig(patch);
  if (typed) hasKey = true;
  $('apiKey').value = '';
  $('apiKey').placeholder = hasKey ? '已配置（留空则不修改）' : 'sk-...';
  $('saveNote').textContent = (r && r.ok === false)
    ? '保存失败：' + (r.error || '未知')
    : (hasKey ? '已保存 · Key 已加密存储' : '已保存 · 演示模式');
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
    if (!r.ok && !r.markdown) { $('reviewNote').textContent = r.error || '复盘失败'; return; }
    // 落盘失败但内容已生成：仍然展示，提示用户自行复制
    if (!r.ok && r.markdown) {
      $('reviewOut').textContent = r.markdown;
      $('reviewOut').hidden = false;
      $('reviewNote').textContent = '已生成但保存失败（' + (r.saveError || '未知') + '），可复制上方内容';
      return;
    }
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
    const on = !!(res && res.hasLlmKey);
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

// ---------- 场次 ----------
let activeSessionId = null;

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

async function refreshSessions() {
  try {
    const cur = await window.copilot.sessionCurrent();
    activeSessionId = cur && cur.id ? cur.id : null;
    if ($('sessCurrent')) {
      $('sessCurrent').innerHTML = activeSessionId
        ? `当前场次 <b>${fmtTime(Date.now())}</b> · 已记录 ${cur.count} 条`
        : '未开始（开始采集后会自动记录）';
    }
    const r = await window.copilot.sessionList();
    const box = $('sessList');
    if (!box) return;
    const list = (r && r.sessions) || [];
    if (!list.length) { box.innerHTML = '<div class="sess-empty">还没有历史场次</div>'; return; }
    box.innerHTML = list.slice(0, 12).map((x) => {
      const active = x.id === activeSessionId ? ' active' : '';
      const tag = x.endedAt ? '已结束' : '进行中';
      return `<div class="sess-item${active}" data-id="${x.id}">
        <span class="when">${fmtTime(x.startedAt)} · ${tag}</span>
        <span class="cnt">${x.entries} 条</span>
        <button class="tiny" data-act="review">复盘</button>
        <button class="tiny" data-act="del">删除</button>
      </div>`;
    }).join('');
  } catch (_) { /* 主进程未就绪 */ }
}

if ($('sessList')) {
  $('sessList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const item = btn.closest('.sess-item');
    const id = item && item.dataset.id;
    if (!id) return;
    if (btn.dataset.act === 'review') {
      $('reviewNote').textContent = '生成中…';
      const r = await window.copilot.reviewGenerate(id);
      if (r && r.markdown) {
        $('reviewOut').textContent = r.markdown;
        $('reviewOut').hidden = false;
        $('reviewNote').textContent = r.file ? '已保存：' + r.file : (r.saveError || '已生成');
      } else {
        $('reviewNote').textContent = (r && (r.error || r.saveError)) || '该场次没有记录';
      }
    } else if (btn.dataset.act === 'del') {
      if (!confirm('删除这一场的记录？不可恢复。')) return;
      const r = await window.copilot.sessionRemove(id);
      $('reviewNote').textContent = r && r.ok ? '已删除' : ('删除失败：' + ((r && r.reason) || '未知'));
      refreshSessions();
    }
  });
}

if ($('sessStart')) {
  $('sessStart').onclick = async () => {
    const r = await window.copilot.sessionStart({ jd: ($('jd') && $('jd').value) || '' });
    $('reviewNote').textContent = r && r.ok ? '已开始新的一场（上一场已归档）' : '开始失败';
    $('reviewOut').hidden = true;
    refreshSessions();
    refreshReviewCount();
  };
}

if ($('sessEnd')) {
  $('sessEnd').onclick = async () => {
    const r = await window.copilot.sessionEnd();
    $('reviewNote').textContent = r && r.ok ? `已结束（${r.entries} 条记录）` : ((r && r.reason) || '没有进行中的场次');
    refreshSessions();
  };
}

setInterval(refreshSessions, 5000);
refreshSessions();
