'use strict';
/**
 * Windows 系统声音回环采集 + 麦克风双轨（无需原生模块）
 *
 * 链路：隐藏采集窗口 getDisplayMedia（screen + loopback + microphone）
 *      → 主进程用 audio:'loopback' 应答，麦克风按普通 getUserMedia 语义应答
 *      → AudioWorklet 出 16k PCM 帧（回环 / 麦克风各一条，带轨标）
 *      → 主进程分别做 VAD → 用回声门判定「这段是谁说的」
 *      → role='them' 才交给 pipeline 出卡；role='me' 只进上下文。
 *
 * 为什么需要双轨（v0.1.1 的核心修补）：
 *   只听系统混音时，**你自己的声音也会从系统输出里回来**（会议软件本地混音、
 *   扬声器漏音、或你共享了系统声音），于是你回答问题时不断被自己的话触发新卡。
 *   加上麦克风轨后就可以比较两路能量：本地说话时麦克风远强于回环，反之亦然。
 *
 * 安全要点（刻意与参考实现不同）：
 *  **不挂载 defaultSession**。若挂在默认会话，任意页面调用 getDisplayMedia 都会被
 *  静默授权，等于给整个应用开了后门。这里用独立 partition，授权只对采集窗口生效。
 *
 * 合规：只采集系统混音与本地麦克风，不采集画面；视频轨拿到即停。
 * 单轨回环（不回传麦克风）时，回声门退化为「不做判定」，行为与 v0.1 一致。
 */
const path = require('path');
const { BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const asr = require('@job-bingo/asr');

const PARTITION = 'persist:copilot-capture';

let win = null;
let active = false;
let vad = null;      // 回环轨
let vadMic = null;   // 麦克风轨
let gate = null;     // 回声门
/** 最近 6 秒的瞬时判定（带时间戳），用于给一段语音取「多数票」而不是只看最后一帧 */
const verdicts = [];
const VERDICT_WINDOW_MS = 6000;

function rememberVerdict(r, at) {
  verdicts.push({ role: r.role, at });
  while (verdicts.length && at - verdicts[0].at > VERDICT_WINDOW_MS) verdicts.shift();
}

const state = {
  frames: 0, segs: 0, micFrames: 0, micSegs: 0, levels: 0,
  lastError: null, startedAt: 0, sampleRate: null,
  micEnabled: false, micError: null,
  // 回声门统计与最近一次判定（设置面板显示用）
  gate: { me: 0, them: 0, unknown: 0, silence: 0, last: null },
};

/**
 * @param {object} ctx
 * @param {(payload:object)=>void} ctx.pushCard  推给浮窗
 * @param {(pcm:Float32Array, role:'me'|'them')=>Promise<object>} ctx.onSegment 收到一段完整语音
 * @param {(seg:object)=>void} [ctx.onGate] 每次判定回调（调试/UI）
 */
function initAudioCapture(ctx) {
  const ses = session.fromPartition(PARTITION);

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      console.log(`[capture] 授权请求：屏幕源 ${sources.length} 个` +
        (sources.length ? ` · 选用「${sources[0].name}」` : '') +
        ` · 麦克风${request.audioRequested ? '已请求' : '未请求'}`);
      if (!sources || !sources.length) {
        state.lastError = '没有可用的屏幕源（desktopCapturer 返回空）';
        console.warn('[capture]', state.lastError);
        callback({});
        return;
      }
      // useSystemPicker 留给系统选择器即视为不支持，这里始终显式指定回环源
      callback({ video: sources[0], audio: 'loopback' });
      console.log('[capture] 已授权 audio:loopback');
    } catch (e) {
      state.lastError = String(e.message);
      console.warn('[capture] 授权失败：', state.lastError);
      callback({});
    }
  });

  // 主进程做 VAD：这里是流式 PCM 的唯一汇聚点，分段完成后才交给转写。
  // 兼容两种消息形状：裸 Float32Array（v0.1，回环）与 {track, pcm}（v0.1.1，双轨）
  ipcMain.on('capture:pcm', (_e, payload) => {
    try {
      const isObj = payload && !(payload instanceof Float32Array) && !ArrayBuffer.isView(payload);
      const track = isObj ? (payload.track || 'loop') : 'loop';
      const raw = isObj ? payload.pcm : payload;
      const pcm = raw instanceof Float32Array ? raw : new Float32Array(raw);

      if (track === 'mic') {
        state.micFrames++;
        state.micEnabled = true;
        if (!vadMic) vadMic = new asr.VadSegmenter();
        const events2 = vadMic.push(pcm, Date.now()) || [];
        for (const ev of events2) {
          if (ev.type === 'segment' && ev.pcm && ev.pcm.length) {
            state.micSegs++;
            decideAndEmit(ev, 'mic');
          }
        }
        return;
      }

      state.frames++;
      if (!vad) vad = new asr.VadSegmenter();
      const events = vad.push(pcm, Date.now()) || [];
      for (const ev of events) {
        if (ev.type === 'segment' && ev.pcm && ev.pcm.length) {
          state.segs++;
          decideAndEmit(ev, 'loop');
        }
      }
    } catch (err) {
      state.lastError = `VAD 处理失败：${err && err.message}`;
    }
  });

  ipcMain.on('capture:status', (_e, payload) => {
    if (!payload) return;
    if (payload.level === 'error') {
      // 麦克风不可用是「降级」不是「故障」：记下来并在 UI 上单独标注，不弹错误卡
      if (payload.scope === 'mic') {
        state.micError = payload.message || '麦克风不可用';
        console.warn('[capture] 麦克风不可用，退化为单轨回环：', state.micError);
        return;
      }
      state.lastError = payload.message || '未知错误';
      ctx.pushCard({ type: 'status', text: `采集异常：${state.lastError}` });
    } else {
      if (payload.frames != null) state.frames = payload.frames;
      if (payload.sampleRate != null) state.sampleRate = payload.sampleRate;
      if (payload.mic) state.micEnabled = !!payload.mic;
    }
  });
}

