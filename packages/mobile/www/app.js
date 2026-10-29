'use strict';
/**
 * 手机端（Capacitor + Android WebView）
 *
 * 两种用法：
 *  1) 采集端：按住录音 → 本地 VAD 分段 → 走电脑端网关转写 → 电脑浮窗出卡；
 *  2) 第二屏：连上电脑后，电脑出的思路卡会实时推到手机上显示。
 *
 * 与电脑端共用同一套 packages/core 校验规则（由电脑端保证），
 * 手机端只负责采集、显示与转发。
 */
const $ = (id) => document.getElementById(id);

const DEFAULT_PORT = 8787;
let ws = null;
let mediaStream = null;
let audioCtx = null;
let processor = null;
let recording = false;
// 这段录音是谁说的：'me'（我在回答，默认）| 'them'（对方在问）
// 手机麦克风只能录到本地声音，绝大多数情况是「我在答」；
// 只有把手机递到扬声器前录对方时才切到 them。
let speaker = 'me';

// ---- 连接电脑 ----
function setConn(text, on) {
  $('conn').textContent = text;
  $('conn').className = 'conn' + (on ? ' on' : '');
}

function connect(host) {
  if (!host) { setConn('请先填电脑地址', false); return; }
  try {
    ws = new WebSocket(`ws://${host}:${DEFAULT_PORT}`);
  } catch (e) {
    setConn('地址无效', false);
    return;
  }
  setConn('连接中…', false);
  ws.onopen = () => { setConn(`已连接 ${host}`, true); localStorage.setItem('host', host); };
  ws.onclose = () => setConn('已断开', false);
  ws.onerror = () => setConn('连接失败', false);
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'card') renderCard(msg.card);
      else if (msg.type === 'busy') $('status').textContent = `模型繁忙，${msg.secondsLeft}s 后重试`;
      else if (msg.type === 'status') $('status').textContent = msg.text;
      else if (msg.type === 'audio:ack') {
        if (!msg.ok) $('status').textContent = '转写失败：' + (msg.error || '未知');
        else if (speaker !== 'me') $('status').textContent = `已识别 ${msg.segments || 0} 段，等待思路卡…`;
      }
    } catch (_) { /* 忽略非 JSON */ }
  };
}

$('connect').onclick = () => connect($('host').value.trim());

const saved = localStorage.getItem('host');
if (saved) { $('host').value = saved; connect(saved); }

// ---- 渲染思路卡 ----
function renderCard(card) {
  if (!card) return;
  $('hint').hidden = true;
  $('card').hidden = false;
  $('anchor').textContent = card.anchor?.label || '';
  const ul = $('points');
  ul.innerHTML = '';
  for (const p of card.points || []) {
    const li = document.createElement('li');
    li.textContent = p.text;
    ul.appendChild(li);
  }
  if (card.caution) { $('caution').hidden = false; $('caution').textContent = '⚠ ' + card.caution; }
  else $('caution').hidden = true;
}

// ---- 录音（按住说话）----
async function startRecording() {
  if (recording) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    });
  } catch (e) {
    $('status').textContent = '麦克风不可用：' + e.message;
    return;
  }
  recording = true;
  $('mic').classList.add('recording');
  $('mic').textContent = '松开发送';
  $('wave').hidden = false;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(mediaStream);

  // ScriptProcessor 兼容性最好（Android WebView 对 AudioWorklet 支持不一致）
  processor = audioCtx.createScriptProcessor(1600, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (e) => {
    const ch = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(ch));
  };
  source.connect(processor);
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(audioCtx.destination);
  processor._chunks = chunks;
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  $('mic').classList.remove('recording');
  $('mic').textContent = speaker === 'me' ? '按住说话（我在回答）' : '按住说话（对方在问）';
  $('wave').hidden = true;

  const chunks = processor?._chunks || [];
  if (processor) { processor.disconnect(); processor = null; }
  if (audioCtx) { await audioCtx.close().catch(() => {}); audioCtx = null; }
  if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); mediaStream = null; }

  if (!chunks.length) { $('status').textContent = '没有录到声音'; return; }

  // 合成一段 PCM → WAV，交给电脑端转写（手机端不做 ASR，省电也省流量）
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }

  const wav = encodeWav(pcm, 16000);
  $('status').textContent = `已录 ${(total / 16000).toFixed(1)}s，发送中…`;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'audio',
      role: speaker,               // 'me' 只进上下文不出卡；'them' 才生成思路卡
      wavBase64: toBase64(wav),
      sampleRate: 16000,
    }));
    $('status').textContent = speaker === 'me'
      ? `已发送（我在回答，不生成卡片）`
      : `已发送（对方在问，等待思路卡）`;
  } else {
    $('status').textContent = '未连接电脑，无法转写';
  }
}

/**
 * Uint8Array → base64。
 * 不能用 btoa(String.fromCharCode(...wav))：展开运算符会把每个字节变成实参，
 * 一段 3 秒的音频就有 96000 个实参，直接 RangeError: Maximum call stack size exceeded。
 * 这里按 8KB 分块，既避免栈溢出，也不会长时间卡住主线程。
 */
function toBase64(bytes) {
  const CHUNK = 0x2000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** Float32 → 16bit WAV */
function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function setSpeaker(who) {
  speaker = who;
  $('whoMe').classList.toggle('on', who === 'me');
  $('whoThem').classList.toggle('on', who === 'them');
  $('mic').textContent = who === 'me' ? '按住说话（我在回答）' : '按住说话（对方在问）';
}
$('whoMe').onclick = () => setSpeaker('me');
$('whoThem').onclick = () => setSpeaker('them');

$('mic').addEventListener('pointerdown', startRecording);
$('mic').addEventListener('pointerup', stopRecording);
$('mic').addEventListener('pointercancel', stopRecording);
