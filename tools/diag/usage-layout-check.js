const { chromium } = require('playwright-core');
const path = require('path');
const SETTINGS = path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer', 'settings.html');

(async () => {
  const b = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 960, height: 900 } });
  await p.addInitScript(() => {
    window.copilot = new Proxy({
      pipelineStatus: () => Promise.resolve({
        running: false, stats: {},
        usage: { calls: 23, prompt: 18400, completion: 3100, cached: 11200,
                 costMilli: 42, unknownCalls: 0, byModel: {},
                 text: '23 次调用 · 18.4k 输入（缓存 61%）· 3.1k 输出 · ¥0.042' }
      }),
      getConfig: () => Promise.resolve({}),
      reviewCount: () => Promise.resolve({ count: 0 }),
      sessionCurrent: () => Promise.resolve({ id: null }),
      sessionList: () => Promise.resolve({ sessions: [] }),
      captureStatus: () => Promise.resolve({ active: false }),
    }, { get: (t, k) => (k in t ? t[k] : () => Promise.resolve({})) });
  });
  await p.goto('file:///' + SETTINGS.split(path.sep).join('/'), { waitUntil: 'load' });
  await p.waitForTimeout(900);

  const r = await p.evaluate(() => {
    const card = document.getElementById('s-usage').getBoundingClientRect();
    const grid = document.querySelector('.usage-grid').getBoundingClientRect();
    const barEl = document.getElementById('usageBar');
    const bar = barEl.getBoundingClientRect();
    const detail = document.getElementById('usageDetail').getBoundingClientRect();
    const actions = document.querySelector('#s-usage .usage-actions').getBoundingClientRect();
    const note = document.getElementById('usageNote').getBoundingClientRect();
    return {
      cardW: Math.round(card.width),
      gridGapToBar: Math.round(bar.top - grid.bottom),
      barGapToNote: Math.round(note.top - bar.bottom),
      detailOwnRow: detail.top >= note.bottom - 1,
      detailW: Math.round(detail.width),
      detailRightGap: Math.round(card.right - detail.right),
      actionsTop: Math.round(actions.top - detail.bottom),
      actionsLeft: Math.round(actions.left - card.left),
      actionsAlignsLeft: Math.abs(actions.left - grid.left) < 2,
      barEmpty: barEl.classList.contains('empty'),
      barH: Math.round(bar.height),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  console.log(JSON.stringify(r, null, 2));
  await b.close();
})();
