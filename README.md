# 面必过（job_bingo）

> 实时**思路提示**：根据对方的问题 + 你的简历，给出 2–4 条 ≤18 字的要点大纲。
> **不代答。** 你用自己的语言组织回答。红线由代码强制，不靠模型自觉。

当前版本：**v0.1.3 · M1 采集可用 + M4 复盘**（Windows 桌面端）

---

## 1. 运行

```bash
# 方式一：双击
start-job-bingo.bat

# 方式二：命令行
node tools/start.js
```

> ⚠️ 必须用 `tools/start.js` 启动，不能直接 `electron .`。
> 本机宿主会把 `ELECTRON_RUN_AS_NODE=1` 注入环境，Electron 会退化成纯 Node 运行，
> `require('electron')` 只返回路径字符串。启动器会显式清除该变量。

启动后：
- 屏幕**顶部居中**出现半透明浮窗（780×300，置顶、点击穿透、不抢焦点）
- 系统托盘出现图标，右键可开关各项
- 未配置 API Key 时，1.2 秒后自动推送一张演示卡

### 热键

| 热键 | 作用 |
|---|---|
| `Ctrl+Alt+H` | 显示 / 隐藏浮窗 |
| `Ctrl+Alt+M` | 鼠标穿透开关 |
| `Ctrl+Alt+K` | 打开设置与演练 |
| `Ctrl+Alt+↑/↓` | 浮窗不透明度 |

---

## 2. 三步用起来

1. **`Ctrl+Alt+K`** 打开设置 → 填 Base URL / 模型 / API Key（任何 OpenAI 兼容端点都行）
2. **导入简历** → 选择魔方简历导出的 JSON（或用任意 `ResumeData` 结构 JSON）
3. **演练** → 输入一个问题，点「生成思路卡」，浮窗立刻显示

想看自动效果：点浮窗区块里的 **「开始模拟采集」**，每 9 秒自动提一个面试问题并出卡。

### 流水线（pipeline）

所有输入源（手动、WS、未来的回环/麦克风采集）都汇流到
`packages/desktop/src/main/pipeline.js`，统一做四件事：

| 环节 | 作用 |
|---|---|
| 提问判定 | 疑问词 / 「继续」「具体」类追问才触发，避免把自己的回答当新问题 |
| 时间窗 | 2.2 秒内不重复出卡，防止 ASR 重复出字刷屏 |
| 相似度去重 | Jaccard > 0.72 视为同一问题跳过 |
| 上下文 | 保留最近 6 轮，送给 LLM 做消歧 |

`node --test tools/test/pipeline-test.js` —— 8 项全通过。
设置面板底部实时显示「收到 / 去重跳过 / 出卡」三个计数。

没填 Key 也能用：进入**演示模式**，返回结构完整的本地模板卡。

---

## 3. 手机端接入

启动后控制台/托盘会显示局域网地址：

```
ws://192.168.x.x:8787
```

手机端发：

```json
{ "type": "question", "text": "面试官刚才的问题", "history": [] }
```

桌面端生成思路卡并推送到浮窗。`{"type":"ping"}` 可测连通。

验证：`node tools/test/ws-test.js`

---

## 4. 目录结构

```
job-bingo/                      面必过 · 仓库与包名统一用 job-bingo
├─ packages/
│  ├─ core/                     三端共享内核（禁止 import 'electron'）
│  │  └─ src/
│  │     hint-card.js           思路卡契约 + 五道校验闸门 ← 不代答的技术保证
│  │     resume.js              简历 → 锚点索引 / 数字白名单
│  │     prompt.js              稳定前缀（KV cache 预热）+ 提示词
│  │     llm.js                 OpenAI 兼容网关 + 繁忙识别
│  │     review.js              复盘：问答配对 / 校验 / 本地规则兜底
│  │     index.js               generateHintCard / generateReview / warmup
│  ├─ asr/                      音频层（纯 Node，严禁 electron）
│  │  └─ src/
│  │     vad.js                 能量 VAD 分段器
│  │     echoGate.js            双轨回声门（回环 vs 麦克风，判「谁在说」）
│  │     roleVote.js            段归属投票（宁多一张卡，不丢一个问题）
│  │     wav.js                 WAV 编解码
│  │     cloudEngine.js         OpenAI 兼容转写客户端
│  │     mockEngine.js          离线假引擎
│  │     langRouter.js          中英路由
│  │     contract.js            引擎契约 + PCM 归一化
│  │     synth.js               合成测试音
│  └─ desktop/                  Windows 端
│     ├─ src/main/index.js      浮窗 / 托盘 / 热键 / 配置 / WS / 复盘 IPC
│     ├─ src/main/pipeline.js   统一输入层：提问判定 / 去重 / 全场记录
│     ├─ src/main/audio-capture.js  回环 + 麦克风双轨采集
│     └─ src/renderer/          overlay / settings / audio-capture
├─ tools/
│  ├─ start.js                  启动器（清 ELECTRON_RUN_AS_NODE）
│  ├─ test/                     测试：pipeline / asr-pipeline / busy-retry / e2e / ws
│  ├─ build/                    构建：prepare-dist / dist / 图标
│  └─ diag/                     诊断：回环自检 / 快照 / 截图
├─ docs/                        01–11 需求 / 架构 / ADR / 调研 / 规格
├─ start-job-bingo.bat          Windows 双击启动
└─ LICENSE / README.md
```

