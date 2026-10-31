'use strict';
/**
 * 端口冲突实机验证：输出全部落盘，不依赖 stdout 管道。
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG = path.join(os.tmpdir(), 'wsc-result.txt');
const lines = [];
function log(s) { lines.push(String(s)); try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (_) {} }

const PORT = 18765;
const root = path.join(__dirname, '..', '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const profile = path.join(os.tmpdir(), 'jb-wsc-' + Date.now());
fs.mkdirSync(profile, { recursive: true });

const probe = path.join(root, 'tools', 'diag', '_wsc.js');
fs.writeFileSync(probe, [
  "const { app } = require('electron');",
  "const path = require('path');",
  "const fs = require('fs');",
  `app.setPath('userData', ${JSON.stringify(profile)});`,
  'process.on("uncaughtException", e => process.stdout.write("UNCAUGHT=" + e.message + "\\n"));',
  'app.whenReady().then(() => {',
  `  require(path.join(${JSON.stringify(root)}, 'packages', 'desktop', 'src', 'main', 'index.js'));`,
  '  setTimeout(() => { process.stdout.write("PROBE_ALIVE=1\\n"); app.exit(0); }, 4000);',
  '}).catch(e => { process.stdout.write("PROBE_ERR=" + e.message + "\\n"); app.exit(1); });',
].join('\n'), 'utf8');

const blocker = net.createServer();
blocker.on('error', (e) => { log('blocker error: ' + e.message); blocker.close(); });

blocker.listen(PORT, '0.0.0.0', () => {
  log('blocker listening on ' + PORT);

  const p = spawn(electron, [probe], {
    cwd: root,
    env: { ...process.env, JOBBINGO_WS_PORT: String(PORT) },
  });

  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { out += d.toString(); });

  const kill = setTimeout(() => { try { p.kill(); } catch (_) {} }, 30000);

  p.on('exit', (code) => {
    clearTimeout(kill);
    try { fs.unlinkSync(probe); } catch (_) {}
    try { blocker.close(); } catch (_) {}
    log('--- child exit code: ' + code + ' ---');
    log('--- output ---');
    log(out.slice(-2000));
    log('alive: ' + out.includes('PROBE_ALIVE=1'));
    log('conflict detected: ' + /EADDRINUSE|被占用/.test(out));
    process.exit(0);
  });
});
