'use strict';
/**
 * 面必过 · 桌面端主进程（Windows / Electron）
 *
 * 产品立场（写进代码，不只是写进文档）：
 *  - 只给要点，不给成稿 —— 由 packages/core 的校验器强制
 *  - 不做隐蔽采集、不规避检测 —— 无 stealth 分支
 *  - 内容保护默认关闭，仅在「复盘录制」模式开启，且文案为防草稿入镜
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen, dialog, Notification, shell } = require('electron');
const core = require('@job-bingo/core');
const { Pipeline } = require('./pipeline');
const { createTrayImage } = require('./tray-icon');
const { initAudioCapture, startCapture, stopCapture, captureStatus, selfTestCapture } = require('./audio-capture');

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------- 配置 ----------
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const RESUME_FILE = path.join(app.getPath('userData'), 'resume.json');

const DEFAULT_CONFIG = {
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  jd: '',
  overlay: { opacity: 0.94, through: true, width: 780, height: 300, top: 36, taskbar: false, solid: false },
  // 夜间免费额度被限流时的退避策略（单位：分钟）
  busy: { retryMinutes: 5, maxWaitMinutes: 60 },
  ws: { enabled: true, port: 8787 },
  protect: { contentProtection: false },
  // 启动即开始采集（关掉它就得每次手动点，容易以为软件坏了）
  capture: { autoStart: true },
  compliance: { acknowledged: false },
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

let config = DEFAULT_CONFIG;
try {
  if (fs.existsSync(CONFIG_FILE)) config = deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
} catch (e) {
  console.warn('[config] 读取失败，使用默认值', e.message);
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8'); } catch (e) { console.warn(e.message); }
}

let resumeData = null;
try {
  if (fs.existsSync(RESUME_FILE)) resumeData = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
} catch (e) { console.warn('[resume] 读取失败', e.message); }

// ---------- 窗口 ----------
let overlay = null;
let settings = null;
let tray = null;
let mouseThrough = true;

function createOverlay() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const o = config.overlay;

  // solid 兼容模式：部分远程桌面/VNC 虚拟显示驱动下，transparent 窗口不渲染。
  // 打开后浮窗变成实底（仍置顶、仍可穿透），牺牲半透明换可见性。
  const solid = !!o.solid;
  const win = new BrowserWindow({
    width: o.width,
    height: o.height,
    x: Math.round((sw - o.width) / 2),
    y: o.top,
    frame: false,
    transparent: !solid,
    resizable: true,
    hasShadow: false,
    // 默认不占任务栏（避免干扰），但可在设置里打开以便找回窗口
    skipTaskbar: !o.taskbar,
    alwaysOnTop: true,
    backgroundColor: solid ? '#0d121e' : '#00000000',
    title: '面必过',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlay = win;

  // 压在所有窗口之上，包括全屏会议软件
  overlay.setAlwaysOnTop(true, 'screen-saver');
  try { overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}

  // Win11 亚克力；仅透明模式尝试（实底模式下无意义），Win10 自动降级（失败即忽略）
  if (!solid) {
    try { overlay.setBackgroundMaterial('acrylic'); } catch (_) {}
  }

  applyContentProtection();
  overlay.setOpacity(o.opacity);

  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  // 出现但不抢输入焦点 —— 不打断说话。
  // setFocusable(false) + showInactive：VNC / 无桌面合成环境下 showInactive 偶发不显示，
  // 故加一道兜底，确保窗口一定可见（仍不抢焦点）。
  try { overlay.setFocusable(false); } catch (_) {}
  overlay.showInactive();
  setTimeout(() => {
    if (overlay && !overlay.isDestroyed() && !overlay.isVisible()) overlay.show();
  }, 400);
  applyMouseThrough();

  overlay.on('closed', () => { overlay = null; });
  return overlay;
}

function applyMouseThrough() {
  if (!overlay) return;
  overlay.setIgnoreMouseEvents(mouseThrough, { forward: true });
  overlay.webContents.send('mode', { mouseThrough });
}

function applyContentProtection() {
  if (!overlay) return;
  // 默认关；复盘录制时由用户显式打开。不存在 stealth 自动路径。
  try { overlay.setContentProtection(!!config.protect.contentProtection); } catch (_) {}
}

function createSettings() {
  if (settings && !settings.isDestroyed()) { settings.focus(); return settings; }
  settings = new BrowserWindow({
    width: 900,
    height: 720,
    title: '面必过 · 设置与演练',
    backgroundColor: '#0f1420',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settings.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settings.on('closed', () => { settings = null; });
  return settings;
}

// ---------- 托盘 ----------
function createTray() {
  // 运行时生成图标（不依赖任何图片文件），失败才退回磁盘 PNG
  let icon = createTrayImage();
  if (!icon || icon.isEmpty()) {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
    icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('面必过 · 双击打开主界面 · 单击显隐浮窗');
  refreshTrayMenu();
  // 常规操作逻辑：双击托盘 = 打开主界面；单击 = 显隐浮窗
  tray.on('double-click', () => createSettings());
  tray.on('click', () => toggleOverlay());
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏浮窗  (Ctrl+Alt+H)', click: () => toggleOverlay() },
    { label: `鼠标穿透：${mouseThrough ? '开' : '关'}  (Ctrl+Alt+M)`, click: () => toggleMouse() },
    { type: 'separator' },
    { label: '开始采集系统声音', click: async () => { startCapture(); pushCard({ type: 'status', text: '正在采集系统声音（只听声音，不采画面）' }); } },
    { label: '停止采集', click: () => { stopCapture(); pushCard({ type: 'status', text: '已停止采集' }); } },
    { type: 'separator' },
    { label: '设置与演练', click: () => createSettings() },
    { label: '复盘本场面试', click: () => { const w = createSettings(); if (w) w.webContents.send('review:request'); } },
    { label: '预热模型缓存', click: () => warmupNow() },
    { type: 'separator' },
    { label: `复盘录制（内容保护）：${config.protect.contentProtection ? '开' : '关'}`, click: () => toggleProtect() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function toggleOverlay() {
  if (!overlay) { createOverlay(); return; }
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
}

function toggleMouse() {
  mouseThrough = !mouseThrough;
  config.overlay.through = mouseThrough;
  saveConfig();
  applyMouseThrough();
  refreshTrayMenu();
}

function toggleProtect() {
  config.protect.contentProtection = !config.protect.contentProtection;
  saveConfig();
  applyContentProtection();
  refreshTrayMenu();
  if (settings && !settings.isDestroyed()) settings.webContents.send('config', config);
}

// ---------- 热键 ----------
function registerShortcuts() {
  globalShortcut.register('Ctrl+Alt+H', () => toggleOverlay());
  globalShortcut.register('Ctrl+Alt+M', () => toggleMouse());
  globalShortcut.register('Ctrl+Alt+K', () => createSettings());
  globalShortcut.register('Ctrl+Alt+Up', () => setOpacity(Math.min(1, config.overlay.opacity + 0.05)));
  globalShortcut.register('Ctrl+Alt+Down', () => setOpacity(Math.max(0.35, config.overlay.opacity - 0.05)));
}

function setOpacity(v) {
  config.overlay.opacity = Math.round(v * 100) / 100;
  saveConfig();
  if (overlay) {
    overlay.setOpacity(config.overlay.opacity);
    overlay.webContents.send('mode', { mouseThrough, opacity: config.overlay.opacity });
  }
}

// ---------- 思路卡生成 ----------
// 所有已连接的 WS 客户端（手机端）。出卡时同步广播，实现「手机第二屏」。
const wsClients = new Set();

function pushCard(payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('card', payload);
  if (settings && !settings.isDestroyed()) settings.webContents.send('card', payload);
  // 同步给手机端（投屏/第二屏）
  for (const ws of wsClients) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); } catch (_) { /* 连接已断 */ }
  }
}

