const { chromium } = require('playwright-core');
const path = require('path');
const SETTINGS = path.resolve(__dirname, '..', '..', 'packages', 'desktop', 'src', 'renderer', 'settings.html');

async function h(browser, usage) {
  const p = await browser.newPage({ viewport: { width: 960, height: 900 } });
  await p.addInitScript(`window.copilot = new Proxy({
    pipelineStatus: () => Promise.resolve({ running:false, stats:{}, usage: ${JSON.stringify(usage)} }),
    getConfig: () => Promise.resolve({}), reviewCount: () => Promise.resolve({count:0}),
    sessionCurrent: () => Promise.resolve({id:null}), sessionList: () => Promise.resolve({sessions:[]}),
    captureStatus: () => Promise.resolve({active:false}),
  }, { get: (t,k) => (k in t ? t[k] : () => Promise.resolve({})) });`);
  await p.goto('file:///' + SETTINGS.split(path.sep).join('/'), { waitUntil: 'load' });
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const c = document.getElementById('s-usage').getBoundingClientRect();
    const bar = document.getElementById('usageBar');
    return { h: Math.round(c.height), empty: bar.classList.contains('empty'), barH: Math.round(bar.getBoundingClientRect().height) };
  });
  await p.close();
  return r;
}

(async () => {
  const b = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const full = await h(b, { calls:23, prompt:18400, completion:3100, cached:11200, costMilli:42, unknownCalls:0, byModel:{}, text:'23 次调用 · 18.4k 输入（缓存 61%）· 3.1k 输出 · ¥0.042' });
  const empty = await h(b, { calls:0, prompt:0, completion:0, cached:0, costMilli:0, unknownCalls:0, byModel:{}, text:'0 次调用 · ¥0' });
  const unk = await h(b, { calls:3, prompt:2400, completion:400, cached:0, costMilli:0, unknownCalls:3, byModel:{'my-llm':{calls:3}}, text:'3 次调用 · 2.4k 输入 · 400 输出 · ¥0（my-llm 未收录单价，未计入金额）' });
  console.log('有数据:', JSON.stringify(full));
  console.log('空数据:', JSON.stringify(empty));
  console.log('未知  :', JSON.stringify(unk));
  console.log('高度一致:', full.h === empty.h && empty.h === unk.h);
  await b.close();
})();
