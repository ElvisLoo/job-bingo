// ---------- 用量与花费（本场） ----------
function fmtTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 厘 -> 元，与 core/usage.formatMoney 分级一致 */
function fmtCost(milli) {
  const yuan = (Number(milli) || 0) / 1000;
  if (yuan === 0) return '¥0';
  if (yuan >= 0.1) return '¥' + yuan.toFixed(2);
  if (yuan >= 0.001) return '¥' + yuan.toFixed(3);
  return '¥' + yuan.toFixed(4);
}

async function refreshUsage() {
  try {
    const s = await window.copilot.pipelineStatus();
    const u = s && s.usage;
    if (!u) {
      const note = $('usageNote');
      if (note) note.textContent = '用量统计暂不可用';
      return;
    }

    $('usageCalls').textContent = String(u.calls || 0);
    $('usageIn').textContent = fmtTokens(u.prompt);
    $('usageOut').textContent = fmtTokens(u.completion);
    $('usageCost').textContent = fmtCost(u.costMilli);

    const bar = $('usageBar');
    bar.hidden = false;   // 始终占位，避免卡片高度在状态间跳动
    if (u.prompt > 0) {
      const rate = Math.min(100, Math.round((u.cached / u.prompt) * 100));
      bar.classList.remove('empty');
      bar.innerHTML = '<i style="width:' + rate + '%"></i>';
      bar.title = rate > 0
        ? '输入中 ' + rate + '% 命中缓存，缓存价通常更低'
        : '本次未命中缓存';
    } else {
      bar.classList.add('empty');
      bar.innerHTML = '';
      bar.title = '还没有调用记录';
    }

    $('usageDetail').textContent = u.text || '';

    if (u.unknownCalls > 0) {
      $('usageNote').textContent = '有 ' + u.unknownCalls +
        ' 次调用用了未收录单价的模型，只统计 token 不估算金额，避免给你编出来的数字。可点「自定义单价」补上。';
    }
  } catch (_) { /* 主进程忙时静默 */ }
}

setInterval(refreshUsage, 2000);
refreshUsage();

if ($('usageRefresh')) $('usageRefresh').onclick = refreshUsage;

if ($('usagePricing')) {
  $('usagePricing').onclick = () => {
    const cur = $('usagePricing').dataset.custom || '';
    const tip = [
      '自定义单价（元 / 每百万 token）',
      '格式：模型名,输入价,缓存价,输出价',
      '多个模型用分号隔开',
      '例：my-llm,2,0.5,8',
    ].join('\n');
    const input = window.prompt(tip, cur);
    if (input == null) return;

    const overrides = {};
    for (const line of String(input).split(/[;\n]+/)) {
      const parts = line.split(',').map((x) => x.trim());
      if (parts.length < 4 || !parts[0]) continue;
      overrides[parts[0]] = {
        in: Number(parts[1]) || 0,
        cacheHit: Number(parts[2]) || 0,
        out: Number(parts[3]) || 0,
      };
    }
    $('usagePricing').dataset.custom = input;

    if (window.copilot.setUsagePricing) {
      window.copilot.setUsagePricing(overrides).then(() => {
        $('usageNote').textContent = '已保存 ' + Object.keys(overrides).length + ' 个模型的自定义单价';
        refreshUsage();
      }).catch(() => { $('usageNote').textContent = '保存失败'; });
    }
  };
}