async function warmupNow() {
  try {
    const r = await core.warmup(config.llm, resumeData, config.jd);
    pushCard({ type: 'status', text: `缓存已预热 · ${r.latencyMs}ms · 前缀 ${(r.prefixBytes / 1024).toFixed(1)}KB` });
  } catch (e) {
    pushCard({ type: 'status', text: `预热失败：${e.message.slice(0, 120)}` });
  }
}

/**
 * 唯一的答题入口：设置窗口、热键、手机端 WS 全走这里，保证行为一致。
 * 所有输入都汇流到 pipeline，之后去重、提问判定、上下文管理的行为完全一致。
 */
const pipeline = new Pipeline({
  getConfig: () => config,
  getResume: () => resumeData,
  pushCard,
});

async function answerQuestion(question, history, from) {
  const r = await pipeline.ingest(question, { force: true, from: from || 'desktop' });
  if (r.skipped) return { ok: false, error: `已被流水线跳过：${r.skipped}` };
  if (!r.ok) return { ok: false, errors: r.errors, error: r.error };
  return { ok: true, card: r.card, attempts: r.attempts, mocked: !!r.mocked };
}

ipcMain.handle('hint:ask', async (_e, question) => answerQuestion(question, [], 'desktop'));

ipcMain.handle('pipeline:start', async (_e, source) => pipeline.start(source || 'desktop'));
ipcMain.handle('pipeline:stop', async () => pipeline.stop());
ipcMain.handle('pipeline:status', async () => pipeline.status());
ipcMain.handle('pipeline:reset', async () => { pipeline.reset(); return { ok: true }; });
ipcMain.handle('busy:cancel', async () => pipeline.cancelBusyWait());

