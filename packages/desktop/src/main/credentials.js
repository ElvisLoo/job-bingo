'use strict';
/**
 * 凭据加密：把 API Key 从 config.json 的明文里挪出来。
 *
 * 为什么必须改：
 *   config.json 里存的是 `apiKey: "sk-..."`，同一台机器上任何进程都能直接读走。
 *   这是个长期有效的付费凭据，泄露等于被盗刷。
 *
 * 做法：
 *   用 Electron 的 safeStorage（Windows 走 DPAPI，绑定当前用户），
 *   加密后把密文写成单独的 credentials.dat。
 *   config.json 里只留空字符串，读配置时再解密注入。
 *
 * 降级：
 *   极少数环境（Linux 无 keyring、或打包前未初始化）safeStorage 不可用。
 *   这时**不静默降级成明文**，而是明确返回原因，由调用方决定是否提示用户。
 */

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const CRED_FILE = 'credentials.dat';

function credPath(userDataDir) {
  return path.join(userDataDir, CRED_FILE);
}

/** safeStorage 是否可用（必须先 app.whenReady） */
function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

/**
 * 加密并写盘。
 * @param {string} userDataDir
 * @param {object} secrets { llmApiKey, asrApiKey }
 * @returns {{ok: boolean, reason?: string}}
 */
function saveSecrets(userDataDir, secrets = {}) {
  const payload = {
    v: 1,
    llmApiKey: String(secrets.llmApiKey || ''),
    asrApiKey: String(secrets.asrApiKey || ''),
  };
  // 两个都空就删掉文件，避免留一个空壳
  if (!payload.llmApiKey && !payload.asrApiKey) {
    try { fs.unlinkSync(credPath(userDataDir)); } catch (_) { /* 不存在就算了 */ }
    return { ok: true, cleared: true };
  }
  if (!isAvailable()) {
    return { ok: false, reason: 'safeStorage 不可用（系统凭据服务未就绪）' };
  }
  try {
    const buf = safeStorage.encryptString(JSON.stringify(payload));
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(credPath(userDataDir), buf);
    // 收紧权限：只有当前用户可读写
    try { fs.chmodSync(credPath(userDataDir), 0o600); } catch (_) { /* Windows 忽略 */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/**
 * 读出并解密。
 * @returns {{ok: boolean, secrets?: object, reason?: string}}
 */
function loadSecrets(userDataDir) {
  const p = credPath(userDataDir);
  if (!fs.existsSync(p)) return { ok: true, secrets: { llmApiKey: '', asrApiKey: '' }, missing: true };
  if (!isAvailable()) return { ok: false, reason: 'safeStorage 不可用' };
  try {
    const buf = fs.readFileSync(p);
    const json = safeStorage.decryptString(buf);
    const data = JSON.parse(json);
    return {
      ok: true,
      secrets: {
        llmApiKey: String(data.llmApiKey || ''),
        asrApiKey: String(data.asrApiKey || ''),
      },
    };
  } catch (e) {
    // 换了机器/换了 Windows 用户时密文解不开，这是预期行为（DPAPI 绑定用户）。
    // 不能当成致命错误，只能提示用户重新填一次 Key。
    return { ok: false, reason: '凭据解密失败（可能更换了系统用户或机器）：' + String(e && e.message || e).slice(0, 120) };
  }
}

module.exports = { saveSecrets, loadSecrets, isAvailable, credPath, CRED_FILE };
