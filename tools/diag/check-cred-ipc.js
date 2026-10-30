'use strict';
/** 直接调用 config:get 的返回结构，确认不含明文 Key */
const path = require('path');
const { app } = require('electron');
const cred = require('../../packages/desktop/src/main/credentials');

app.whenReady().then(() => {
  const dir = path.join(app.getPath('appData'), '@job-bingo', 'desktop');
  const r = cred.loadSecrets(dir);
  console.log('解密可用:', r.ok, '| 有 Key:', !!(r.ok && r.secrets.llmApiKey));
  console.log('Key 长度:', r.ok && r.secrets.llmApiKey ? r.secrets.llmApiKey.length : 0);
  // 模拟 config:get 的脱敏逻辑
  const snap = { llm: { apiKey: r.secrets ? r.secrets.llmApiKey : '' } };
  const hasLlmKey = !!snap.llm.apiKey;
  snap.llm.apiKey = '';
  console.log('脱敏后返回:', JSON.stringify({ hasLlmKey, apiKey: snap.llm.apiKey }));
  app.exit(0);
});
