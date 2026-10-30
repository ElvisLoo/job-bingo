'use strict';
/**
 * 验证「旧版明文 Key 自动迁移」：
 * 造一个含明文 Key 的 config.json，跑迁移逻辑，确认
 *   1. credentials.dat 生成且不含明文
 *   2. config.json 里的 Key 被清空
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const cred = require('../../packages/desktop/src/main/credentials');

app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-mig-'));
  const cfgFile = path.join(dir, 'config.json');
  const FAKE = 'sk-OLD-PLAINTEXT-SHOULD-BE-GONE';

  // 模拟旧版留下的配置
  fs.writeFileSync(cfgFile, JSON.stringify({ llm: { baseUrl: 'https://x', apiKey: FAKE, model: 'm' } }), 'utf8');

  // 复刻主进程里的迁移逻辑（避免把整个 index.js 拉起来）
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const plain = cfg.llm && cfg.llm.apiKey;
  console.log('迁移前 config 含明文:', JSON.stringify(cfg).includes(FAKE));

  const r = cred.saveSecrets(dir, { llmApiKey: plain, asrApiKey: '' });
  if (r.ok) {
    cfg.llm.apiKey = '';
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8');
  }
  console.log('save ok:', r.ok);

  const after = fs.readFileSync(cfgFile, 'utf8');
  console.log('迁移后 config 含明文:', after.includes(FAKE));
  console.log('凭据文件存在:', fs.existsSync(path.join(dir, cred.CRED_FILE)));
  const cb = fs.readFileSync(path.join(dir, cred.CRED_FILE));
  console.log('凭据文件含明文:', cb.includes(FAKE));

  const back = cred.loadSecrets(dir);
  console.log('读回一致:', back.ok && back.secrets.llmApiKey === FAKE);

  app.exit(0);
});
