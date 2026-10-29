# 08 · MeetingCopilot 作为 M1（采集 + ASR）基座评估

> 时间：2026-10-26 23:20–23:5x（夜间，纯只读分析，未安装任何依赖、未改动 `_ref/` 内任何文件）
> 评估对象：`_ref/gh/MeetingCopilot`（v0.2.0-beta.1，Apache-2.0，Electron 41.1.1 + React 19 + TS 5.8）
> 关联文档：`03 技术栈决策`（ADR-003 已据此项目修正过一次判断）、`05 魔方简历接入 ADR`、`07 同类项目调研`、`09 功能边界`、`10 思路卡输出规格`
> 一句话结论：**fork 是错的，自研是亏的 —— 借代码（把 `electron/asr/` + `src/audio/` 整体搬进我们自己的仓库），M1 约 13–15 人日。**

---

## 零、先纠正任务简报里的三处事实偏差

这三条不是抠字眼，它们直接改变工作量估算，所以放在最前面。

| # | 简报里的说法 | 源码事实 | 影响 |
|---|---|---|---|
| 1 | ASR 跑在 **worker_threads** | 跑在 **Electron `utilityProcess`**（独立 OS 进程）。`electron/asrHost.ts:46` `utilityProcess.fork(...)`；`electron/asr/worker.ts:5-10` 明确写"**MUST run as an Electron utilityProcess, NOT worker_threads**"，原因是 DirectML 推理在 Electron 主进程里会挂死（2026-07-09 定位，"Natively 0 段字幕"那个 bug）。`worker_threads` 只作为单测兼容路径保留（`worker.ts:12,33-43`） | **利好**：崩溃隔离与 DML 兼容已经是既成事实，不用我们踩坑。**但**我们的 `packages/core` 若计划"纯 TS 三端共享"，这个模块天生带 Electron 依赖，不能进 core（见 §6.3） |
| 2 | 有 `WDA_EXCLUDEFROMCAPTURE` / stealth 开关 / 规避检测 | **没有任何直接调 Win32 的代码**。隐身只有一条 Electron API：`win.setContentProtection(...)`（`electron/main.ts:357/638/894`），底层就是 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`。**没有** hook 会议软件、没有伪装进程名、没有改图标冒充系统进程、没有清痕迹、没有 TTS 语音代答（`grep -ri "tts\|speechSynthesis"` 零命中） | 剥离"反检测"的工作量 ≈ 0；真正要处理的是**一条 API + 它的默认值 + 它的文案**（见 §4-A）。`07` 文档里"最值得直接 fork 的骨架"这句话因此需要修正，依据见 §7 |
| 3 | （未提）`contract.ts` 自称 worker_threads 契约 | `electron/asr/contract.ts:2` 文件头注释写的是 "main thread <-> worker_threads"，与实现不一致（**过时注释**） | 小坑：我们若照注释理解进程模型会设计错 IPC 拓扑。搬家时顺手改这行注释（Apache §4(b) 也要求标注修改） |

另外两处值得记一笔的"源码即文档"级发现：

- **`local-realtime` 与 `cloud-realtime` 复用同一个 WS 客户端**（`main.ts:163-167` 把 `local-realtime` 归一成 `cloud-realtime`）。也就是说 FunASR sidecar 只是"一个说 DashScope 协议的本地 WebSocket 服务"，`aliyunRealtimeEngine.ts` 一套代码同时服务云与本地。**这个抽象省掉的是"本地引擎要单独写一套流式适配"的整块工作**，价值被低估了。
- **`providerTest.ts` 用一段 1.4 s 的 TTS wav 做真实连通性验证**（`resources/test-audio/*.wav`），而不是"发个空请求看 200"。这是本项目里工程质量最高的一个细节，值得抄思路。

---

## 一、模块依赖图

### 1.1 四个执行体（不是两个，也不是三个）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ① Chromium Renderer（React 19，contextIsolation:true / nodeIntegration:false）
│   src/App.tsx            总编排：采集生命周期 / transcript / 会话 / 提问         │
│   src/audio/LoopbackCapture.ts    getDisplayMedia({audio,video}) → 立刻 stop 视频轨
│   src/audio/MicCapture.ts         getUserMedia(deviceId) → 同一 worklet
│   src/public/pcm-worklet.js       AudioWorkletProcessor，攒 1600 样本 = 100ms
│   preload.ts (contextBridge)      window.mc.sendPcm / onAsrEvent / llmAsk …
└───────────────┬──────────────────────────────────────▲───────────────────┘
   ipcRenderer.send('capture:pcm', ArrayBuffer, ts, ch)  │  'asr:event' / 'llm:event'
                ▼                                       │
┌──────────────────────────────────────────────────────────────────────────┐
│ ② Electron Main（electron/main.ts，1158 行，单文件承载全部职责）              │
│   · BrowserWindow 浮窗（transparent/alwaysOnTop:screen-saver/skipTaskbar）  │
│   · session.defaultSession.setDisplayMediaRequestHandler → audio:'loopback' │
│   · SettingsStore(safeStorage 加密) / KnowledgeStore / SessionStore        │
│   · globalShortcut / Tray / region 截图遮罩窗 / diagnostics                │
│   · llm/adapter.ts (fetch + SSE) + prompts.ts + vision.ts                   │
│   · AsrHost（唯一持有 ASR 子进程句柄者）                                     │
│   · FunasrSidecar（唯一持有 python 子进程句柄者）                             │
└──────┬───────────────────────────┬──────────────────────┬─────────────────┘
       │ utilityProcess.fork        │ child_process.spawn   │ fetch / ws
       ▼                            ▼                       ▼
┌────────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐
│ ③ utilityProcess       │  │ ④ Python sidecar     │  │ 外部服务            │
│   asrWorker.js         │◄─┤  tools/funasr_stream │  │ DeepSeek / MiMo /   │
│  worker.ts             │ws│  _server.py          │  │ DashScope / 视觉     │
│   ├ VadSegmenter ×2    │  │  :10097              │  │ （key 只在 ②③ 内）   │
│   │   (them / me 各一)  │  │  FunASR nano /       │  └────────────────────┘
│   ├ LanguageRouter ×2  │  │  paraformer / MOSS   │
│   ├ queue(MAX 10)      │  └──────────────────────┘
│   └ engine（三态可换）   │
│      ├ WhisperEngine    │  @huggingface/transformers 3.8.1
│      │                   │  + onnxruntime-node 1.21.0 + DirectML
│      ├ CloudAsrEngine   │  → POST /chat/completions，input_audio=wav base64
│      └ AliyunRealtime   │  → wss://…/api-ws/v1/inference（云与本地共用）
└────────────────────────┘
```

**关键判断：`AsrHost` 是"进程边界唯一收口"。** 除它以外没有任何代码碰 `postMessage`，这意味着我们替换传输层（本机 IPC → 手机 WebSocket）时**只需要改这一个 135 行的文件**，加上扩 `contract.ts`。这是这个基座架构上最值钱的一点，比 VAD 还值钱。

### 1.2 主链路（点 ▶ 到出字幕）

```
用户点 ▶（renderer，需要 user gesture）
 └─ startCapture()                                    App.tsx:422
     └─ LoopbackCapture.start(onPcm)                  loopbackCapture.ts:15
         ├─ getDisplayMedia({audio:true,video:true})  ← main 的 handler 静默应答 sources[0]+loopback
         ├─ stop() 掉视频轨                             ← 只取声，不取画面
         ├─ new AudioContext({sampleRate:16000})
         ├─ addModule('pcm-worklet.js') → AudioWorkletNode
         └─ node → gain(0) → destination              ← 必须接目的地才会被 pull，且静音
     └─ window.mc.captureStarted()                    → main: capturing=true, 起 keep-warm 定时器
     └─ prewarm(true)                                 → max_tokens=1 打一次字节稳定的 system prompt
 每 100 ms：
   worklet.postMessage(buffer, [transfer])            pcm-worklet.js:24
     └─ window.mc.sendPcm(buf, Date.now(), 'them')    preload.ts:101
         └─ ipcMain.on(capturePcm) → asr.sendPcm()     main.ts:544
             └─ child.postMessage({type:'pcm'})        asrHost.ts:111（结构化克隆，~6.4KB/帧）
                 └─ VadSegmenter.push(pcm, ts)         vad.ts:112
                     ├─ speech-start（首帧超阈值）
                     ├─ partial（1400ms 节流，仅本地 GPU 引擎开）
                     └─ segment（300ms 静音 / 10s 硬顶 / flush）  → 整段交给引擎一次
                         └─ LanguageRouter.decide()   langRouter.ts:51（短段/低置信度粘上次语言）
                             └─ engine.transcribe(pcm, lang)
                                 └─ postMessage({type:'segment', 5 个时间戳})
                                     └─ AsrHost.emit → win.webContents.send('asr:event')
                                         └─ renderer 渲染 transcript
                                             └─（continuous 模式）isLikelyQuestion → 1100ms 防抖 → llmAsk
```

### 1.3 依赖方向（谁 import 谁，用于判断剥离时的"切在哪一刀"）

```
src/App.tsx ──► src/audio/{loopback,mic}Capture ──► src/public/pcm-worklet.js（运行期加载）
    │                                            └─► shared/platform.ts（captureKindForPlatform）
    ├──► shared/protocol.ts（IPC 名 + 全量类型）
    ├──► shared/textHeuristics.ts（isLikelyQuestion / classifyQuestion）
    └──► electron/preload.ts（contextBridge，单向依赖，无反向 import）

electron/main.ts ──► asrHost ──► asr/contract（纯类型，零依赖）★
    │                └──► asr/worker.js（构建产物，运行期 fork，非 import）
    ├──► funasrSidecar（独立，仅 net/child_process/fs）
    ├──► asr/{engine,cloudEngine,aliyunRealtimeEngine,wav,wavRead}  ← 只有 worker 和 providerTest 用
    ├──► llm/{adapter,prompts,vision}
    ├──► settings / knowledge / sessions / docparse / diagnostics / providerTest / tray / setupWindow
    └──► shared/{protocol,platform,trayMenu,healthState,providerCatalog,…}

asr/worker.ts ──► asr/{vad,engine,cloudEngine,aliyunRealtimeEngine,langRouter,contract}
                  ★ 这六个文件之间只有 contract 是"类型层"，其余是"实现层"，无 Electron 依赖
                    （engine.ts 只用 @huggingface/transformers + fs/path/module）
```

**切刀位置已经很清楚了：`electron/asr/*` 除 `worker.ts` 的 `process.parentPort` 适配层之外，全部是不依赖 Electron 的纯 Node 代码。** 这就是"借代码"方案在技术上成立的根本原因（§7）。

---

## 二、代码规模统计与"剥离工作量级"

统计口径：排除 `node_modules`、`docs/`、锁文件；`wc -l` 累计。

| 目录 | 文件数 | LOC | 性质 | 我们的处置 |
|---|---:|---:|---|---|
| `electron/`（顶层） | 18 | **3 863** | main 1158 / settings 517 / providerTest 419 / providerErrors 349 / funasrSidecar 257 / diagnostics 247 / preload 145 / tray 138 / asrHost 135 / setupWindow 99 / setupPreload 92 / uiStrings 84 / 其余 7 个小文件 | **取 3 个**（asrHost 135、funasrSidecar 257、docparse 42），其余重写 |
| `electron/asr/` | 9 | **1 496** | contract 93 / engine 327 / vad 208 / langRouter 57 / wav 36 / wavRead 78 / worker 374 / cloudEngine 60 / aliyunRealtime 263 | **整体保留**（M1 的肉） |
| `electron/llm/` | 3 | **590** | adapter 199 / prompts 306 / vision 85 | adapter 留；prompts **重写**；vision **删** |
| `src/`（顶层） | 6 | **2 884** | App 937 / styles 1032 / i18n 874 / 其余 3 个入口 41 | **全删** |
| `src/components/` | 7 | **1 911** | SettingsPanel 803 / HelpPanel 259 / AnswerSession 258 / ServiceHealth 241 / Transcript 182 / 其余 2 个 168 | Transcript 的渲染逻辑可参考，代码不留 |
| `src/onboarding/`＋`steps/`＋`components/` | 13 | **≈3 230** | 首启向导（API key 卡片、Provider 测试、Plan 步骤、setup.css 825） | **全删**（我们不卖 key，也不做五步向导） |
| `src/audio/` | 2 | **123** | loopbackCapture 55 / micCapture 68 | **整体保留** |
| `src/public/pcm-worklet.js` | 1 | **34** | AudioWorklet，100ms 分帧 | **整体保留** |
| `shared/` | 12 | **2 045** | protocol 598 / providerCatalog 495 / healthState 166 / transcript 118 / trayMenu 116 / 其余 7 个 | 只留 `textHeuristics`(52)、`platform`(20)；protocol 重写 |
| `tools/` | 15 | **1 631** | funasr_stream_server 372 / moss_asr_server 302 / **asr-harness 136** / rt-asr-smoke 128 / packaged-smoke 219 / 其余 10 个 | 留 sidecar 脚本 + **asr-harness** + wav/f32 互转 |
| `test/` | 26 | **4 100** | vad 131 / wav 109 / engine 51 / langRouter 43 / aliyunRt 61 / transcript 134 / settings 632 / … | **跟代码一起搬**（见 §5 第 10 项） |
| **合计** | **111** | **21 930**（其中 TS/TSX 18 465） | | |

### 2.1 三个结论性数字

| 问题 | 答案 |
|---|---|
| M1 真正需要的代码 | **≈2 250 行**（asr 1496 + asrHost 135 + sidecar 257 + audio 123 + worklet 34 + adapter 199 + textHeuristics 52 ≈ 2 296） |
| 必须扔掉的代码 | **≈6 100 行**（App 937 + styles 1032 + i18n 874 + components 1911 + onboarding 3230 的一半以上，取整 6.1k） |
| 扔掉的比例 | **≈28%**（LOC 口径）。若按"文件数"算，**111 个文件里只有 18 个能原样留** → 84% 的文件要动 |

**这就是"fork 改造"这个选项的真实价格：为了拿 2 300 行，你要先删掉 6 100 行，还要承担 upstream 每次发版的合并成本。** 加上 §4 里 34 项剥离清单中有 19 项是"改造"（不是删），fork 的成本会高于直觉。§7 会把这笔账算完。

---

## 三、可直接复用清单（按"省时/行"排序）

复用方式统一为：**拷进我们自己的仓库，保留 Apache-2.0 LICENSE，改动过的文件在文件头写变更说明**（§6.1 义务 2）。

| # | 文件 / 资产 | LOC | 一句话说明 | 省下 |
|---|---|---:|---|---:|
| 1 | `electron/asr/worker.ts` + `asrHost.ts` + `contract.ts` | 374+135+93 | **utilityProcess 承载重推理**这件事本身是踩出来的：DML 在主进程里会挂死（warmup 过、真实段第一句永不返回）。这套"主进程只转发、子进程只算"的分工 + 5 个时间戳（speechStart/speechEnd/vadClose/inferStart/inferEnd）的可观测设计，自己摸至少一周 | 4 人日 |
| 2 | `electron/asr/vad.ts` | 208 | 自适应噪声底（快降慢升）+ 300ms pre-roll + 300ms hangover + 10s 硬顶 + partial 节流，纯逻辑零依赖，131 行单测覆盖 | 3 人日 |
| 3 | `electron/asr/aliyunRealtimeEngine.ts` + `cloudEngine.ts` + `engine.ts` 的 `AsrEngine` 三态契约 | 263+60+100 | "本地 / 云单次 / 云流式"三态同契约，且**本地 sidecar 复用云流式客户端**；含 300ms 环形预滚（不掐掉第一个音节）、10s 空闲关流（控成本） | 4 人日 |
| 4 | `src/audio/loopbackCapture.ts` + `micCapture.ts` | 123 | Electron 内建 loopback 的正确形状：`video:true` 只因为 API 形状要求、拿到即 `stop()` 视频轨、`gain(0)` 静音路由（否则节点不被 pull 或会回授）。**ADR-003 的结论就靠这 55 行落地** | 3 人日 |
| 5 | `src/public/pcm-worklet.js` | 34 | 16k 单声道、1600 样本（100ms）定长分帧、`transfer` 转移所有权避免拷贝。音频线程上不能有分配，这个写法是对的 | 0.5 人日 |
| 6 | `electron/funasrSidecar.ts` | 257 | 子进程生命周期全套：端口探活复用（不抢别人已启动的实例）、`FUNASR_READY` stdout 握手、**15 分钟**首启超时（模型下载可能几分钟）、Windows `taskkill /T /F` 树杀、`app.getAppPath()` 在 asar 里不可用的坑 | 2 人日 |
| 7 | `electron/llm/prompts.ts` 的 `buildStablePrefix` + `main.ts:548-597` 的预热逻辑 | ~110 | **字节稳定前缀** + `max_tokens=1` 预热 + 4 分钟空闲重打 + 捕获期 60s 巡检。DeepSeek 前缀缓存 0.1x 计价 + 首字延迟下降，全靠"system prompt 一模一样"这一条纪律 | 2 人日 |
| 8 | `electron/settings.ts` 的 `SecretCipher` 双档（`main.ts:200-211`） | ~60 | `safeStorage` 可用则 DPAPI 真加密，不可用则降级为可识别混淆并**在 UI 上明示 `weakCrypto`**；只回传 `apiKeyHint`（末 4 位），明文永不出主进程 | 1 人日 |
| 9 | `electron/asr/wav.ts` + `wavRead.ts` | 114 | 44 字节头手写封装 + 16k mono 解码。cloud 引擎要 base64 wav，自己写容易错在 byteRate/blockAlign | 0.5 人日 |
| 10 | `test/{vad,wav,engine,langRouter,aliyunRt,transcript}.spec.ts` | 529 | **随代码迁移的回归网**。VAD 的边界（最短语音、flush、partial 节流）用真人音频测很痛苦，用单测锁住就行 | 2 人日 |
| 11 | `tools/asr-harness.mjs` + `wav-to-f32.mjs` + `f32-to-wav.mjs` | 136+41+39 | 无 GUI 喂 wav 跑全链路的命令行夹具 —— **M1 第一天的验收工具，不用自己写** | 1 人日 |
| 12 | `resources/test-audio/*.wav`（1.4s TTS 片段） | — | 连通性测试用真实语音而不是空请求 | 0.2 人日 |
| | **合计** | **≈2 300** | | **≈23 人日**（净省按 §7 折算 18–19） |

> 为什么合计 23 却只算省 18–19：其中 3–4 人日属于"如果自研可能会用更便宜的替代方案"（例：VAD 直接上 Silero ONNX 只要半天接入），并不是真省。**按 `07` 文档的口径（M1 从 28 人日降到 10–12）取 16–18 人日，我这里的逐项加总略高（19–20），差额来自 prefix-cache 与 safeStorage 两项 —— `07` 当时把它们算在 M2 里。**

---

## 四、必须剥离 / 替换清单（34 项：删除 15、改造 19）

约定：**删** = 整块移除；**改** = 保留骨架但语义反转/重写；行号以本副本为准。

### A 组 · 隐身与"看屏"能力（13 项）

> 依据 `09 功能边界`：第 1–5 类窗口 UX 保留，第 6 类内容保护改为"仅复盘录制时开"，第 7 类反检测**不实现**（本来也没有）。

| # | 位置 | 现状 | 为什么必须动 | 处置 |
|---|---|---|---|---|
| A1 | `electron/main.ts:357` | `win.setContentProtection(settings.data.ui.stealth)` | 这是整个项目唯一真正的"隐身"实现，且**默认值是 true** —— 与 `09` 定的"默认关、复盘场景自动开"相反 | 改：接到 `VisibilityConfig.contentTypeProtection`（off / review-only / always），默认 `review-only` |
| A2 | `electron/main.ts:637-639` | 设置补丁里同步 `setContentProtection` | 同上，且写路径要跟着改 | 改：只允许 `review-only` 语境下开 |
| A3 | `electron/main.ts:894` | 框选遮罩窗 `ov.setContentProtection(true)`，注释写 "selection overlay invisible to recording" | **注释本身就是问题**：明确的"对录制不可见"表述，是我们最不该留在仓库里的字符串 | 删：整个 region 截图链路移除（A5 连带） |
| A4 | `electron/main.ts:923-927` + `preload.ts:35,100` + `shared/protocol.ts:538` | `IPC.stealthSet` 全链（main handler → contextBridge → 类型） | 对外暴露一个叫 `setStealth` 的 API，等于把"隐身"写进公开接口 | 改：更名 `setContentProtection`，且仅接受 review 模式 |
| A5 | `electron/main.ts:79-97, 842-922` + `preload.ts:50,113-116` + `protocol.ts:529-535` | `regionPick` / `regionImage` / `regionRect` / `regionCancel`：全屏截图 + 遮罩拖框 + 裁切返回 dataURL | **这不是隐身，但同属"看屏幕"**：它让工具能读到用户屏幕上任何内容（含面试官共享的题面）。M1 不做，M2 再议；且它依赖 `desktopCapturer` 全屏缩略图，与"只听不看"的对外承诺冲突 | 删 |
| A6 | `electron/settings.ts:82` | `stealth: true`（默认开） | 一个字符的默认值，决定产品定性 | 改：移除该字段，并入 `visibility.contentTypeProtection` |
| A7 | `shared/protocol.ts:215, 296, 351` | `ui.stealth` 出现在 3 个接口（Settings / PublicSettings / SettingsPatch） | 类型层带着它，就无法"只改 UI 不改协议" | 改 |
| A8 | `src/App.tsx:503-507, 795-803` | 标题栏"隐身开/关"按钮 + `toggleStealth` | UI 上出现"隐身"两个字即定性 | 删 |
| A9 | `src/i18n.tsx:55-57, 477-480, 690` | 文案："隐身：窗口对录屏/共享/截图不可见" | **这几句是全仓库最危险的三行字符串**（`09` §5 成本 3：它把"明知"钉死） | 删／改写为"防止草稿被录进复盘视频" |
| A10 | `electron/setupWindow.ts:79` | 向导窗 `setContentProtection(false)` | 与 A1 成对出现，A1 改完这里没意义 | 删 |
| A11 | `docs/windows/SETUP.md:79`、`docs/windows/SETUP.zh-CN.md`、`docs/macos/*`、`README.md:136,138,202,208`、`docs/user/QUICK_START*`、`RELEASE_NOTES*`、`TROUBLESHOOTING*` | 全套"隐身"章节与措辞 | 我们不分发上游 docs，但**仓库里留着就是证据链**；且这些文件会被 fork 带过来 | 删（我们自己写 docs） |
| A12 | `test/settings.spec.ts:40,172-180,239,579`、`test/healthState.spec.ts:49` | stealth 默认值/持久化断言 | 测试锁死了错误行为 | 删 |
| A13 | `electron/llm/vision.ts`(85) + `prompts.ts:229-253 buildVisionMessages` + `main.ts:1054-1094 IPC.shotAsk` + `main.ts:1052` 注释 "Our own window is excluded from the capture automatically (content protection)" + `ui.hotkeyShot` | 截图 → 视觉模型问答整条链 | 同 A5：读屏幕内容。且 prompt 里写"给出用户可以直接说的回答要点"（成稿倾向）。**这条链会让"只听不看"变成假话** | 删 |

**A 组小结：13 项，删 9、改 4。** 其中 A9（文案）和 A6（默认值）是"两行代码决定产品定性"的典型。

### B 组 · 提词器式"直接给成稿"提示词（6 项）

> 这是本基座与我们产品**最根本的分歧**。`10 思路卡规格` 要求"每条 ≤18 字、禁止完整主谓宾、禁止'我'开头、必须锚定 resumeId"；而它的 system prompt 第一句就是"你输出的内容就是我接下来要照着念的话"。

| # | 位置 | 现状（原文摘录） | 为什么必须动 | 处置 |
|---|---|---|---|---|
| B1 | `electron/llm/prompts.ts:30-41` `PERSONA` | "你是我的**实时面试提词器**……**你输出的内容就是我接下来要照着念的话**……全文控制在 30-60 秒内可念完（约 **150-350 字**）" | 与"不给成稿"直接对立；字数目标差 10 倍（150-350 字 vs 4×18 字） | **重写**为思路卡 persona：锚点 + 2–4 条名词短语 + 0–1 条提醒 |
| B2 | `prompts.ts:300-302` `ask` | "请直接给出我可以**照着念**的回答。" | 每轮都在强化代答 | 改：要求输出 JSON `HintCard`（`10` §6），不产出可朗读文本 |
| B3 | `prompts.ts:32-41` 约束项 | 「第一句先给结论」「STAR 展开」「口语自然」「分点直接换行」 | 这些是"成稿写作指南"，方向全错；但**"只能使用简历里的真实经历，绝不编造"这条要保留并强化** | 改：保留"只用简历事实/不编数字"，其余反转 |
| B4 | `prompts.ts:89-111` `buildStablePrefix` 的分层结构 | persona + 【简历】+【岗位JD】+ 语言指令，字节稳定 | **结构要留**（prefix-cache 靠它），只换内容；`smartClip`(61-81) 的"按段落优先级裁剪"可以直接用（简历取项目/经历段、JD 取职责/要求段） | 改：结构留、内容换 |
| B5 | `prompts.ts:142-161` `buildMemoUpdateMessages` | 滚动"面试备忘"：已问问题 / 我已声称的事实 / 面试官关注点 / 注意事项 | **保留机制**（对"前后一致、不被追问穿帮"很有价值），但要点从"我说过什么答案"改为"我用过哪些锚点、哪些数字已出口" | 改 |
| B6 | `src/components/AnswerSession.tsx`(258) + `App.tsx` 双栏布局 + `i18n.tsx` 中"回答/答案"文案 | 右侧一栏滚动显示成稿 | 承载形态就是"念稿" | 删／重写为思路卡渲染（`10` §4 的 260px 规格） |

**B 组小结：6 项，删 2、改 4。** 提示词层只有 `smartClip` 和 memo 机制值得留，`PERSONA` 必须整体替换 —— 这不是"调 prompt"，是换产品。

### C 组 · 规避检测 / 隐藏进程 / 绕过会议软件（1 项）

| # | 位置 | 现状 | 结论 |
|---|---|---|---|
| C1 | 全仓库 | **不存在**：无进程名伪装、无 `app.setAppUserModelId` 冒充、无 hook/注入、无清痕迹、无 TTS | 唯一需要处理的是 `electron/asr/worker.ts:278` 的注释 "an explicit setting **bypasses detection** entirely" —— 它讲的是**语言检测（LID）被显式语言设置跳过**，与反检测无关，但字符串会被误读。**改 1 行注释** |

**C 组小结：1 项，改 1（注释澄清）。** 这一组的工作量是 0.1 人日 —— 与 `09` §4"你最想抄的那一条恰恰是唯一没有技术含量的那一条"完全吻合。真正需要决策的是 A 组。

### D 组 · 与「双端仲裁」冲突的单端假设（8 项）

> 我们的架构是"采集权在手机 / 在电脑 / 双端同时在"的运行时仲裁（`03` ADR-002 §4、ADR-003）。而这个基座的每一处都写死了"采集一定发生在本机的这个 Chromium 里"。

| # | 位置 | 单端假设 | 冲突后果 | 处置 |
|---|---|---|---|---|
| D1 | `asr/contract.ts:20-28` `WorkerPcm` | 只有 `channel: 'them' \| 'me'` 两个值 | 手机推上来的流无法表达"来自哪台设备"，两台手机 + 本机同时推流会撞在同一个 channel 上 | 改：加 `sourceId: string`（设备/会话标识）+ `seq: number` |
| D2 | `contract.ts:24` `captureTs: number`（`Date.now()`） | 本机墙钟 | 手机端时钟与 PC 不同源，`vad.ts` 全靠 ts 算段落边界与说话时长 → 跨端算出来是负数或巨值 | 改：单调序号为主（`seq`），墙钟为辅（仅本机用于展示）；跨端用"首帧对齐 + 序号换算" |
| D3 | `main.ts:127` `capturing` 布尔 + `main.ts:603-627` `IPC.captureStarted/Stopped` | 采集是一个全局开/关 | 仲裁器需要的是"每源一个状态 + 一个合成结果"，一个 boolean 装不下 | 改：`Map<sourceId, CaptureState>` + 派生 `anyCapturing` |
| D4 | `asrHost.ts:25-46` | `AsrHost` 单例、单 child、单 engine | 双端同时推流时共用一条队列与一对 VAD，断流/重启会互相牵连 | 改：host 可持有 N 个 child，或"一个 child + 多 sourceId 路由"（推荐后者，省内存） |
| D5 | `worker.ts:64` `language`（模块级全局）+ `worker.ts:62` `vads: Record<Channel,…>` | channel 只有 them/me，按 channel 而非按 session 分 | 两台设备各说各的语言时会互相污染语言路由 | 改：VAD/Router 的 key 从 channel 改成 `sessionId:channel` |
| D6 | `electron/sessions.ts`(37) | 会话是本地 JSON，无设备身份、无 segment 去重 | 双端同时采同一段声音 → 重复字幕 | 改：segment 加 `sourceId`，按 `(text, 时间窗)` 去重；会话加 `deviceId` |
| D7 | 全仓库（**不存在**） | **没有任何入站网络通道**：无 `WebSocketServer`、无配对、无 TLS | Android 端 PCM 无处可进 —— 这是"双端"最大的空洞，而基座完全不提供 | 新增：`packages/transport`（ws + 配对码 + 单飞），约 300 行 + 协议 |
| D8 | `main.ts:105-109`（单实例锁）、`318-334`（globalShortcut）、`tray.ts`(138) | 单端单实例假设 | 手机端不跑 Electron，这些纯桌面设施不能进 core；但"用手机时桌面还要不要占着端口"要仲裁 | 改：这些下沉到 `apps/desktop`，不进 `packages/core` |

**D 组小结：8 项，全部为"改造"（含 1 项净新增）。** 这是 M1 里最贵的一块，**5 人日**，而且它无法通过"换基座"省掉 —— 任何单端基座都要付这笔钱。

### E 组 · 其他必须动的工程冲突（6 项）

| # | 位置 | 问题 | 处置 |
|---|---|---|---|
| E1 | `electron/main.ts`（1158 行单文件） | 窗口 + 托盘 + 快捷键 + 设置 + IPC hub + ASR host + sidecar + 预热 + 会话 + 诊断 + 截图全部在一个文件；`app.setName('MeetingCopilot')`、`userData` 路径、单实例锁、`defaultSession.setDisplayMediaRequestHandler`（**全局 session，会静默应答任意窗口的 getDisplayMedia**）都在这里 | 拆成 `main/{window,ipc,asr-host,capture,llm}.ts`；display-media handler 改挂到浮窗专用的 `session.fromPartition` |
| E2 | `electron/settings.ts`(517) | schema 里塞了 stealth / vision / 双槽知识库 / onboarding / providerCatalog 槽位 | 重写为我们的最小 schema（约 120 行），只留 `SecretCipher` |
| E3 | `src/onboarding/**`（≈3 230） | 五步向导：选 provider、填 key、真实连通性测试、plan 选择 | 删；我们只留一个 2 屏"填云 ASR key + 选简历"的引导 |
| E4 | `electron/providerTest.ts`(419) + `providerErrors.ts`(349) + `shared/providerCatalog.ts`(495) | 三家 provider 的 catalog + 错误码归一 + 测试请求构造，共 1 263 行 | 删（我们只支持 1–2 家云 ASR），但**"用真实 wav 做连通性测试"的做法抄走** |
| E5 | `src/styles.css`(1032) + `src/i18n.tsx`(874) | 940×560 双栏 UI 的样式与中英双语表 | 删（浮窗 260px 高，规格完全不同） |
| E6 | `electron-builder.yml` + `patches/@huggingface+transformers+3.8.1.patch` + `asarUnpack` | `@huggingface/transformers` 必须 `asarUnpack` 且必须打 `cache_position` 补丁，`postinstall: patch-package`；engine 注释明确"**Do NOT upgrade to 4.x**" | 改：若我们不用本地 Whisper（见 §6.2 结论），**这一整条链可以整体不引入** —— 这是省体积与省维护的关键决策点 |

**E 组小结：6 项，删 3、改 3。**

### 4.1 清单总账

| 组 | 项数 | 删 | 改 | 人日 |
|---|---:|---:|---:|---:|
| A 隐身/看屏 | 13 | 9 | 4 | 2.5 |
| B 提词器→思路卡 | 6 | 2 | 4 | 3.5 |
| C 反检测 | 1 | 0 | 1 | 0.1 |
| D 单端→双端仲裁 | 8 | 0 | 8 | 5.0 |
| E 工程冲突 | 6 | 3 | 3 | 3.0 |
| **合计** | **34** | **15** | **19** | **14.1** |

注意 D 组占了 35% 的工作量，而它与"选哪个基座"无关 —— 这决定了 §7 的结论：**基座的价值只在 A/B/E（可删可改），D 是无论如何都要自己写的。**

---

## 五、三个风险与验证方法

### 5.1 风险 a · 许可证（Apache-2.0 衍生物要保留什么）

先做一个对照，因为它决定我们的整体姿势：

| | MeetingCopilot | 魔方简历（`05` ADR 已处理） |
|---|---|---|
| 许可 | **纯 Apache-2.0**（`LICENSE` 10 752 B，标准全文，**无附加条款**） | Apache-2.0 **+ 附加商业限制** |
| 有无 NOTICE | **无**（已核实仓库根无 `NOTICE`） | 无 |
| 是否 copyleft | **否** —— 允许闭源衍生 | 条款 3 限制二次开发+商业运营 |
| 我们的义务 | 署名 + 保留 LICENSE + 标注修改 | 同左 + 不得商业化 |

**逐条义务（Apache-2.0 §4，按"最容易被漏"排序）：**

| # | 义务 | 具体动作 | 漏了会怎样 |
|---|---|---|---|
| 1 | **§4(b) 修改过的文件必须带显著变更说明** | 我们改过的 `worker.ts` / `contract.ts` / `prompts.ts` 等，文件头加：`Modified by 面试副驾 on 2026-10-27: removed channel-only assumption, see docs/08` | **这是最常被漏的一条**，也是唯一无法靠"我们开源了"自动满足的一条 |
| 2 | §4(a) 随分发提供 LICENSE 副本 | 安装包 `resources/licenses/MeetingCopilot-LICENSE.txt`；仓库根 `THIRD-PARTY.md` 登记（项目名/版本 v0.2.0-beta.1/上游 URL/许可证/是否修改=**是，已修改**） | 我们分发的是二进制安装包，属 Object form，必须带 |
| 3 | §4(c) 保留所有版权/专利/商标/署名声明 | 本项目源文件内**没有**逐文件版权头，所以只需保留 `LICENSE` + README 里的 `author: JWM0203` 与 `copyright` | 低风险，但 `electron-builder.yml` 的 `copyright` 字段要换成我们自己的，别一起抄 |
| 4 | §4(d) 若有 NOTICE 须随附、并在其中追加自己的署名 | 上游无 NOTICE → 我们自建 `NOTICE`，内容：`本产品包含来自 MeetingCopilot (c) JWM0203 的代码，Apache-2.0，已修改。` + 我们自己的版权行 | 建议做，代价一行 |
| 5 | §6 商标 | **不得**把产品叫 MeetingCopilot 或暗示 JWM0203 背书；`appId` / `productName` / 图标全部换 | 改名不是"体面问题"，是条款 |
| 6 | §3 专利授权 | 自动获得（贡献者专利许可），无需动作 | — |

**"我们整体开源非商业是否够？"**

- 对 **Apache-2.0**：**够，而且是超额完成**。Apache-2.0 从不要求衍生作品开源；我们开源是自愿，换来的是"社区可审计"这个信誉资产。
- 对**叠加了魔方简历的附加条款**：**开源是唯一能同时满足两家的姿势**。`05` §4.2 第 4 条已经写死了这个逻辑 —— 只要我们整体开源、源码可得，就不构成"嵌入闭源/商业产品"。
- **结论**：够。但要补一条 `05` 没写的：**两套许可证的署名必须放在同一处**（`THIRD-PARTY.md` + 「关于」页），否则将来做发布检查时会漏掉一家。

**验证方法（半天可做完）**：
1. `diff` 一份标准 Apache-2.0 全文 vs 本项目 `LICENSE`（确认无附加条款）→ 已做，一致。
2. 写 `THIRD-PARTY.md` 骨架，把"是否修改"字段留空 —— 逼自己在每次改上游文件时回来填。
3. 打包后 `7z l` 检查安装包里确实有 LICENSE 与 NOTICE。

### 5.2 风险 b · 依赖健康度（这一项才是真正的风险）

| 维度 | 实测/查证结果 | 判断 |
|---|---|---|
| **直接依赖** | `dependencies` **4 个**：`@huggingface/transformers@3.8.1`、`mammoth@^1.12`、`pdf-parse@^2.4`、`ws@^8.18`；`devDependencies` **15 个**（electron 41.1.1、electron-vite 3.1、react 19.1、vite 6.2、vitest 3.1、TS 5.8、electron-builder 26.15、patch-package 8） | 🟢 **极少**。4 个运行时依赖对一个"Electron + 本地推理"项目来说属于克制 |
| **锁文件规模** | `package-lock.json` **575 个 node_modules 条目** | 🟡 中位。多平台 optional 包占大头（esbuild 25 个、sharp 30 个、rollup 30 个、@napi-rs/canvas 11 个） |
| **原生模块** | ① `onnxruntime-node@1.21.0`：**prebuilt** 二进制（`.node` + `.dll`），不走 node-gyp 编译，但必须 `asarUnpack`；② `@huggingface/transformers@3.8.1`：**必须打 patch**（`patches/@huggingface+transformers+3.8.1.patch`，3 972 B，修 `cache_position`），`postinstall: patch-package`；③ `sharp` / `@napi-rs/canvas`：prebuilt，是 `pdf-parse`/`mammoth` 的传递 optional 依赖；④ `node-gyp` 在锁文件里但**仅作为传递依赖存在**（无项目自身 addon 编译） | 🟡 **两个维护雷**：patch-package 补丁 + "禁止升级 transformers 到 4.x"（`engine.ts:7-9` 明写）。**好消息是没有 cmake-js / node-gyp 自编 addon** —— 这点比 project-raven（GStreamer + cmake-js）干净一个量级 |
| **Electron 版本** | **41.1.1**（devDependency 精确锁定） | 🔴 与 `05` ADR 实测的 **33.4.11** 差 8 个大版本 → 见 §5.3 |
| **FunASR sidecar 分发** | **不随安装包**（README 明确 "the installer ships neither"）。用户需自备：conda + **Python 3.10** + `torch==2.11.0 (cu128)` + `funasr==1.3.14` + `modelscope` + `websockets` + `numpy`（`requirements-funasr.txt`），实测环境 **3–5 GB**；模型首跑自动下载 **paraformer ≈880 MB / Nano ≈1.7 GB / MOSS ≈1.7 GB**；本地 Whisper 需手动放 `whisper-large-v3-turbo-ONNX`（`encoder_model_fp16.onnx` + `decoder_model_merged_quantized.onnx`，**≈1.5–1.7 GB**，`README.md:165`） | 🔴 **这是本评估里最大的产品级风险，比许可证大得多** |
| 安装包体积 | `docs/user/INSTALL_WINDOWS.zh-CN.md:15`："安装版约 **400 MB**；使用本地转写还需为模型预留 1–2 GB" | 🟡 可接受（Electron 基线 + onnxruntime） |

**结论与处置建议（M1 的关键取舍）：**

> **M1 不做本地 sidecar，默认走云 ASR（DashScope `fun-asr-realtime` 流式，或用 `cloudEngine` 的单次模式）。**
>
> 理由不是技术偏好，是用户门槛：目标用户是"正在面试的求职者"，让他先装 conda、装 CUDA 版 torch（3–5 GB）、再等 880 MB–1.7 GB 模型下载 —— 这个转化率是零。而 `aliyunRealtimeEngine.ts` 已经把流式链路写完了，云侧只需要一个 key，首字延迟比本地 DML 更稳（本地还有显存不足回退 CPU 的性能悬崖）。
>
> sidecar 的代码**保留但不默认启用**（"高级选项：完全离线"），把"离线隐私"作为可选卖点而不是默认路径。
>
> 若将来一定要默认离线：**不要走 FunASR/python**，换 `sherpa-onnx` 或 `whisper.cpp`，中文 paraformer ONNX 量化后 20–40 MB，可随安装包分发，无 Python 依赖。这一步与"借代码"不冲突 —— `AsrEngine` 三态契约换个实现即可（这正是 `contract.ts` 那句 "Frozen interface so the engine is swappable" 的价值）。

**验证方法（各 30 分钟，可在 M1 第一天做）**：
1. `npm ls --omit=dev --all` 在临时目录跑一次，确认生产依赖树实际大小（**本次未验证：按任务要求未安装依赖**）。
2. `node -e "require('onnxruntime-node')"` 在 Electron 41 的 ABI 下加载一次（**未验证**；若我们采用云 ASR 则不需验）。
3. 云 ASR 端到端：用 `tools/asr-harness.mjs` 喂 `resources/test-audio/zh.wav`，看到 segment 即通过。
4. sidecar 加分项：`netstat -ano | findstr 10097` 确认端口复用逻辑不会误杀别人进程。

### 5.3 风险 c · 与魔方简历共存（`05` ADR 的落地复核）

**先纠正一个前提：不存在"两个 Electron 应用"。** 已核实 `_ref/mr/package.json`：`name: magic-resume`、`version: 2.0.12`、`react ^18`，**没有 electron 依赖**。魔方简历是 TanStack Start 的 Web 应用，按 `05` 的方案 A 以 `ELECTRON_RUN_AS_NODE=1` 起 `server.mjs` 子进程 + `WebContentsView` 加载 `127.0.0.1:46800`。所以真实的"合并"只有一处：**Electron 版本单点 + 主进程资源冲突**。

| 冲突点 | 具体 | 取舍 |
|---|---|---|
| **Electron 版本** | MeetingCopilot 锁 **41.1.1**；`05` §2.7/§6 R1 的实测是 **33.4.11（内置 Node 20.18.3）**。41 的内置 Node 是 22/24 线 | 🔴 **必须重跑 `06` §4 的四条探针**（`/zh` 200、`/app/dashboard`、`/api/models` POST、字体流）。**未验证**：无法在本次只读分析中安装 Electron 41 验证。**建议**：锁 41.x（跟随基座，因为 onnxruntime-node 1.21 与新 ABI 的兼容性未知，降版本风险更大），把"魔方简历在 41 下能否跑"作为 M1 第 0 天的门禁 |
| `app.setName` / `userData` | `main.ts:99` `app.setName('MeetingCopilot')`；`userData` 决定 settings/sessions/models 路径 | 改成我们自己的；`<userData>/magic-resume/<version>/` 独立子目录（`05` §2.8 已设计） |
| **`session.defaultSession.setDisplayMediaRequestHandler`** | `main.ts:531-541` 挂在**全局 defaultSession** 上：任何 window/WebContentsView 调用 `getDisplayMedia` 都会被静默应答 `sources[0] + loopback`（用户看不到选择器） | 🔴 **安全级问题**：合并后魔方简历页面（第三方 SSR 应用）若调用 `getDisplayMedia`，会被我们无提示授权。**必须改挂 `session.fromPartition('persist:capture')`，只给浮窗用** |
| `requestSingleInstanceLock` | `main.ts:105-109`：拿不到锁就 `app.quit()` | 与 `05` §2.3 一致，保留；但 `second-instance` 要把"简历窗"也一起带到前台 |
| `globalShortcut` | `main.ts:318-334`：`Control+B`（隐藏/呼出）、`Control+Shift+S`（截图问答） | `Control+B` 在很多编辑器里有含义；截图问答（A13）删掉后 `Control+Shift+S` 空出来。建议改为 `Ctrl+Alt+H`（`09` §8 的锁定值），并做"注册失败静默降级"（已有 `console.warn`） |
| `asarUnpack` / 体积 | 基座要求解包 `@huggingface/transformers` + `onnxruntime-node`（数百 MB）；魔方简历要 112 MB `dist` + 生产 `node_modules` | 若采用 §5.2 的"M1 走云 ASR"，**这一整块解包与补丁可以不要**，包体回到 Electron 基线 + 112 MB |
| `WebContentsView` vs `BrowserWindow` | —— | **取舍见下** |

**WebContentsView 与 BrowserWindow 的取舍（结论）**

| 用途 | 选型 | 理由 |
|---|---|---|
| 浮窗（思路卡） | **`BrowserWindow`**（transparent / frame:false / alwaysOnTop:'screen-saver' / skipTaskbar / `setIgnoreMouseEvents(true,{forward:true})`） | 透明 + 点击穿透 + 置顶只有顶层窗口能做。**`WebContentsView` 不能透明、不能穿透、不能独立置顶**，它只是挂在一个宿主窗口 contentView 里的子视图 |
| 魔方简历编辑器 | **独立 `BrowserWindow` + `loadURL('http://127.0.0.1:46800')`**，不用 `WebContentsView` | `05` 当初用 WebContentsView 是为了"在同一个窗口里叠两个视图"，但那需要"浮窗里嵌简历"这个前提 —— 而浮窗只有 260px 高（`10` §4），嵌不下编辑器。既然简历要独立开窗，直接用 BrowserWindow 更简单：可以有自己的标题栏、可以最大化、`will-navigate` 拦截照旧 |
| 若 M2 要做"浮窗内嵌简历缩略" | 那时再引入 `WebContentsView` 挂在浮窗上 | 届时要接受"该视图不透明"，用 `setBackgroundColor('#00000000')` + CSS 半透明兜底（**未验证**） |
| 采集 | **必须在浮窗的 renderer 里**，且 `getDisplayMedia` 需要 user gesture | 不能放到不可见窗口或主进程 |

---

## 六、结论：三选一

### 6.1 三案成本对照（人日，含 M1 的 A/B/C/D 四段）

| 工作包 | **A. fork 改造** | **B. 借代码不 fork**（推荐） | **C. 完全自研** |
|---|---:|---:|---:|
| 建仓 + workspace 骨架 | 1 | 1 | 1 |
| 剥离上游渲染层（6.1k 行）+ 反隐身 + 逆提示词 | **6**（含 34 项清单里 A/B/C/E 的 20 项） | **0.5**（不用删，只挑文件） | 0 |
| 采集 + ASR 接线（loopback/worklet/VAD/worker/sidecar） | 0（已有） | **2.5**（把 2 300 行搬进来 + 写 preload/IPC 约 300 行） | **12**（重走 loopback 形状、worklet 静音路由、DML 挂死、VAD 调参） |
| 双端仲裁（D1–D8） | **5** | **5** | **5** |
| 思路卡引擎（prompt + 校验器 + 渲染，`10` 全套） | 3.5 | 3.5 | 3.5 |
| 打包 / 云 ASR / 密钥 / 首次引导 | 3 | 2.5 | 3.5 |
| upstream 跟踪（每次发版合并） | **+1~2/次（持续成本）** | 0（一次拷贝，之后是我们自己的） | 0 |
| **M1 合计** | **18.5–19.5** | **14.5–15**（乐观 13） | **25–27** |
| 风险特征 | 剥离中途发现"某功能其实藏在 main.ts 深处"；合并地狱 | 需要自己写 300 行接线，但每一行都懂 | 重复踩已知的坑（loopback/Worklet/DML/VAD），但完全自主 |

### 6.2 决策：**B. 借代码不 fork**

四条理由，按权重：

1. **fork 的唯一收益是"一个能跑的壳"，而那个壳正是我们必须扔掉的 6 100 行。** 940×560 双栏提词器 UI、五步 BYOK 向导、截图问答、隐身开关 —— 我们一样都不要。花 6 人日删掉，再花 1–2 人日/次跟上游，只为保留 2 300 行本来可以直接拷贝的代码，账算不过来。
2. **34 项剥离里 19 项是"改造"，而改造要顺着原作者的假设改。** 举例：`capturing` 是 `main.ts` 里的一个闭包变量，被托盘刷新、预热定时器、诊断报告三处读；要把它改成 `Map<sourceId, State>`，你得同时改 4 个文件。而在我们自己的仓库里，这个状态从一开始就是对的。
3. **`07` 的"最值得直接 fork"是在没数代码前写的。** 现在数完了：111 个文件里只有 18 个能原样留。同时 `05` ADR 已定"魔方简历以子进程内置"、`09` 已定"不做隐身卖点"、`10` 已定"思路卡协议" —— 这三份文档定义的壳，与上游的壳没有一处重合。**fork 一个壳然后把它掏空，不如直接造壳。**
4. **借代码完全合法且干净。** Apache-2.0 明确允许"取部分代码进自己的项目"，义务只有三条（保留 LICENSE / 标注修改 / 不蹭商标），比 fork 更轻 —— fork 你还得处理它的 CI、issue 模板、README、docs 里的隐身文案（A11）。

**保留的反悔条款**：若 M1 第 3 天发现"采集链路跑不通"，允许把 `_ref` 整包 fork 出来做对照实验（只读，不进主仓）。这是排查手段，不是架构。

### 6.3 落地形态（借代码后的仓库结构）

```
面试副驾/                         （pnpm workspace，Apache-2.0）
├─ packages/core/                 纯 TS，零 Electron 依赖 ← Android 也用它
│   ├─ hint/                      思路卡：prompt + HintCard + validate（10 号文档）
│   ├─ resume/                    ResumeDigest 生成（05 §5.4）
│   ├─ arbiter/                   采集仲裁状态机（D3/D4）
│   └─ protocol/                  双端消息（含 sourceId/seq）
├─ packages/asr/                  ★ 借来的 2 300 行，Node-only
│   ├─ contract.ts    (改：+sourceId/+seq)        ← 上游 asr/contract.ts
│   ├─ vad.ts         (原样)                       ← 上游 asr/vad.ts
│   ├─ langRouter.ts  (原样)
│   ├─ engine.ts      (原样；若不上本地 Whisper 则只留接口)
│   ├─ wav.ts / wavRead.ts (原样)
│   ├─ worker.ts      (改：sessionId 维度)
│   ├─ cloudEngine.ts / aliyunRealtimeEngine.ts (原样)
│   ├─ host.ts        (改：AsrHost 多源)
│   ├─ funasrSidecar.ts (原样，默认不启用)
│   ├─ LICENSE-Apache-2.0.txt  + NOTICE
│   └─ __tests__/     ← 上游 test/{vad,wav,engine,langRouter,aliyunRt}.spec.ts 直接搬
├─ apps/desktop/                  Electron 41.x
│   ├─ main/{window,ipc,capture,llm,magic-resume}.ts
│   ├─ preload.ts
│   └─ renderer/audio/{loopback,mic}Capture.ts + pcm-worklet.js（原样）
└─ apps/mobile/                   Capacitor：只做采集 + 仲裁上报
```

**注意 `packages/asr` 不能进 `packages/core`**：`worker.ts` 依赖 `process.parentPort`（utilityProcess）与 `@huggingface/transformers`（Node ESM 动态 import），Android WebView 用不了。所以"三端共享"的边界划在 `core`，`asr` 只服务桌面。这条若划错，会在 M1 第三周返工。

### 6.4 人日与里程碑

| 里程碑 | 内容 | 人日 | 可验收标准 |
|---|---|---:|---|
| **M1-0 门禁** | 借代码入仓 + `asr-harness` 跑通云 ASR 一句话；Electron 41 下魔方简历探针 | 2 | 命令行喂 wav 出 segment；`/zh` 返回 200 |
| **M1-1 采集** | 浮窗壳（透明/穿透/置顶）+ loopback 采集 + worklet → IPC | 2.5 | 播一段中文视频，控制台每 100ms 出一帧、VAD 能切句 |
| **M1-2 ASR 落地** | `packages/asr` 接线 + 云流式 + 断流重连 | 2.5 | 首字延迟 < 1.2 s，10 分钟连续采集无丢句 |
| **M1-3 仲裁** | D1–D8（sourceId/seq/多源 host/去重） | 5 | 手机+桌面同时推流，字幕不重复、时钟不倒流 |
| **M1-4 思路卡** | prompt + 校验器 + 260px 渲染（`10` 全套） | 3.5 | 10 个真实问题 ×3 次盲评，可用性 ≥3 且零"可直读句" |
| **M1-5 打包** | 云 key 引导 + safeStorage + NSIS | 2 | 干净机器装完 5 分钟内能出第一张卡 |
| **合计** | | **17.5**（并行可压到 14–15） | |

---

## 七、下一步第一步（明天，半天可验）

**做一件事：证明"借来的 2 300 行能在我们自己的空仓库里独立跑起来"。**

```
1. 新建 面试副驾/（pnpm workspace），只建 packages/asr/
2. 从 _ref 拷入（不改 _ref）：
   electron/asr/{contract,vad,langRouter,engine,wav,wavRead,worker,cloudEngine,aliyunRealtimeEngine}.ts
   electron/asrHost.ts → host.ts
   tools/asr-harness.mjs + wav-to-f32.mjs
   test/{vad,wav,engine,langRouter,aliyunRt}.spec.ts
   LICENSE → LICENSE-Apache-2.0.txt（+ 自建 NOTICE）
3. 每个文件头加一行：Modified by 面试副驾 on 2026-10-27（Apache §4(b)）
4. npm i（只装 ws + vitest + tsx，不装 electron/onnxruntime —— 走云 ASR）
5. 用 asr-harness 喂 resources/test-audio/zh.wav，走 cloudEngine（DashScope 或 MiMo key）
```

**验收：** ① `vitest run` 里 vad/wav/langRouter 三个 spec 全绿；② harness 打印出 ≥3 条带 5 个时间戳的 segment；③ 全程没有 import 到 `electron`。

**这一步为什么必须先做**：它是整个"借代码"方案的唯一技术假设 —— *"这 2 300 行是 Node-only 的"*。若第 ③ 条不成立（比如 `engine.ts` 隐式依赖 Electron 的 fetch 或 path 解析），那么方案 B 的成本要 +3 人日，得当天就改判断，而不是等到 M1-2。

> 若这台机器正在被另一任务占用（构建中），此步**只做 1/3/4 的文件搬运，不跑 `npm i`** —— 搬迁与验证可以隔天分开。

---

## 附录 A · 未验证项（明确标注）

| # | 事项 | 为什么没验 | 建议验证方式 |
|---|---|---|---|
| 1 | Electron 41.1.1 下 `ELECTRON_RUN_AS_NODE` 起魔方简历 `server.mjs` 是否正常 | 需安装 Electron，与约束"不装依赖"冲突 | 复用 `06` 报告 §4 的四条探针 |
| 2 | 生产依赖树真实体积（`npm ls --omit=dev`） | 同上 | 临时目录装一次 |
| 3 | `onnxruntime-node@1.21.0` 在 Electron 41 ABI 下能否加载 | 同上；且若走云 ASR 则不需要 | `require` 一次 |
| 4 | `@huggingface/transformers` 补丁在 41 下是否仍需 | 同上 | 若不上本地 Whisper 则整链不引入 |
| 5 | `WebContentsView` 半透明背景是否能兜住（M2 才用） | 未实测 | M2 时做一个 30 行 demo |
| 6 | 云 ASR（DashScope fun-asr-realtime）中文首字延迟实测量 | 未联网、未持 key | 用 harness 跑 10 条真实提问录音 |
| 7 | `wavRead.ts`(78) / `diagnostics.ts`(247) / `providerTest.ts`(419) / `knowledge.ts`(46) / `sessions.ts`(37) / `tray.ts`(138) / 各组件内部实现 | **未逐行通读**（只读了导出面与被调用关系） | 若决定复用其中某个，需单独通读 |
| 8 | 上游是否有 issue 记录"某功能实际未完成" | 未查（禁止对外请求） | 发版前查 issues 关键词 stealth/loopback |

## 附录 B · 与本系列其他文档的关系

| 文档 | 关系 |
|---|---|
| `03 技术栈决策` ADR-003 | 本文 §5.2 的"sidecar 降级为可选"是 ADR-003 §"sidecar 的必要性: 中"的进一步落地 |
| `05 魔方简历接入 ADR` | 本文 §5.3 修正了它的一个隐含前提（"两个 Electron 应用"不存在），并给出 WebContentsView 的最终取舍 |
| `06 夜间实测报告` | §5.3 的 Electron 版本风险直接引用它的四条探针 |
| `07 同类项目调研` | **本文修正了它"最值得直接 fork"的结论**（§6.2 理由 3），并把它"省 16–18 人日"的估算细化到文件级 |
| `09 功能边界` | 本文 A 组 13 项是它"七件事"表的逐行落地（行号级） |
| `10 思路卡输出规格` | 本文 B 组是它的"反向工程"：把上游的提词器 prompt 逐条对到我们的规格上 |