/** 每 100ms 的瞬时判定（用于 UI 实时显示「当前像谁在说」），不产生卡片 */
ipcMain.on('capture:level', (_e, payload) => {
  if (!payload || !gate) return;
  // 渲染层上报的是 RMS 标量（number），不是 PCM 数组。
  // 这里早期写成 new Float32Array(payload.mic)，标量会得到**空数组**，
  // 回声门据此判成「没有麦克风」，双轨形同虚设——协议错配且不报错。
  const mic = typeof payload.mic === 'number' ? payload.mic : null;
  const loop = typeof payload.loop === 'number' ? payload.loop : 0;
  const at = Date.now();
  const r = gate.classify(mic, loop, at);
  state.levels++;
  rememberVerdict(r, at);
  state.gate.last = { role: r.role, micDb: r.micDb, loopDb: r.loopDb, reason: r.reason, at };
  state.gate.me = gate.stats.me;
  state.gate.them = gate.stats.them;
  state.gate.unknown = gate.stats.frames - gate.stats.me - gate.stats.them - gate.stats.silence;
  state.gate.silence = gate.stats.silence;
  // 回传给采集窗口，让用户能直接看到「现在像谁在说」，判断回声门是否生效
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('capture:who', { role: r.role, micDb: r.micDb, loopDb: r.loopDb }); } catch (_) { /* 窗口关闭 */ }
  }
});

/**
 * 一段语音结束了，决定它属于谁。
 *
 * 麦克风轨的分段单独走一条 VAD，它的段落本质上「一定是本地说的」，
 * 但只有接到上下文里才有价值（让 LLM 知道我刚说了什么），不出卡。
 * 回环轨的分段要靠回声门判断：如果这段时间麦克风明显占优，说明是我在说话。
 */
