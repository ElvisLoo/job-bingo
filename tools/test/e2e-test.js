'use strict';
/**
 * 端到端：core → 假模型 → 校验 → 重试。验证「拦截成稿、只输出要点」。
 * 自包含：内部自行启动假模型服务，不需要先手动起 mock-llm-server。
 */
const core = require('@job-bingo/core');
const { createMockServer } = require('./mock-llm-server');

const RESUME = {
  basic: { name: '罗广', title: '信息化经理' },
  experience: [{
    id: 'exp:0', company: '昆山万金天宇贸易有限公司', position: 'IT',
    details: '排查品号 89-HBTY0005-XXX 库存 1000 pcs 但余额 -3994.58 的成本异常，用 INVQ01 与 INV102 定位到单据层',
  }],
  projects: [{ id: 'proj:0', name: 'ERP 成本分析', description: 'INVQ01 流水 → INV102 成本重算' }],
  skillContent: '虚拟化 VMware / Hyper-V、AD 域控与 GPO、VLAN、数据库备份恢复',
};

(async () => {
  const { server, port } = await createMockServer();
  const llm = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock' };

  try {
    // 注意：必须先跑 generateHintCard 再跑 warmup。
    // mock 服务的第 1 次响应是「成稿卡」，预热会把它消耗掉，
    // 那样就验不到拦截逻辑了。
    const r = await core.generateHintCard({
      question: '说说你处理过最复杂的一次库存成本异常',
      resume: RESUME,
      jd: '苏州 信息化经理，负责日常运维、IT 项目支持、AI 基础设施',
      history: [],
      llm,
    });

    console.log(`尝试次数：${r.attempts}`);
    if (r.attempts < 2) { console.error('FAIL 成稿卡未被拦截，重试机制失效'); process.exitCode = 1; return; }
    if (!r.card) { console.error('FAIL 未产出卡片', r.errors); process.exitCode = 1; return; }

    const w = await core.warmup(llm, RESUME, '苏州 信息化经理 18-22K');
    console.log(`预热：${w.latencyMs}ms · 稳定前缀 ${(w.prefixBytes / 1024).toFixed(1)}KB`);
    console.log('锚点：', r.card.anchor.label);
    for (const p of r.card.points) console.log(`  · [${p.kind}] ${p.text}（${core.countCJK(p.text)} 汉字）`);
    console.log('提醒：', r.card.caution);
    console.log('PASS · 端到端链路可用，成稿已被拦截');
  } finally {
    server.close();
  }
})();
