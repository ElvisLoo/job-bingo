'use strict';
/**
 * 系统声音回环采集 + 麦克风双轨（Windows）
 *
 * 原理：Electron 主进程的 setDisplayMediaRequestHandler 用 audio:'loopback'
 * 应答，即可拿到系统混音，无需任何原生模块。
 * getDisplayMedia 的 API 形状要求 video:true，但拿到流后**立刻停掉视频轨**，
 * 不采集画面、不落盘、不推流。
 *
 * 麦克风单独用 getUserMedia 取：它和回环是两条独立轨，帧上打 track 标送主进程。
 * 这样主进程才能比较两路能量，判断「这段声音是谁说的」——
 * 只听回环时，你自己的声音同样会被收进去，形成自我触发的死循环。
 *
 * 四个已踩过的坑：
 *  1. AudioContext 要显式指定 sampleRate:16000，否则拿到 48k 还得自己重采样；
 *  2. AudioWorkletNode 必须连到 destination 才会被拉流 —— 串一个 gain=0 的
 *     静音节点，既驱动流水线又不出声；
 *  3. 不要碰画面：视频轨立即 stop()；
 *  4. 麦克风不可用要**降级**而不是整条链路失败（虚拟摄像头/无麦克风的云桌面很常见）。
 */
const $ = (id) => document.getElementById(id);

/**
 * 桥守卫：waitBridge()
 *
 * preload 是异步注入的。页面脚本若在桥就绪前调用 window.capture.*，
 * 会抛 TypeError 并**中断整个脚本**——表现是「窗口开着、状态却永远停在初始化」，
 * 而且不报错给用户，是最难查的一类故障（本轮就踩了一次）。
 * 这里统一等待桥可用（最多 3 秒），失败时把原因写到界面上而不是静默。
 */
function waitBridge(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (window.capture && typeof window.capture.sendPcm === 'function') return resolve(window.capture);
      if (Date.now() - started > timeoutMs) return reject(new Error('采集桥未就绪（preload 加载失败）'));
      setTimeout(poll, 50);
    })();
  });
}

/** 所有上报都走这里：桥没就绪时降级为 console，绝不让异常中断主流程 */
let bridge = null;
function report(payload) {
  try {
    if (bridge && bridge.report) bridge.report(payload);
    else console.warn('[capture] 桥未就绪，状态仅记录到控制台：', payload && payload.message);
  } catch (_) { /* 上报失败不影响采集 */ }
}
let ctx = null;
let stream = null;      // 系统混音
let micStream = null;   // 麦克风
let node = null;
let micNode = null;
let frames = 0;
let micFrames = 0;
let micOn = false;
let latestLoopRms = 0;   // 回环最新一帧的 RMS（100ms）
let latestMicRms = 0;    // 麦克风最新一帧的 RMS

/** 一帧的 RMS（与主进程回声门同一套口径） */
function rmsOf(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / Math.max(1, frame.length));
}

function setText(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = cls || '';
  // 状态徽章：状态文字与指示灯一起变，一眼看出「在采集 / 出错了」
  if (id === 'state') {
    const wrap = $('stateWrap');
    if (wrap) wrap.className = 'badge' + (cls === 'ok' ? ' ok' : cls === 'err' ? ' err' : '');
  }
}

// ---------- 电平条 ----------
const BAR_COUNT = 24;
function initBars(id) {
  const box = $(id);
  if (!box) return null;
  box.innerHTML = '';
  const cells = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const cell = document.createElement('i');
    box.appendChild(cell);
    cells.push(cell);
  }
  return cells;
}
const barsLoop = initBars('barsLoop');
const barsMic = initBars('barsMic');

/**
 * 把 0–1 的线性 RMS 映射到 dB，再点亮对应格数。
 * 用 dB 而不是线性值：人耳是对数的，线性刻度下正常说话只会点亮最右两格，
 * 看起来像「没声音」。
 */
function paintBars(cells, rms) {
  if (!cells) return;
  const db = 20 * Math.log10(Math.max(rms, 1e-6));   // 约 -120 ~ 0
  const norm = Math.max(0, Math.min(1, (db + 60) / 60)); // -60dB 以下算静音
  const lit = Math.round(norm * BAR_COUNT);
  for (let i = 0; i < cells.length; i++) {
    const on = i < lit;
    cells[i].className = on
      ? 'on' + (i >= BAR_COUNT - 2 ? ' clip' : i >= BAR_COUNT - 6 ? ' hot' : '')
      : '';
  }
}