### 命名约定

| 层 | 取值 |
|---|---|
| 中文产品名 | 面必过 |
| 英文产品名 | **job_bingo** |
| 仓库名 / 目录名 | `job-bingo` |
| npm 包命名空间 | `@job-bingo/*` |
| Electron appId | `com.elvisloo.jobbingo` |
| 安装包 | `面必过-<版本>-x64.exe` |

> 为什么英文名和仓库名不一样：`_` 在 npm 包名与 Java 包名（appId）里不合法，
> 目录和仓库也用连字符更省事。对外展示用 `job_bingo`，技术标识统一 `job-bingo`。

## 5. 「不代答」是如何被强制的

提示词只是建议，**校验器才是法律**。每条要点必须过五道闸门：

| 闸门 | 拦截条件 | 理由 |
|---|---|---|
| `SENTENCE_END` | 有句末标点 。！？； | 有句号 = 可直接念出的句子 |
| `FIRST_PERSON` | 以「我」开头 | 同上 |
| `TOO_LONG` | 汉字 > 18 | 超长即成段 |
| `CONNECTIVE` | 含首先/其次/最后… | 连接词是成稿的骨架 |
| `NUMBER_NOT_IN_RESUME` | 数字不在简历原文里 | 治幻觉 |

外加：要点必须 2–4 条；`anchor.resumeId` 必须指向简历中真实存在的条目，
没有对应内容时强制显示「无直接对应」，不许硬凑。

未通过 → 带修正指令重生成，最多 3 次。实测：第 1 次成稿被拦、第 2 次通过。

```bash
node tools/test/mock-llm-server.js &   # 另开一个终端
node tools/test/e2e-test.js            # 输出 attempts=2 即为拦截生效
```

---

## 5.1 音频链路（M1 · 系统声音采集已可用）

**ASR 与 LLM 可以分开配置** —— 真实使用中你会分别选供应商（例如 ASR 用硅基流动、LLM 用 DeepSeek）：

```bash
# 设置面板第 1 节填 LLM；ASR 走 config.asr（未填则复用 LLM 的 baseUrl/Key）
node --test "packages/asr/**/*.test.js"     # ASR 层 62 项
node --test tools/test/asr-pipeline-test.js      # 音频→卡片端到端 8 项
```

### 双轨采集：为什么必须有麦克风轨

只听**系统混音**有一个致命缺陷：**你自己的声音也会从系统输出里回来**
（会议软件本地混音、扬声器漏音、或你共享了系统声音）。结果是——你在回答问题的过程中，
自己的每一句话都会被当成「面试官又提问了」，浮窗一张接一张地出无关的卡。

v0.1.1 起采集**两条轨**：

| 轨 | 来源 | 作用 |
|---|---|---|
| 回环 | `getDisplayMedia` + `audio:'loopback'` | 对方的声音（也含本地泄漏） |
| 麦克风 | `getUserMedia` | 判断「现在是不是我在说」 |

两条轨各自走独立的 VAD，分段后由 `packages/asr/src/echoGate.js` 判定归属：

```
回环 VAD ─┐
          ├─→ 回声门（逐 100ms 比较两路能量）→ 段归属投票 → role
麦克风 VAD┘                                             │
                                          them ─────────┴─→ 转写 → 出思路卡
                                          me   ───────────→ 转写 → 仅写入上下文
```

**判 me 的条件**（`DualTrackEchoGate`）：麦克风明显高于底噪（或高于 −45 dBFS），
且比回环高 4 dB 以上 —— 本地说话时麦克风贴近声源，能量天然强于回环，反之亦然。
判定带 600 ms 保持窗口，避免一句话内部逐字抖动。

**段归属投票**（`voteRole`）：取该段结束前几秒内瞬时判定的多数票，`me` 票需 ≥60%。
门槛之所以高于一半，是因为两类错误的代价不对称：

| 误判 | 后果 |
|---|---|
| 误判 them | 多出一张卡 —— 用户看得见，可以忽略 |
| 误判 me | **漏掉对方的一个问题** —— 用户当场答不上来 |

所以一律「宁可多一张卡，也不丢一个问题」：`unknown`／`silence`／没有麦克风轨时，
全部按对方处理。

