'use strict';
/**
 * 场次的文件存储适配器（桌面端）。
 * core 只定义契约，具体 IO 放在平台层。
 */
const fs = require('fs');
const path = require('path');

function createFsStorage(dir) {
  const fileOf = (id) => path.join(dir, `${id}.json`);

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
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fileOf(id), JSON.stringify(obj, null, 1), 'utf8');
    },
    remove(id) {
      const p = fileOf(id);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
  };
}

module.exports = { createFsStorage };
