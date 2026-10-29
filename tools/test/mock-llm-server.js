'use strict';
/**
 * 假模型服务（OpenAI 兼容）。
 * 既可直接 `node tools/mock-llm-server.js` 独立运行，也可被测试内部 require 复用。
 *
 * 行为：第 1 次返回「成稿卡」（带句号 + 连接词），之后返回合规卡 ——
 * 用来证明校验器会拦截成稿并触发重试。
 */
const http = require('http');

const BAD = {
  anchor: { resumeId: 'proj:0', label: '项目 ERP 成本分析' },
  points: [
    { kind: 'fact', text: '我通过 INVQ01 定位到了这笔异常。' },
    { kind: 'path', text: '首先我看了库存表，其次我重算了成本' },
  ],
  caution: null,
};
const GOOD = {
  anchor: { resumeId: 'proj:0', label: '项目 ERP 成本分析' },
  points: [
    { kind: 'fact', text: '库存 1000 pcs / 余额 -3994.58' },
    { kind: 'path', text: 'INVQ01 流水 → INV102 重算' },
    { kind: 'key', text: '出入库异动类型 + 暂估凭证' },
    { kind: 'close', text: '落到单据层，不是调总数' },
  ],
  caution: '别急着说改好了，先讲怎么定位',
};

/** @returns {Promise<{server: import('http').Server, port: number, state: object}>} */
function createMockServer() {
  const state = { n: 0, log: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!/chat\/completions/.test(req.url)) { res.writeHead(404).end(); return; }
      state.n++;
      const useGood = state.n > 1;
      state.log.push(useGood ? 'good' : 'bad');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock',
        choices: [{ message: { role: 'assistant', content: JSON.stringify(useGood ? GOOD : BAD) } }],
        usage: { prompt_tokens: 1200, completion_tokens: 80 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// 独立运行入口
if (require.main === module) {
  const PORT = Number(process.env.PORT || 8899);
  let n = 0;
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!/chat\/completions/.test(req.url)) { res.writeHead(404).end(); return; }
      n++;
      const useGood = n > 1;
      console.log(`[mock-llm] 第 ${n} 次请求 → 返回${useGood ? '合规卡' : '成稿卡（应被拦截）'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock',
        choices: [{ message: { role: 'assistant', content: JSON.stringify(useGood ? GOOD : BAD) } }],
      }));
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] http://127.0.0.1:${PORT}/v1`));
}

module.exports = { createMockServer, BAD, GOOD };
