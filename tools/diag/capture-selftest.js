'use strict';
/** 回环自检：开始采集 → 播放 3 段测试音 → 看 VAD 是否切出语音段 */
const WebSocket = require('ws');
const PORT = 8787;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const finish = (c) => { try { ws.close(); } catch (_) {} process.exit(c); };
let started = false, queried = false;
ws.on('open', () => ws.send(JSON.stringify({ type: 'capture', action: 'start' })));
ws.on('message', (b) => {
  const m = JSON.parse(b.toString());
  if (m.type === 'capture' && m.ok && !started) {
    started = true;
    setTimeout(() => {
      console.log('播放 3 段测试音…');
      ws.send(JSON.stringify({ type: 'selftest' }));
      setTimeout(() => { queried = true; ws.send(JSON.stringify({ type: 'capture:status' })); }, 8000);
    }, 1500);
  } else if (m.type === 'capture' && m.status && queried) {
    console.log('最终状态:', JSON.stringify(m.status));
    if (m.status.segs >= 2) console.log(`PASS · 回环听到系统声音，切出 ${m.status.segs} 段语音`);
    else console.log(`WARN · 未切出语音段（frames=${m.status.frames}，可能系统静音或无输出设备）`);
    finish(0);
  }
});
ws.on('error', (e) => { console.error('FAIL', e.message); finish(1); });
setTimeout(() => { console.error('超时'); finish(1); }, 45000);
