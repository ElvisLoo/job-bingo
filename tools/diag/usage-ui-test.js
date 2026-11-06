'use strict';
/**
 * 用量面板的离线 UI 自检。
 *
 * 为什么不启动整个 Electron：
 *   settings.html 只是静态页 + preload 桥，UI 正确性不依赖主进程。
 *   注入一个假 window.copilot 就能把「有数据 / 无数据 / 未知单价」三种状态都跑出来，
 *   比每次点托盘快得多，也不受采集授权弹窗干扰。
 *
 * 用法：node tools/diag/usage-ui-test.js
 * 产物：ui-usage.png / ui-usage-empty.png
 */
const { chromium } = require('playwright-core');
const path = require('path');

const SETTINGS = path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer', 'settings.html');

/** 注入假桥：返回给定 usage */
function fakeCopilot(usage) {
  const base = {
    pipelineStatus: () => Promise.resolve({
      running: false,
      stats: { ingested: 12, droppedDup: 3, droppedShort: 1, generated: 8 },
      usage,
    }),
    getConfig: () => Promise.resolve({}),
    reviewCount: () => Promise.resolve({ count: 5 }),
    sessionCurrent: () => Promise.resolve({ id: null, entries: 0 }),
    sessionList: () => Promise.resolve({ sessions: [] }),
    captureStatus: () => Promise.resolve({ active: false }),
    setUsagePricing: () => Promise.resolve({ ok: true, count: 1 }),
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : () => Promise.resolve({})),
  });
}

async function shoot(browser, usage, out) {
  const p = await browser.newPage({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
  await p.addInitScript(`window.copilot = (${fakeCopilot.toString()})(${JSON.stringify(usage)});`);
  await p.goto('file:///' + SETTINGS.split(path.sep).join('/'), { waitUntil: 'load' });
  await p.waitForTimeout(900);

  const r = await p.evaluate(() => {
    const g = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
    const bar = document.getElementById('usageBar');
    return {
      hasSection: !!document.getElementById('s-usage'),
      calls: g('usageCalls'),
      inTok: g('usageIn'),
      outTok: g('usageOut'),
      cost: g('usageCost'),
      detail: g('usageDetail'),
      note: g('usageNote'),
      barHidden: bar ? bar.hidden : null,
      barWidth: bar && bar.firstElementChild ? bar.firstElementChild.style.width : null,
    };
  });

  await p.locator('#s-usage').screenshot({ path: out });
  await p.close();
  return r;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

  const withData = await shoot(browser, {
    calls: 23, prompt: 18400, completion: 3100, cached: 11200,
    costMilli: 42, unknownCalls: 0, byModel: {},
    text: '23 次调用 · 18.4k 输入（缓存 61%）· 3.1k 输出 · ¥0.042',
  }, 'ui-usage.png');

  const empty = await shoot(browser, {
    calls: 0, prompt: 0, completion: 0, cached: 0,
    costMilli: 0, unknownCalls: 0, byModel: {}, text: '0 次调用 · ¥0',
  }, 'ui-usage-empty.png');

  const unknown = await shoot(browser, {
    calls: 3, prompt: 2400, completion: 400, cached: 0,
    costMilli: 0, unknownCalls: 3, byModel: { 'my-llm': { calls: 3 } },
    text: '3 次调用 · 2.4k 输入 · 400 输出 · ¥0（my-llm 未收录单价，未计入金额）',
  }, 'ui-usage-unknown.png');

  console.log('--- 有数据 ---');
  console.log(JSON.stringify(withData, null, 2));
  console.log('--- 空数据 ---');
  console.log(JSON.stringify(empty, null, 2));
  console.log('--- 未知单价 ---');
  console.log(JSON.stringify(unknown, null, 2));

  await browser.close();
})();
