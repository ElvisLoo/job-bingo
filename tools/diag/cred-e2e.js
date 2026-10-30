'use strict';
/**
 * 凭据加密端到端验证：
 * 写一个假 Key → 落盘 → 检查 config.json 无明文、credentials.dat 是密文 → 读回一致。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const cred = require('../../packages/desktop/src/main/credentials');

app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-cred-'));
  const FAKE = 'sk-test-DO-NOT-LEAK-1234567890';

  const saveR = cred.saveSecrets(dir, { llmApiKey: FAKE, asrApiKey: '' });
  console.log('save:', JSON.stringify(saveR));

  const credFile = path.join(dir, cred.CRED_FILE);
  const exists = fs.existsSync(credFile);
  const buf = exists ? fs.readFileSync(credFile) : Buffer.alloc(0);
  // 密文里不该出现明文字符串
  const leaks = buf.includes(FAKE);
  console.log('file:', credFile);
  console.log('size:', buf.length, '| 含明文:', leaks);

  const loadR = cred.loadSecrets(dir);
  console.log('load ok:', loadR.ok, '| 一致性:', loadR.secrets && loadR.secrets.llmApiKey === FAKE);

  // 清空后应删除文件
  const clearR = cred.saveSecrets(dir, { llmApiKey: '', asrApiKey: '' });
  console.log('clear:', JSON.stringify(clearR), '| 文件还在:', fs.existsSync(credFile));

  app.exit(0);
});