**降级路径**：麦克风不可用（云桌面、虚拟声卡、被系统静音）时**不阻断采集**，
自动退化为单轨回环，采集窗口明确标注「退化为单轨（可能把自己的话当成问题）」。
这正是 v0.1 的行为，不会比之前更差。

### 一条命令验证

设置面板 → **「开始采集系统声音」** → 采集窗口显示三行关键状态：

```
系统音频：1 条（系统混音）
麦克风：1 条（用于区分谁在说话）
当前判定：像是对方在说（生成卡片） · 麦克风 -58 dB / 回环 -31 dB
```

再点「喂入测试音频」：3 段合成音经回环被重新采集 → VAD 切出 3 段（实测 `segs=3`）
→ 逐段转写 → 逐段出卡。这条链路已在本机实测通过。

### 模型繁忙自动退避（夜间免费额度必备）

官方限流（429/503/「繁忙」「拥挤」「overloaded」「rate limit」等）不会被当作失败丢掉，
而是**每隔 N 分钟自动重试**，直到成功、超过上限或你手动停止。

| 项 | 默认 | 位置 |
|---|---|---|
| 重试间隔 | **5 分钟** | 设置面板第 3 节可调（1–60 分钟） |
| 最长等待 | 60 分钟 | 同上（超时后报 `BUSY_TIMEOUT`） |
| 浮窗提示 | 黄点 + `04:32` 倒计时 | overlay 顶部状态条 |
| 随时叫停 | 「停止等待」按钮 | 设置面板第 3 节 |

**刻意区分两类重试**：`generateOnce` 里的重试是纠格式（校验不过 → 带修正指令再来），
外层的退避是等额度（繁忙 → 等 5 分钟）。鉴权错（401）、配置错（返回 HTML）**不进入退避**，避免白等。

一键验证完整链路：设置面板 → **「喂入测试音频」**
（合成 3 段语音 → VAD 切分 → 逐段转写 → 逐段出卡）。

| 环节 | 参数 |
|---|---|
| 采样率 | 16 kHz / 16 bit / 单声道 |
| VAD | 动态门限 `max(0.004, 噪声底×3)`，hangover 300ms，最短段 250ms，最长段 10s，前置缓冲 300ms |
| 转写 | OpenAI 兼容 multipart，`name="file"; filename="segment.wav"` |
| 降级 | 云失败自动降级本地 mock，`degradedFrom='cloud'` |


### 复盘（v0.1.3）

采集过程中所有问答都会进一份**不裁剪**的全场记录（`pipeline.transcript`，
`history` 只留 6 轮供消歧，两者分开）。点「生成复盘」后：

```
全场记录 → 问答配对 → 模型点评（带校验）→ Markdown → 文档/面必过复盘/复盘-YYYY-MM-DD-HHmm.md
                     ↘ 校验不过 / 没配 Key → 本地规则引擎
```

**三条硬约束**（都在 `packages/core/src/review.js`，不是提示词里的劝告）：

| 约束 | 代码保证 |
|---|---|
| 不编造 | 点评里的数字必须能在问答原文或简历里找到，否则整条丢弃 |
| 有据可回 | 每条点评必须带 `quote`，且 quote 必须**原样出现**在记录里 |
| 可降级 | 没 Key 或模型失败 → 本地规则给结论（字数 / 数字密度），不给空白页 |

本地规则引擎只下**可验证**的判断：回答 <20 字 → 「撑不起完整的例子」；
有长度但无数字 → 「结果不可验证」。朴素，但不会误导人。

## 6. 已实现 / 未实现

**已实现（M0 + 部分 M1）**
- 半透明置顶浮窗：点击穿透、不抢焦点、不占任务栏、Win11 亚克力（Win10 自动降级）
- 托盘菜单 + 4 组全局热键 + 不透明度调节
- 思路卡生成 / 校验 / 重试 / 渲染（整卡淡入，无打字机）
- 简历锚点索引 + 数字白名单
- 稳定前缀 + `max_tokens=1` 缓存预热
- **VAD 分段 + WAV 编解码 + 云 ASR 客户端 + 离线降级**
- **系统声音回环 + 麦克风双轨采集**，回声门防自我触发，麦克风缺失自动降级
- **电平取自采集帧本身**（不用 AnalyserNode 旁路），回声门能读到真实 dB
- **统一流水线**：提问判定 / 2.2s 时间窗 / 相似度去重 / 6 轮上下文
- 配置持久化、单实例锁、手机端 WS 通道
- 设置与演练面板（JD、模拟采集、喂入音频、实时计数）

