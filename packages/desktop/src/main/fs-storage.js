'use strict';
/**
 * 场次的文件存储适配器（桌面端）。
 * core 只定义契约，具体 IO 放在平台层。
 */
const fs = require('fs');
const path = require('path');

function createFsStorage(dir) {
  /**
   * id → 文件路径。
   *
   * 必须校验 id：它来自 IPC（渲染层传入），
   * 一旦渲染进程被注入（比如用户导入的简历 JSON 藏了脚本），
   * 构造 '../../xxx' 或绝对路径就能读写存储目录之外的任意 .json。
   *
   * 只允许 [A-Za-z0-9_-]：场次 id 本来就是这个形状
   * （时间戳 + 随机后缀），收紧不会误伤。
   */
  const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
  const fileOf = (id) => {
    const s = String(id == null ? '' : id);
    if (!SAFE_ID.test(s)) {
      const e = new Error('invalid session id');
      e.code = 'EINVALID';
      throw e;
    }
    const p = path.join(dir, `${s}.json`);
    // 双保险：即便上面的正则被改坏，也确保最终路径仍在 dir 内
    const root = path.resolve(dir);
    if (path.resolve(p) !== path.join(root, `${s}.json`)) {
      const e = new Error('session path escapes storage dir');
      e.code = 'EINVALID';
      throw e;
    }
    return p;
  };

  return {
    list() {
      if (!fs.existsSync(dir)) return [];
      const out = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        } catch (_) {
          // 坏文件跳过：不能因为一个损坏的场次文件就列不出其它的
        }
      }
      return out;
    },
    read(id) {
      const p = fileOf(id);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    },
    write(id, obj) {
      const p = fileOf(id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8');
    },
    remove(id) {
      const p = fileOf(id);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
  };
}

module.exports = { createFsStorage };
