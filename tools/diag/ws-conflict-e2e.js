'use strict';
/**
 * 实机验证：WS 端口被占用时不再静默失败。
 *
 * 做法：先占住 18765 端口，再用这个端口启动 Electron（--ws-port 走 env），
 * 观察主进程是否推送了错误提示卡而不是自己崩掉。
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 18765;
const root = path.join(__dirname, '..', '..');
const electron = require(path.join(root, 'node_modules', 'electron'));

// 1) 先占住端口
const blocker = net.createServer();
blocker.listen(PORT, '0.0.0.0', () => {
  console.log(`已占住端口 ${PORT}`);

  const profile = path.join(os.tmpdir(), 'job-bingo-wsconflict-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const probe = path.join(root, 'tools', 'diag', '_wsc-probe.js');
  fs.writeFileSync(probe, [
    "const { app } = require('electron');",
    "const path = require('path');",
    `app.setPath('userData', ${JSON.stringify(profile)});`,
    'app.whenReady().then(() => {',
    `  require(path.join(${JSON.stringify(root)}, 'packages', 'desktop', 'src', 'main', 'index.js'));`,
    '  setTimeout(() => {',
    "    console.log('PROBE_ALIVE=1');",
    '    app.exit(0);',
    '  }, 4000);',
    '}).catch(e => { console.log("PROBE_ERR=" + e.message); app.exit(1); });',
  ].join('\n'), 'utf8');

  const env = { ...process.env, JOBBINGO_WS_PORT: String(PORT) };
  const p = spawn(electron, [probe], { cwd: root, env });

  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { out += d.toString(); });

  p.on('exit', (code) => {
    try { fs.unlinkSync(probe); } catch (_) {}
    blocker.close();

    const alive = out.includes('PROBE_ALIVE=1');
    const sawConflict = /EADDRINUSE|被占用/.test(out);

    console.log('进程存活至超时:', alive ? '是' : '否');
    console.log('检测到端口冲突:', sawConflict ? '是' : '否');
    if (!alive) console.log(out.slice(-800));

    process.exit(alive && sawConflict ? 0 : 1);
  });
});
