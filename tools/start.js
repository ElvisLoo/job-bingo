'use strict';
/**
 * 启动器：显式清除宿主注入的 ELECTRON_RUN_AS_NODE。
 * 不清除的话 Electron 会退化成纯 Node 运行，require('electron') 只返回路径字符串。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronBin = require('electron');
const entry = path.resolve(__dirname, '..', 'packages', 'desktop', 'src', 'main', 'index.js');
const logPath = path.resolve(__dirname, '..', 'electron.log');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const fd = fs.openSync(logPath, 'a');
fs.writeSync(fd, `\n===== ${new Date().toISOString()} 启动 =====\n`);

const child = spawn(electronBin, [entry], { stdio: ['ignore', fd, fd], env, windowsHide: false });
child.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) console.error(`[面必过] 退出码 ${code}${signal ? ' 信号 ' + signal : ''}`);
  process.exit(code === null ? 1 : code);
});
