'use strict';
/**
 * 长面试端到端：在打包产物里验证上下文分层真的生效。
 *
 * 直接 require asar 里的 core（不用源码），这样测的是"用户实际拿到的东西"。
 */
const path = require('path');
const asar = require('@electron/asar');

const asarPath = path.resolve(__dirname, '..', '..', 'dist', 'win-unpacked', 'resources', 'app.asar');

// 把 asar 里的 core 解到临时目录再 require（Node 不能直接 require asar 内部）
const os = require('os');
const fs = require('fs');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-core-'));
const sep = String.fromCharCode(92);
const files = asar.listPackage(asarPath)
  .map((p) => ({ raw: p, posix: p.split(sep).join('/') }))
  .filter((e) => e.posix.includes('node_modules/@job-bingo/core/'))
  // 目录条目也是列表项，extractFile 会报 "found a directory"
  .filter((e) => /\.(js|json|md)$/.test(e.posix));

for (const e of files) {
  const rel = e.posix.split('node_modules/@job-bingo/core/')[1];
  const dst = path.join(outDir, rel.split('/').join(sep));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, asar.extractFile(asarPath, e.raw.replace(/^[\\/]+/, '')));
}

const core = require(path.join(outDir, 'src', 'index.js'));

// 构造一场真实的长面试
const entries = [
  { role: 'them', text: '先简单介绍一下你自己' },
  { role: 'me', text: '五年后端，主要做电商订单系统' },
  { role: 'them', text: '说说你最有成就感的项目' },
  { role: 'me', text: '订单履约系统，用 Kafka 削峰，日订单三百万' },
  { role: 'them', text: '这个系统的数据库怎么设计的' },
  { role: 'me', text: 'MySQL 分库分表，按订单号哈希' },
  { role: 'them', text: '遇到过什么线上故障' },
  { role: 'me', text: '大促时 MQ 消费堆积到百万级' },
];
// 中间穿插 60 轮无关问答
for (let i = 0; i < 30; i += 1) {
  entries.push({ role: 'them', text: `扩展问题 ${i}：你怎么看团队协作与跨部门沟通` });
  entries.push({ role: 'me', text: `协作方面我认为关键在于对齐目标，第 ${i} 次回答` });
}

const question = '回到最早那个订单履约系统，Kafka 削峰具体是怎么做的？';
entries.push({ role: 'them', text: question });

const msgs = core.buildMessages({ prefix: '【系统提示】简历略', question, entries });
const all = msgs.map((m) => m.content).join('\n');

const roles = msgs.map((m) => m.role);
const dupIdx = [];
for (let i = 1; i < roles.length; i += 1) if (roles[i] === roles[i - 1]) dupIdx.push(i);

const checks = [
  ['回溯到早期原话（Kafka 削峰）', all.includes('Kafka 削峰')],
  ['含早期摘要', all.includes('问答概要')],
  ['只有一个 system 消息', roles.filter((r) => r === 'system').length === 1],
  ['system 在最前', roles[0] === 'system'],
  ['无相邻重复角色', dupIdx.length === 0],
  ['提示词体积可控（<2500 字符）', all.length < 2500],
  ['事故记录（MQ 堆积）也被带回', all.includes('MQ') || all.includes('堆积')],
];

console.log(`记录条数: ${entries.length}  messages: ${msgs.length}  字符: ${all.length}`);
console.log(`角色序列: ${roles.join(',')}`);
console.log('');
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (ok) pass += 1;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