async function openMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micOn = true;
    setText('mic', '1 条（用于区分谁在说话）', 'ok');
    report({ level: 'info', mic: true });
    return micStream;
  } catch (e) {
    micOn = false;
    setText('mic', '不可用 · 退化为单轨（可能把自己的话当成问题）', 'err');
    // scope:'mic' 让主进程只记录、不弹错误卡
    report({ level: 'error', scope: 'mic', message: String(e && e.message || e) });
    return null;
  }
}

async function start() {
  try {
    setText('state', '正在初始化采集桥…', '');
    bridge = await waitBridge();
    console.log('[renderer] 采集桥已就绪');
    setText('state', '正在请求系统音频…', '');
    console.log('[renderer] 调用 getDisplayMedia…');
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    console.log(`[renderer] 拿到流：video=${stream.getVideoTracks().length} audio=${stream.getAudioTracks().length}`);
    // 只借用 API 形状要求的视频轨，拿到即停：不采集画面
    for (const t of stream.getVideoTracks()) t.stop();

    const audioTracks = stream.getAudioTracks();
    setText('tracks', `${audioTracks.length} 条${audioTracks.length ? '（系统混音）' : ''}`, audioTracks.length ? 'ok' : 'err');
    if (!audioTracks.length) {
      setText('state', '未拿到音频轨：可能没有可用的系统输出设备', 'err');
      report({ level: 'error', message: 'loopback stream has no audio track' });
      return;
    }

    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    console.log(`[renderer] AudioContext 采样率 ${ctx.sampleRate}，状态 ${ctx.state}`);
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    console.log('[renderer] worklet 已加载');
    setText('rate', `${ctx.sampleRate} Hz`, 'ok');

    // 必须是 16k：VAD 与转写都按 16k 设计，48k 会让一切时间参数失真
    if (Math.abs(ctx.sampleRate - 16000) > 1) {
      setText('rate', `${ctx.sampleRate} Hz（非 16k，识别质量可能下降）`, 'err');
    }

    // VAD 在主进程（asr 是 Node 包，不适合放 preload）；这里只负责把帧送出去
    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-worklet');

    node.port.onmessage = (e) => {
      frames++;
      if (frames % 10 === 0) setText('frames', String(frames), '');
      const pcm = new Float32Array(e.data);
      latestLoopRms = rmsOf(pcm);
      window.capture.sendPcm(pcm, 'loop');
    };

    // 必须连 destination 才会被拉流；串 gain=0 保证不发出声音
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);

    // ---- 麦克风轨 ----
    console.log('[renderer] 准备打开麦克风…');
    const mic = await openMic();
    console.log('[renderer] 麦克风结果：', mic ? mic.getAudioTracks().length + ' 条轨' : '不可用');
    if (mic && mic.getAudioTracks().length) {
      const micSource = ctx.createMediaStreamSource(mic);
      micNode = new AudioWorkletNode(ctx, 'pcm-worklet');
      micNode.port.onmessage = (e) => {
        micFrames++;
        if (micFrames % 10 === 0) setText('micFrames', String(micFrames), '');
        const micPcm = new Float32Array(e.data);
        latestMicRms = rmsOf(micPcm);
        window.capture.sendPcm(micPcm, 'mic');
      };
      micSource.connect(micNode);
      micNode.connect(mute); // 同样静音，不能把自己的声音再放出来（否则形成啸叫）
      mic.getAudioTracks()[0].addEventListener('ended', () => {
        micOn = false;
        setText('mic', '麦克风已断开 · 退化为单轨', 'err');
        report({ level: 'error', scope: 'mic', message: 'mic track ended' });
      });
    }

    // 每 100ms 采一次两路的瞬时能量，交给主进程的回声门做「此刻谁在说」判定。
    // 只做判定、不落盘：这是纯内存里的 100ms 窗口。
    // 必须在麦克风就绪**之后**调用：放在前面会让 micStream 仍为 null，
    // 麦克风旁路接不上、回声门永远判 unknown —— 而且不报错，是最难查的一类静默失败。
    startLevelProbe();

    // 音频轨可能在中途结束（对方关闭共享/设备变化），这里给出明确提示
    audioTracks[0].addEventListener('ended', () => {
      setText('state', '音频轨已结束（设备或会话变化）', 'err');
      report({ level: 'error', message: 'audio track ended' });
    });
    audioTracks[0].addEventListener('mute', () => {
      setText('tracks', `${audioTracks.length} 条（已静音/无信号）`, 'err');
      report({ level: 'error', message: 'audio track muted' });
    });

    setText('state', '采集中（只听声音，不看画面）', 'ok');
    report({ level: 'info', message: 'capture started', sampleRate: ctx.sampleRate });
  } catch (e) {
    setText('state', '启动失败：' + e.message, 'err');
    report({ level: 'error', message: String(e && e.message || e) });
  }
}

