'use strict';
/**
 * 把旧 appId 目录（@copilot）里明文存放的 apiKey 迁移到新目录的加密存储，
 * 然后清空旧文件里的明文。
 *
 * 每一步都先验证再落地：加密成功才清明文，否则宁可保留（用户 Key 不能丢）。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const cred = require('../../packages/desktop/src/main/credentials');

app.whenReady().then(() => {
  const appData = app.getPath('appData');
  const oldCfg = path.join(appData, '@copilot', 'desktop', 'config.json');
  const newDir = path.join(appData, '@job-bingo', 'desktop');

  if (!fs.existsSync(oldCfg)) { console.log('RESULT: 旧配置不存在，无需迁移'); app.exit(0); return; }

  const cfg = JSON.parse(fs.readFileSync(oldCfg, 'utf8'));
  const plain = (cfg.llm && cfg.llm.apiKey) || '';
  if (!plain) { console.log('RESULT: 旧配置里没有 apiKey'); app.exit(0); return; }

  const keyPrefix = plain.slice(0, 6);
  console.log('发现明文 Key，前缀:', keyPrefix + '***', '长度:', plain.length);

  // 1) 先加密写入新目录
  const r = cred.saveSecrets(newDir, { llmApiKey: plain, asrApiKey: (cfg.asr && cfg.asr.apiKey) || '' });
  console.log('加密保存:', JSON.stringify(r));
  if (!r.ok) { console.log('RESULT: 加密失败，保留明文不动'); app.exit(1); return; }

  // 2) 验证能读回（解不开就不清明文）
  const back = cred.loadSecrets(newDir);
  const same = back.ok && back.secrets.llmApiKey === plain;
  console.log('读回校验一致:', same);
  if (!same) { console.log('RESULT: 读回不一致，保留明文'); app.exit(1); return; }

  // 3) 把配置整体复制到新目录（去掉明文），再清空旧文件里的 Key
  const cleanCfg = JSON.parse(JSON.stringify(cfg));
  if (cleanCfg.llm) cleanCfg.llm.apiKey = '';
  if (cleanCfg.asr) cleanCfg.asr.apiKey = '';

  const newCfg = path.join(newDir, 'config.json');
  if (!fs.existsSync(newCfg)) {
    fs.writeFileSync(newCfg, JSON.stringify(cleanCfg, null, 2), 'utf8');
    console.log('已写入新配置:', newCfg);
  }
  fs.writeFileSync(oldCfg, JSON.stringify(cleanCfg, null, 2), 'utf8');
  console.log('旧配置已清空明文');

  console.log('RESULT: 迁移完成');
  app.exit(0);
});