function decideAndEmit(ev, track) {
  const role = track === 'mic' ? 'me' : (gate && state.micEnabled ? roleForSegment() : 'them');
  if (role === 'me') {
    state.gate.me++;
    Promise.resolve()
      .then(() => ctxRef.onSegment(ev.pcm, 'me'))
      .catch((err) => { state.lastError = String((err && err.message) || err); });
    return;
  }
  state.gate.them++;
  Promise.resolve()
    .then(() => ctxRef.onSegment(ev.pcm, 'them'))
    .catch((err) => {
      state.lastError = String((err && err.message) || err);
      ctxRef.pushCard({ type: 'error', errors: [{ code: 'ASR_SEGMENT', reason: state.lastError }] });
    });
}

/**
 * 整段归属：取「该段结束前几秒」内瞬时判定的多数票。
 *
 * 为什么不用最后一帧：一句话说完时，最后一帧往往已经静音或刚被麦克风拾到，
 * 用单帧判定会让归属在一句话内部来回抖。
 *
 * 判 me 的门槛刻意调高（me 票需占有效票的 60%）：误判 me 会**漏掉**对方的问题，
 * 误判 them 只会多出一张卡（用户看得见、可忽略）。宁多一张卡，不丢一个问题。
 */
function roleForSegment() {
  if (!state.gate.last) return 'them';
  return asr.voteRole(verdicts);
}

let ctxRef = { pushCard() {}, onSegment: async () => ({}) };

/** 让采集窗口播放测试音，验证回环真的能听到系统声音 */
function selfTestCapture() {
  if (!win || win.isDestroyed()) return { ok: false, error: '采集未启动' };
  if (!win.webContents.isLoading()) win.webContents.send('capture:selftest');
  else win.webContents.once('did-finish-load', () => win.webContents.send('capture:selftest'));
  return { ok: true };
}

function startCapture() {
  if (win && !win.isDestroyed()) return { ok: true, already: true };

  win = new BrowserWindow({
    width: 520,
    height: 300,
    icon: require('./tray-icon').createAppIcon(),
    // 保持可见：隐藏窗口里 getDisplayMedia 可能拿不到流（实测 0 帧）。
    // 该窗口只显示采集状态，不显示任何画面内容。
    show: true,
    backgroundColor: '#0f1420',
    title: '面必过 · 系统声音采集',
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload-audio.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('closed', () => { win = null; active = false; });
  // renderer 的 console 转发到主进程日志，便于排查采集链路
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[capture:renderer] ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    state.lastError = `采集窗口加载失败 ${code} ${desc}`;
    console.warn('[capture]', state.lastError);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'audio-capture.html'));

  if (!vad) vad = new asr.VadSegmenter();
  else vad.reset();
  if (!vadMic) vadMic = new asr.VadSegmenter();
  else vadMic.reset();
  gate = new asr.DualTrackEchoGate();
  state.frames = 0;
  state.segs = 0;
  state.micFrames = 0;
  state.micSegs = 0;
  state.micEnabled = false;
  state.micError = null;
  state.gate = { me: 0, them: 0, unknown: 0, silence: 0, last: null };
  verdicts.length = 0;
  active = true;
  state.startedAt = Date.now();
  state.lastError = null;
  return { ok: true };
}

function stopCapture() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  active = false;
  return { ok: true };
}

function captureStatus() {
  return {
    active,
    frames: state.frames,
    segs: state.segs,
    micFrames: state.micFrames,
    micSegs: state.micSegs,
    micEnabled: state.micEnabled,
    micError: state.micError,
    sampleRate: state.sampleRate,
    gate: state.gate,
    lastError: state.lastError,
    uptimeMs: state.startedAt ? Date.now() - state.startedAt : 0,
  };
}

/** 把 init 时传入的 ctx 记下来，供分段回调复用 */
function bindCtx(ctx) {
  ctxRef = ctx;
}

module.exports = {
  initAudioCapture: (ctx) => { bindCtx(ctx); initAudioCapture(ctx); },
  startCapture, stopCapture, captureStatus, selfTestCapture, PARTITION,
};
