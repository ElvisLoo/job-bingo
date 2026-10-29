'use strict';
/** 快照启动器：清掉宿主注入的 ELECTRON_RUN_AS_NODE 再拉起 snapshot.js */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronBin = require('electron');
const entry = path.resolve(__dirname, 'snapshot.js');
const logPath = path.resolve(__dirname, '..', '..', 'snapshot.log');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.OUT) env.OUT = process.env.OUT;

const fd = fs.openSync(logPath, 'a');
const child = spawn(electronBin, [entry], { stdio: ['ignore', fd, fd], env, windowsHide: true });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
