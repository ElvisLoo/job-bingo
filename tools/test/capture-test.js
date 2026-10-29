'use strict';
/**
 * 回环采集冒烟：通过 WS 让应用开启采集，观察帧数、语音段与错误。
 * 需要先运行桌面应用。无系统声音播放时帧数仍会增长（静音也是帧），
 * 有语音段则证明 VAD 抓到了真实语音。
 */
const WebSocket = require('ws');
const net = require('node:net');

const PORT = Number(process.env.PORT || 8787);
const OBSERVE_MS = Number(process.env.OBSERVE_MS || 12000);

function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

(async () => {
  // 不预先探测端口：Windows 上 0.0.0.0 监听会干扰探测结果，直接连更可靠
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const done = (code) => { try { ws.close(); } catch (_) {} process.exit(code); };

  ws.on('open', () => {
    console.log('connected → 请求开始采集');
    ws.send(JSON.stringify({ type: 'capture', action: 'start' }));
  });

  let started = false;
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type === 'capture' && m.ok && !started) {
      started = true;
      console.log('采集已启动，观察', OBSERVE_MS / 1000, '秒…');
      setTimeout(() => ws.send(JSON.stringify({ type: 'capture:status' })), OBSERVE_MS);
    } else if (m.type === 'capture' && m.status) {
      const s = m.status;
      console.log('--- 采集状态 ---');
      console.log(JSON.stringify(s, null, 1));
      if (!s.active) { console.log('FAIL · 采集未处于活动状态'); done(1); }
      if (s.lastError) { console.log('FAIL · 采集报错：', s.lastError); done(1); }
      if (s.frames === 0) { console.log('WARN · 未收到 PCM 帧（可能无音频输出设备或未授权）'); done(0); }
      console.log(`PASS · 收到 ${s.frames} 帧 PCM${s.sampleRate ? ' @' + s.sampleRate + 'Hz' : ''}，语音段 ${s.segs}`);
      done(0);
    }
  });
  ws.on('error', (e) => {
    if (/ECONNREFUSED/.test(e.message)) {
      console.log(`SKIP · 端口 ${PORT} 连不上，应用未运行（先 node tools/start.js）`);
      process.exit(0);
    }
    console.error('FAIL', e.message); done(1);
  });
  setTimeout(() => { console.error('FAIL · 20 秒无响应'); done(1); }, 20000 + OBSERVE_MS);
})();
