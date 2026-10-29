'use strict';
/**
 * 手机端 WS 通道冒烟测试。
 * 需要先运行桌面应用（`node tools/start.js`）；未运行时视作跳过而非失败，
 * 避免在没起 GUI 的环境里产生假失败。
 */
const net = require('node:net');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8787);

/** 端口空闲返回 true（说明应用没在跑） */
function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false)); // EADDRINUSE → 已被应用占用
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

(async () => {
  if (await portIsFree(PORT)) {
    console.log(`SKIP · 端口 ${PORT} 无人监听，桌面应用未运行（先 node tools/start.js）`);
    process.exit(0);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const timer = setTimeout(() => { console.error('FAIL · 8 秒无响应'); process.exit(1); }, 8000);

  ws.on('open', () => {
    console.log('connected');
    ws.send(JSON.stringify({ type: 'ping' }));
  });
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    console.log('recv:', JSON.stringify(msg));
    if (msg.type === 'pong') {
      clearTimeout(timer);
      ws.close();
      console.log('PASS · WS 通道可用');
      process.exit(0);
    }
  });
  ws.on('error', (e) => { clearTimeout(timer); console.error('FAIL', e.message); process.exit(1); });
})();