// ---------- 复盘（M4）----------
// 复盘是事后动作：把全场问答折成纪要，落成 Markdown。
// 校验与兜底都在 core 里，这里只负责取数据、落盘、打开。
const REVIEW_DIR = path.join(app.getPath('documents'), '面必过复盘');

function reviewStamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    name: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`,
    display: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
  };
}

ipcMain.handle('review:generate', async () => {
  const transcript = pipeline.getTranscript();
  if (!transcript.length) {
    return { ok: false, error: '还没有可复盘的记录：先开始采集，或手动提问几轮' };
  }
  const r = await core.generateReview({
    transcript,
    resumeMarkdown: core.indexResume(resumeData || {}).markdown,
    jd: config.jd,
    llm: config.llm,
  });
  if (!r.ok) return r;

  const md = core.reviewToMarkdown(r.review, { jd: config.jd });
  const stamp = reviewStamp();
  try {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    const file = path.join(REVIEW_DIR, `复盘-${stamp.name}.md`);
    fs.writeFileSync(file, md, 'utf8');
    return { ok: true, review: r.review, markdown: md, file, degraded: !!r.degraded };
  } catch (e) {
    // 落盘失败不该让用户拿不到结果：把 Markdown 一并返回，界面里可复制
    return { ok: true, review: r.review, markdown: md, file: null, saveError: e.message, degraded: !!r.degraded };
  }
});

ipcMain.handle('review:openFolder', async () => {
  try {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    await shell.openPath(REVIEW_DIR);
    return { ok: true, dir: REVIEW_DIR };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('review:clear', async () => {
  pipeline.transcript = [];
  return { ok: true };
});

ipcMain.handle('review:count', async () => ({ count: pipeline.getTranscript().length }));

// 喂入 WAV：验证「音频进 → 卡片出」的完整链路
ipcMain.handle('asr:feedWav', async () => {
  const res = await dialog.showOpenDialog({
    title: '选择一个 WAV 文件（16k/16bit 单声道最佳）',
    filters: [{ name: 'WAV', extensions: ['wav'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    // 演练入口：当作「对方在问」，否则默认按 me 处理会一张卡都不出
    return pipeline.feedWav(fs.readFileSync(res.filePaths[0]), { role: 'them' });
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 300) };
  }
});

ipcMain.handle('asr:status', async () => ({ available: pipeline.asrAvailable }));

// ---- Windows 系统声音回环采集 ----
ipcMain.handle('capture:start', async () => {
  const r = startCapture();
  pushCard({ type: 'status', text: '正在采集系统声音（只听声音，不采画面）' });
  return r;
});
ipcMain.handle('capture:stop', async () => {
  const r = stopCapture();
  pushCard({ type: 'status', text: '已停止采集' });
  return r;
});
ipcMain.handle('capture:status', async () => captureStatus());
ipcMain.handle('capture:selftest', async () => selfTestCapture());

/**
 * 一键演示：合成一段「三段语音 + 间隔」的音频 → 走完整链路出卡。
 * 真回环采集接进来之前，这是验证「音频进、卡片出」最快的方式。
 */
ipcMain.handle('asr:demoWav', async () => {
  try {
    const asr = require('@job-bingo/asr');
    const pcm = asr.synthSpeechLike({ cycles: 3, silenceSec: 0.5, speechSec: 0.9, freq: 440, amp: 0.35 });
    const wav = asr.encodeWav(pcm, 16000);
    const out = path.join(app.getPath('userData'), 'test-audio.wav');
    fs.writeFileSync(out, wav);
    // 演练入口：合成音模拟「对方在问」
    const r = await pipeline.feedWav(wav, { role: 'them' });
    return { ...r, savedTo: out };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 300) };
  }
});

ipcMain.handle('hint:mock', async (_e, q) => {
  const card = core.mockHintCard(q || '介绍一下你自己');
  pushCard({ type: 'card', card, question: q || '' });
  return { ok: true, card };
});

ipcMain.handle('llm:warmup', async () => { await warmupNow(); return { ok: true }; });

ipcMain.handle('config:get', () => ({
  config,
  hasResume: !!resumeData,
  // 设置页左下角显示版本号；用 app.getVersion() 取的是打包后的真实版本
  version: app.getVersion(),
}));

ipcMain.handle('config:set', (_e, patch) => {
  config = deepMerge(config, patch);
  saveConfig();
  if (overlay) {
    overlay.setOpacity(config.overlay.opacity);
    if (config.overlay.through !== mouseThrough) { mouseThrough = config.overlay.through; applyMouseThrough(); }
  }
  applyContentProtection();
  refreshTrayMenu();
  return { ok: true, config };
});

ipcMain.handle('resume:load', async () => {
  const res = await dialog.showOpenDialog({
    title: '选择魔方简历导出的 JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    // 兼容两种形态：直接是 ResumeData，或是 { state: { data } }
    resumeData = raw.state?.data || raw.data || raw;
    fs.writeFileSync(RESUME_FILE, JSON.stringify(resumeData), 'utf8');
    const idx = core.indexResume(resumeData);
    return { ok: true, anchors: idx.anchors.length, numbers: idx.numbers.size, sample: idx.anchors.slice(0, 3) };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
});

ipcMain.handle('overlay:through', (_e, on) => {
  mouseThrough = !!on;
  config.overlay.through = mouseThrough;
  saveConfig();
  applyMouseThrough();
  refreshTrayMenu();
  return { ok: true, mouseThrough };
});

ipcMain.handle('overlay:hide', () => { if (overlay) overlay.hide(); return { ok: true }; });

// solid 兼容模式：远程/VNC 环境透明窗口不渲染时的保底
ipcMain.handle('overlay:solid', async (_e, on) => {
  config.overlay.solid = !!on;
  saveConfig();
  const wasVisible = overlay ? overlay.isVisible() : true;
  if (overlay) { overlay.destroy(); }
  createOverlay();
  if (!wasVisible) overlay.hide();
  return { ok: true, solid: config.overlay.solid };
});

// 任务栏可见：Windows 会把托盘图标折叠进隐藏区，找不到时用它把窗口挪回任务栏
ipcMain.handle('overlay:taskbar', async (_e, on) => {
  config.overlay.taskbar = !!on;
  saveConfig();
  const wasVisible = overlay ? overlay.isVisible() : true;
  if (overlay) { overlay.destroy(); }
  createOverlay();
  if (!wasVisible) overlay.hide();
  return { ok: true, taskbar: config.overlay.taskbar };
});

// ---------- 手机端接收服务（WS） ----------
/** 取一个局域网 IPv4，用于告诉手机端该连哪里 */
function lanAddress() {
  const os = require('os');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function startWs() {
  if (!config.ws.enabled) return null;
  let WebSocketServer;
  try { ({ WebSocketServer } = require('ws')); } catch (e) {
    console.warn('[ws] 未安装 ws 模块，手机推送通道停用');
    return null;
  }
  // 绑定 0.0.0.0：手机端要能连进来（同一局域网）
  const wss = new WebSocketServer({ port: config.ws.port, host: '0.0.0.0' });
  wss.on('listening', () => {
    const addr = lanAddress();
    pushCard({ type: 'status', text: `手机端地址 ws://${addr}:${config.ws.port}` });
    console.log(`[面必过] 手机端接入地址 ws://${addr}:${config.ws.port}`);
  });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
    pushCard({ type: 'status', text: '手机端已连接' });
    ws.on('message', async (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.type === 'question') {
          await answerQuestion(msg.text, msg.history || [], 'phone');
        } else if (msg.type === 'card') {
          pushCard({ type: 'card', card: msg.card, from: 'phone' });
        } else if (msg.type === 'audio') {
          // 手机端录好一段语音发过来：解码 → 转写 → 出卡（卡片会自动广播回手机）
          const buf = Buffer.from(msg.wavBase64 || '', 'base64');
          if (!buf.length) { ws.send(JSON.stringify({ type: 'audio:ack', ok: false, error: '空音频' })); return; }
          // 手机按住说话录到的是**用户自己**：role='me' 只进上下文，不出卡。
          // split=false：手机录的已是一句话，再切段会被拆成几句分别转写。
          const r = await pipeline.feedWav(buf, { role: msg.role === 'them' ? 'them' : 'me', split: false });
          ws.send(JSON.stringify({
            type: 'audio:ack', ok: !!r.ok, segments: r.segments, results: r.results || [],
          }));
        } else if (msg.type === 'capture') {
          // 手机端也能开关采集（同时也方便自动化冒烟）
          const r = msg.action === 'stop' ? stopCapture() : startCapture();
          ws.send(JSON.stringify({ type: 'capture', ok: r.ok, status: captureStatus() }));
        } else if (msg.type === 'selftest') {
          const r = selfTestCapture();
          ws.send(JSON.stringify({ type: 'capture', ok: !!r.ok, selftest: true }));
        } else if (msg.type === 'capture:status') {
          ws.send(JSON.stringify({ type: 'capture', status: captureStatus() }));
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        console.warn('[ws] 消息处理失败', e.message);
      }
    });
  });
  wss.on('error', (e) => console.warn('[ws]', e.message));
  return wss;
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  // 去掉 Electron 默认的英文菜单栏（File/Edit/View...），
  // 全部功能已由托盘菜单与热键覆盖，顶栏留着只会显得没汉化。
  Menu.setApplicationMenu(null);

  // 采集窗口的授权与数据回传（独立 partition，不污染默认会话）
  initAudioCapture({
    pushCard,
    // role 由双轨回声门给出：'me' 只进上下文不出卡，'them' 才生成思路卡
    onSegment: (pcm, role) => pipeline.feedPcm(pcm, { role }),
  });
  createOverlay();
  createTray();
  registerShortcuts();
  startWs();

  // 启动即进入「采集就绪」：用户唯一会忘记的一步就是点开始，忘了就等于没装。
  // 采集窗口本身可见且标注状态，不存在偷偷录音的情况。
  if (config.capture && config.capture.autoStart === false) {
    console.log('[capture] 已按配置跳过自动采集');
  } else {
    setTimeout(() => {
      const r = startCapture();
      if (!r.ok) pushCard({ type: 'status', text: `采集未能启动：${r.error || '未知原因'}` });
    }, 600);
  }
  console.log('[面必过] 已启动 · 浮窗置顶 · 热键 Ctrl+Alt+H/M/K · WS 端口', config.ws.port);

  // Windows 11 默认把托盘图标折叠进隐藏区，用户容易以为软件没跑起来。
  // 启动时给一条本机通知，明确告诉它在哪。
  if (Notification.isSupported()) {
    new Notification({
      title: '面必过已启动',
      body: '浮窗在屏幕顶部 · 托盘图标在右下角（可能在折叠区）· Ctrl+Alt+K 打开设置',
    }).show();
  }

  // 未配置 Key 时自动演示一张卡，保证打开就能看到产品长什么样
  if (!config.llm.apiKey) {
    setTimeout(() => {
      const card = core.mockHintCard('（演示）说说你处理过的一个难题');
      pushCard({ type: 'card', card, question: '（演示）说说你处理过的一个难题' });
    }, 1200);
  }
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });

app.on('second-instance', () => {
  if (overlay) overlay.showInactive();
  else createOverlay();
});
