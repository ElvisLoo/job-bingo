'use strict';
/**
 * 真实启动 Electron，核对热键注册结果是否被正确捕获。
 *
 * 静态测试只能证明「代码里检查了返回值」，不能证明 Electron 里真的
 * 会返回 false、以及 UI 拿到的是不是想要的结构。这里跑一次真进程。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..', '..');
const electron = require(path.join(root, 'node_modules', 'electron'));

const probe = path.join(root, 'tools', 'diag', '_sc-probe.js');
fs.writeFileSync(probe, `
const { app } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const main = require(path.join(${JSON.stringify(root)}, 'packages', 'desktop', 'src', 'main', 'index.js'));
  setTimeout(() => {
    const { globalShortcut } = require('electron');
    const fails = ['Ctrl+Alt+H','Ctrl+Alt+M','Ctrl+Alt+K','Ctrl+Alt+Up','Ctrl+Alt+Down']
      .filter(a => !globalShortcut.isRegistered(a));
    console.log('PROBE_FAILED=' + JSON.stringify(fails));
    app.exit(0);
  }, 2500);
}).catch(e => { console.log('PROBE_ERR=' + e.message); app.exit(1); });
`, 'utf8');

const env = { ...process.env, JOBBINGO_DIAG: '1' };
const p = spawn(electron, [probe], { cwd: root, env });

let out = '';
p.stdout.on('data', d => { out += d.toString(); });
p.stderr.on('data', d => { out += d.toString(); });

p.on('exit', (code) => {
  try { fs.unlinkSync(probe); } catch (_) {}
  const m = out.match(/PROBE_FAILED=(\[.*?\])/);
  const err = out.match(/PROBE_ERR=(.*)/);
  if (err) { console.log('启动失败:', err[1]); process.exit(1); }
  if (!m) { console.log('未拿到探针结果, code=' + code); console.log(out.slice(-800)); process.exit(1); }
  const failed = JSON.parse(m[1]);
  console.log('未注册成功的热键:', failed.length ? failed.join(', ') : '无（全部正常）');
  console.log(failed.length <= 5 ? '结论：注册结果可被准确感知' : '结论：异常');
  process.exit(0);
});