**未实现（后续里程碑）**
- ✅ **Windows 系统声音回环采集**（AudioWorklet + PCM，已实测切段）
- ✅ **双轨回声门**：麦克风轨判定「谁在说」，我方语音只进上下文不出卡
- 手机端作为第二路的采集仲裁（当前手机端只上传文本 / 显示卡片）
- 魔方简历进程托管与内嵌（M3）
- Android 端 Capacitor（M2+）
- ✅ **复盘（M4）**：逐条点评 + 下一步；教练式追问（Coach）未做

## 6.1 测试

```bash
npm test        # 178 项全绿
npm run e2e     # core 端到端：成稿拦截 + 重试（自包含，无需先起服务）
npm run ws      # 手机通道冒烟（应用未运行时自动跳过）
```

---

## 7. 边界（写进代码，不只是写进文档）

- 只输出要点，不输出成稿 —— 由 `packages/core/src/hint-card.js` 强制
- 不做语音代答、不做隐蔽采集、不规避任何检测
- 「复盘录制」下的内容保护**默认关闭**，用途是防止草稿被录进复盘视频
- 音频仅在本机处理与转写；是否告知对方由你决定，软件不替你隐瞒

---

## 7.1 打包

### Windows（EXE）

```bash
npm run dist:win
```

产出两个文件（在 `dist/`）：

- `面试副驾-0.1.0-x64.exe` —— NSIS 安装版（可选安装目录、建桌面快捷方式）
- `面试副驾-0.1.0-x64-便携版.exe` —— 免安装，双击即用

> 打包前 `tools/build/prepare-dist.js` 会自动把 workspace 软链实体化
> （软链不会被可靠地打进 asar）。若构建机器访问 GitHub 慢，
> 设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

### Android（APK）

需要 JDK 17 + Android SDK（platform-tools / platforms;android-34 / build-tools;34.0.0）。

```bash
cd packages/mobile
npm install
npx cap add android          # 首次，生成 android/ 工程
npx cap sync android         # 每次改完 www/ 后同步
cd android && ./gradlew assembleDebug
```

产出 `android/app/build/outputs/apk/debug/app-debug.apk`。
Gradle 官方源不通时，把 `gradle/wrapper/gradle-wrapper.properties` 的
`distributionUrl` 换成 `https://mirrors.cloud.tencent.com/gradle/gradle-8.2.1-all.zip`。

手机端两种用法：
1. **采集端**：按住录音 → 16kHz WAV → 通过 WS 发给电脑端转写出卡；
2. **第二屏**：连上电脑后，电脑生成的思路卡实时推送到手机显示。

## 8. 第三方代码声明

- 本项目的 ASR 层规划参考并拟复用 `MeetingCopilot`（Apache-2.0）的部分实现，
  复用文件将保留原始许可声明并标注修改（Apache §4）。
- 「魔方简历」(magic-resume, Apache-2.0 + 附加商业限制) 以**运行时托管**方式接入，
  不 fork、不改其源码；本项目非商业、不接受商业植入。

---

## 关于本仓库

**它做什么**：在你回答面试问题时，根据对方刚提出的问题 + 你自己的简历，
给出 2–4 条**不超过 18 字**的要点大纲，帮你说得更完整、更有结构。

**它不做什么**（写进代码，不只是写进 README）：

| 不做 | 代码层面的保证 |
|---|---|
| 不代答、不给成稿 | `packages/core/src/hint-card.js` 五道闸门：有句号 / 以「我」开头 / 超 18 字 / 含「首先其次」/ 数字不在简历里 —— 任何一条命中即拦截重生成 |
| 不做隐蔽采集 | 采集窗口始终可见，并实时显示「系统音频 / 麦克风 / 当前判定」 |
| 不规避任何检测 | 无 stealth 分支，正文不出现「对方发现不了」这类宣称 |
| 不伪造经历 | 要点里的数字必须能在简历原文中找到，否则拦截 |

**一句话产品立场**：这是「小抄 / 笔记」，不是「替身」。
最终怎么说、说不说，都是你的事。

### 它和其他面试工具的区别

市面上多数面试 Copilot 的核心卖点是「不被发现」，于是重心全在隐身与反检测上。
本项目反过来：**把力气放在「判得准」和「不越界」上**。

- **判得准**：双轨回声门（回环 vs 麦克风能量）区分「谁在说」，
  你自己的回答不会被当成新问题反复出卡 —— 这是只听系统混音时必然踩的坑。
- **不越界**：只给要点，不给成稿，红线由校验器强制而非模型自觉。

### 技术栈

Electron 33 · 纯 CommonJS · 无原生模块 · 本地优先（音频只在你自己的机器上处理）

```bash
npm install
npm test        # 178 项
npm run e2e     # 成稿拦截 + 重试
npm run dist:win
```

### 许可

MIT。`packages/asr/` 基于 MeetingCopilot（Apache-2.0）重写，详见 LICENSE。
