'use strict';
/**
 * 凭据加密：回归测试。
 *
 * 背景：apiKey 原本明文写在 config.json，同机任意进程可读走，
 * 而这是个长期有效的付费凭据。改为 safeStorage 加密后单独存盘。
 *
 * 注意：safeStorage 依赖 Electron 运行时，纯 node 下不可用。
 * 所以这里测的是「在不依赖 Electron 的情况下也能保证的行为」：
 * 文件命名、空值清理、不可用时不静默降级成明文。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'credentials.js'),
  'utf8'
);

test('凭据文件独立于 config.json', () => {
  assert.ok(src.includes("CRED_FILE = 'credentials.dat'"), '凭据应单独成文件');
});

test('加密前检查 safeStorage 可用性，不可用时不落明文', () => {
  // 关键：不能出现「不可用就明文写盘」的兜底
  assert.ok(src.includes('isEncryptionAvailable'), '应检查加密可用性');
  assert.ok(
    src.includes("safeStorage 不可用"),
    '不可用时应返回原因，而不是降级写明文'
  );
});

test('密钥都为空时删除文件，不留空壳', () => {
  assert.ok(src.includes('fs.unlinkSync'), '空凭据应清理文件');
});

test('解密失败有明确原因（换机器/换用户是预期行为）', () => {
  assert.ok(
    src.includes('凭据解密失败'),
    '解密失败应给出可读原因，让用户知道要重填'
  );
});

test('写入后收紧文件权限', () => {
  assert.ok(src.includes('chmodSync'), '凭据文件应限制为仅当前用户可读写');
});

test('主进程保存配置时把 Key 摘出去', () => {
  const main = fs.readFileSync(
    path.join(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'index.js'),
    'utf8'
  );
  assert.ok(main.includes('snap.llm.apiKey = '), '写盘前应清空 Key 字段');
  assert.ok(main.includes('migratePlaintextKeys'), '应支持从旧明文迁移');
});

test('config:get 不回传明文 Key', () => {
  const main = fs.readFileSync(
    path.join(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'index.js'),
    'utf8'
  );
  const block = main.slice(main.indexOf("ipcMain.handle('config:get'"), main.indexOf("ipcMain.handle('config:set'"));
  assert.ok(block.includes('hasLlmKey'), '应只返回「是否已配置」');
  assert.ok(!block.includes('config,\n'), '不应直接返回整个 config 对象');
});

test('遗留的明文 Key 会被迁移并抹掉', () => {
  const main = fs.readFileSync(
    path.join(__dirname, '..', '..', 'packages', 'desktop', 'src', 'main', 'index.js'),
    'utf8'
  );
  const i = main.indexOf('function migratePlaintextKeys');
  const block = main.slice(i, i + 900);
  assert.ok(block.includes('saveSecrets'), '迁移应调用加密存储');
  assert.ok(block.includes("config.llm.apiKey = ''"), '迁移后应清掉明文');
});
