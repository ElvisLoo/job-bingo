'use strict';
/**
 * 启动打包后的 exe，存活一段时间后确认进程仍在。
 * 目的：抓「asar 打包后才暴露」的问题（缺文件、软链失效、asar 内路径解析）。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const exe = path.join(__dirname, '..', '..', 'dist', 'win-unpacked', '面必过.exe');
if (!fs.existsSync(exe)) { console.log('未找到 exe:', exe); process.exit(1); }

const p = spawn(exe, [], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
p.stdout.on('data', (d) => { out += d.toString(); });
p.stderr.on('data', (d) => { out += d.toString(); });

let exited = null;
p.on('exit', (c) => { exited = c; });

setTimeout(() => {
  if (exited !== null) {
    console.log('✗ 进程已退出, code=' + exited);
    console.log(out.slice(-1200));
    process.exit(1);
  }
  console.log('✓ 打包产物运行 8 秒未退出');
  const keys = ['已启动', 'WS 端口', 'shortcut'];
  for (const k of keys) console.log(`  ${out.includes(k) ? '✓' : '·'} 日志含 "${k}"`);
  const fatal = out.match(/FATAL|Uncaught|uncaughtException/);
  console.log(fatal ? '✗ 日志出现致命错误: ' + fatal[0] : '✓ 未出现致命错误');
  try { p.kill(); } catch (_) {}
  setTimeout(() => process.exit(fatal ? 1 : 0), 600);
}, 8000);