/** 100ms 两路能量采样器：把人声窗口的能量直接给主进程比较，不做识别 */
let probeTimer = null;

/**
 * 电平探针：直接用 AudioWorklet 吐出的帧算 RMS，上报给主进程的回声门。
 *
 * 为什么不用 AnalyserNode 旁路：
 *   我们已经在 worklet 帧上拿到了每一路最原始的数据，再加一个 AnalyserNode
 *   等于多接一次 createMediaStreamSource，实测在回环 + 麦克风双流下会读到全 0
 *   （而且不报错）——回声门于是永远判 unknown，白装了双轨。
 *   直接从已有帧算，少一条旁路、少一个静默失败点。
 */
function startLevelProbe() {
  if (probeTimer) clearInterval(probeTimer);
  setText('probe', '已接（取自采集帧本身）', 'ok');
  probeTimer = setInterval(() => {
    try {
      window.capture.sendLevel({
        loop: latestLoopRms,
        mic: micOn && micFrames > 0 ? latestMicRms : null,
      });
      paintBars(barsLoop, latestLoopRms);
      paintBars(barsMic, micOn ? latestMicRms : 0);
    } catch (_) { /* 窗口关闭时忽略 */ }
  }, 100);
}

async function stop() {
  try {
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    if (node) { node.port.close(); node.disconnect(); node = null; }
    if (micNode) { micNode.port.close(); micNode.disconnect(); micNode = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; }
    if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
    setText('state', '已停止', 'dim');
  } catch (e) { /* 停止失败不影响主流程 */ }
}

/**
 * 自检：向默认输出设备播放「0.9s 语音样音 + 0.5s 静音」× 3。
 * 这些声音会被系统回环重新捕获，从而端到端验证
 * 「播放 → 回环采集 → VAD 分段 → 转写 → 出卡」整条链路。
 * 播放用的是带包络的正弦音，不是真人语音，但足以验证通路。
 */
function playSelfTest() {
  if (!ctx) { report({ level: 'error', message: '自检失败：采集未启动' }); return; }
  const now = ctx.currentTime;
  for (let i = 0; i < 3; i++) {
    const t0 = now + 0.2 + i * 1.4;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.35, t0 + 0.05);
    gain.gain.setValueAtTime(0.35, t0 + 0.85);
    gain.gain.linearRampToValueAtTime(0, t0 + 0.9);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.92);
  }
  setText('state', '自检中：正在播放 3 段测试音…', '');
  report({ level: 'info', message: 'selftest playing' });
}

function bindBridgeEvents() {
  if (!bridge) return;
  bridge.onWho((p) => {
    if (!p) return;
    const label = { me: '像是你在说（不生成卡片）', them: '像是对方在说（生成卡片）', unknown: '无法判断（按对方处理）', silence: '安静' }[p.role] || p.role;
    const cls = p.role === 'me' ? 'dim' : p.role === 'them' ? 'ok' : '';
    if ($('whoPanel')) $('whoPanel').className = 'who-panel ' + (p.role === 'me' ? 'me' : p.role === 'them' ? 'them' : '');
    setText('who', `${label} · 麦克风 ${p.micDb} dB / 回环 ${p.loopDb} dB`);
  });

  bridge.onSelfTest(playSelfTest);
}

window.addEventListener('error', (e) => report({ level: 'error', message: e.message }));

// 桥就绪后再绑定事件并启动，避免「窗口开着但脚本已死」的静默故障
waitBridge()
  .then(() => { bridge = window.capture; bindBridgeEvents(); report({ level: 'info', message: 'capture window ready' }); })
  .catch((e) => setText('state', '采集桥未就绪：' + e.message, 'err'))
  .finally(() => start());
