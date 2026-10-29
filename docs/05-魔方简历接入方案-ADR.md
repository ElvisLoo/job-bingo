# 05 · 魔方简历接入方案（ADR）

- 状态：**已定稿（Accepted）**
- 日期：2026-10-26
- 决策人：项目 owner（本文基于 2026-10-26 夜间实测，数据见 `06-夜间实测报告.md`）
- 关联文档：`01 需求规格`、`03 技术栈决策记录`、`04 源码研读笔记`、`09 功能边界`、`10 思路卡输出规格`
- 一句话决策：**采用方案 A —— 把魔方简历的构建产物作为「内置本地服务」由 Electron 子进程托管，`WebContentsView` 加载 `http://127.0.0.1:<固定端口>`；上游源码零修改。**

---

## 一、三方案实测对比

对比前提：同一份 `_ref/mr` 副本、同一台机器、同一晚（23:00–23:40）。「实测」列的数字全部来自 `06` 报告，未测的写「未验证」。

| 维度 | **A. 内置服务进程**（`ELECTRON_RUN_AS_NODE` 起 `server.mjs` + `WebContentsView` 加载 127.0.0.1） | **B. SPA 化改造**（改构建出纯静态包 + 自定义协议） | **C. 直接嵌官网**（`WebContentsView` 加载 magicv.art） |
|---|---|---|---|
| **是否改上游源码** | **否**（实测全程未改 `src/`） | **是**（要改 vite 配置、注入静态导出、重写 `/api/*` 网关） | 否 |
| 构建可行性 | ✅ 实测通过，`pnpm build` 80 s / 74 s 两次成功 | ⚠️ 未实测；TanStack Start SSR 应用要改成 SPA 需替换 `createFileRoute` 的 server handlers，**属于二次开发** | 无需构建 |
| **Electron 内置 Node 能否托管** | ✅ **实测通过**：Electron 33.4.11（内置 Node 20.18.3）下 SSR / API / 字体全正常，常驻 102.5 MB | 不适用（无服务进程） | 不适用 |
| 产物体积 | **112.0 MB**（裁字体后；含 `dist/server` 2.2 MB） | 未验证（估 110 MB 量级，去掉 server 端） | **0 MB**（我们侧） |
| 额外运行时依赖 | **需要生产 `node_modules`**（`dist/server/*.js` 有裸 import：react / @tanstack / @heroui / @tiptap / @radix-ui）。实测 `node_modules` 全量 951 MB，生产集**未验证**；剔除 sharp/puppeteer/@sparticuz（约 200 MB）后可显著下降 | 不需要（纯静态） | 不需要 |
| 冷启动 | **监听 0.77–0.97 s**；**首屏 SSR 5.1–7.0 s**；热路径 **13–22 ms** | 未验证（理论上 <1 s） | 取决于外网（未验证） |
| 常驻内存 | **131–138 MB**（WorkingSetSize 中位，外部 `wmic` 测量） | 未验证 | 同样吃 WebView 内存，但无服务进程 |
| 功能完整度 | ✅ 全部可用（实测 `/zh` `/app/dashboard` `/api/models(POST)` 字体流 全部正常） | ❌ 服务端接口全废，需自己重写 AI 网关、简历导入、校徽代理 | ⚠️ 功能全在，但**数据在别人域名下**，我们读不到 |
| 数据可达性 | ✅ 同源 `http://127.0.0.1:PORT` → 可直接 `executeJavaScript` 读 `localStorage["resume-storage"]` | ✅ 同源（自定义协议）也可读 | ❌ **跨域**，localStorage 在 `magicv.art` 下，Electron 主进程和我们的渲染进程都读不到 |
| 离线可用 | ✅ 完全离线（字体、模板快照、JS 全本地） | ✅ | ❌ 断网即废 |
| 崩溃隔离 | ✅ 子进程崩了不拖垮主进程，可重启 | ✅ 无子进程（但也就没有隔离收益） | ✅ |
| 升级成本 | **低**：换一个 `dist` 目录 + `node_modules` 快照 | 高：每次上游发版都要重放改造 | 零（但等于把产品命脉交给人家） |
| 许可证风险 | 🟢 **最干净**：运行时托管、源码未改、可完整署名 | 🟠 **高**：条款 3 明确禁止"二次开发并用于商业运营"，非商业虽可解释，但破坏了"未修改"这个最有利的事实 | 🔴 **最高**：等于蹭服务，且违反条款 1 的"平台引流"精神 |
| 工程复杂度 | 中（进程生命周期 + 端口 + 健康检查） | 高 | 低 |
| 体面程度（对作者/用户） | 🟢 清楚标注"内置魔方简历" | 🟠 改造成我们的东西，容易被看成 fork | 🔴 最差 |

### 决策

**选 A。** 三个理由，按权重排：

1. **法律位置最优**：不改一行源码 = 永远站在"个人非商业使用 + 原样分发"这一侧；B 一旦改造就落入"二次开发"的射程，将来任何商业化尝试都要重做一遍合规。
2. **功能不缩水**：`/api/polish`、`/api/grammar`、`/api/resume-import`、`/api/school-logos`、SSR、字体全在原位，实测全部可用。B 要把这些全部重写，等于重做一个 AI 网关。
3. **升级便宜**：上游发版我们只换目录，不动代码。B 每次升级都是一次合并地狱。

代价我们也认：
- 包体 +112 MB（产物）+ 生产 `node_modules`（未测，需在打包阶段压到 100 MB 级）
- 冷启动 5–7 s（可用骨架屏 + 提前 spawn 吃掉，见 §2.5）
- 多一个进程要管（§2 全部在解决这件事）
- **C 方案被否的硬理由不是体面，是"数据拿不到"**——思路卡必须锚定 ResumeData，跨域 localStorage 让我们连门都进不去。这一条就足以淘汰 C。

---

## 二、进程管理方案（方案 A 的工程细节）

### 2.1 总体结构

```
面试副驾（Electron 主进程）
├─ BrowserWindow (主窗，透明置顶浮窗)         ← 采集音频 / 思路卡渲染
├─ WebContentsView (魔方简历)                 ← 加载 http://127.0.0.1:46800
└─ child_process.spawn(electron.exe, ["server.mjs"], { env: { ELECTRON_RUN_AS_NODE: "1", PORT, HOSTNAME: "127.0.0.1" } })
     cwd = <userData>/magic-resume/<version>/
     ├─ dist/            （112 MB，实测）
     ├─ server.mjs       （上游原样）
     └─ node_modules/    （生产依赖快照）
```

关键：**子进程用 `process.execPath` 起（即 Electron 自身 + `ELECTRON_RUN_AS_NODE=1`），不额外打包 node。** 若兼容性验证失败才退到便携 Node（§2.7）。

### 2.2 端口：固定，且必须固定

**为什么不能随便换个空闲端口**：`localStorage`、`IndexedDB`（简历正文 + 文件句柄）都是**按 origin（含端口）隔离**的。端口变了 = 用户的简历全部"消失"。这是本方案最容易踩的坑。

策略：

```
首选端口：46800（写死在代码里，不随机）
探测顺序：
  1) GET http://127.0.0.1:46800/zh  → 200 且响应头 x-app: magic-resume（我们自己加不了响应头，
     因为不能改源码）→ 改用「探测 /zh 返回 200 且 body 含 <title>Magic Resume」判定是自己的实例
  2) 是自己的实例（上次残留）→ 直接复用，不再 spawn
  3) 不是自己的实例（被别的程序占）→ **不换端口**，先尝试优雅失败：
     a. 弹一次"端口 46800 被 <进程名> 占用"提示，给两个选项：结束占用进程 / 本次改用 46801（临时，数据另存）
     b. 选 46801 时，把 46800 的 localStorage 快照通过 executeJavaScript 读出 → 在 46801 写入 → 保证数据不丢
```

这样既保证 99% 情况下 origin 稳定，又不会因为端口被占直接白屏。**临时端口的迁移逻辑必须实现，否则宁可报错也别静默降级。**

### 2.3 单实例

```js
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }               // 第二个实例直接退出
app.on("second-instance", () => { /* 聚焦已有窗口 + 把简历面板带到前台 */ });
```

注意：**用 Electron 的 `requestSingleInstanceLock`，不要用文件锁/端口占用来判断单实例**——子进程可能被上次异常退出留下（僵尸），端口判断会误判为"已有实例"而拒绝启动。

### 2.4 健康检查与就绪信号

- **就绪判定**：轮询 `GET /zh`（**不要用 `/api/models`，它只注册了 POST，GET 会返回 200 的 HTML 外壳**，会把"路由没崩"误判成"服务可用"，实测踩过）。
- 判定条件：`status === 200 && body.includes("Magic Resume")`。
- 轮询节奏：从 spawn 起每 120 ms 一次，上限 **12 s**（实测需 0.77–0.97 s 可连、5–7 s 首屏可用）。
- **两段式放行**：端口一通（≈0.8 s）就 `loadURL`，让浏览器自己去等 SSR；不要等 SSR 完成才加载窗口。这样用户看到的是"窗口已经出来、内容在加载"，而不是"点了没反应 6 秒"。

### 2.5 冷启动体验（实测数据的直接用法）

| 阶段 | 实测 | 我们怎么做 |
|---|---|---|
| spawn → listen | 0.77–0.97 s | `app.whenReady()` **立刻** spawn，与 `createWindow()` 并行，不串行 |
| listen → 首屏 HTML | 5.1–7.0 s | WebContentsView 先加载一个**本地骨架屏 HTML**（0.1 s 出图），SSR 好了再切 URL；或直接 loadURL 并让 Chromium 显示 loading 态 |
| 后续请求 | 13–22 ms | 无感 |

**建议**：简历面板不是进入面试就必须打开的。启动时只"预热"（spawn + 探活），用户第一次点"简历"时才 `loadURL` —— 那 5–7 s 就发生在用户做别的事的时候。

### 2.6 崩溃重启

```js
let restarts = [];
child.on("exit", (code, signal) => {
  if (quitting) return;                       // 主动退出不重启
  const now = Date.now();
  restarts = restarts.filter(t => now - t < 60_000);
  if (restarts.length >= 3) {                 // 60 s 内崩 3 次 → 熔断
    showFallbackUI("简历模块启动失败", { retry: true, openLog: true });
    return;
  }
  restarts.push(now);
  setTimeout(spawnServer, [200, 500, 1500][restarts.length - 1]);
});
```

补充：
- **熔断后不再自动重试**，改为用户点"重试"（避免无限重启吃 CPU，用户面试中途风扇狂转比崩溃更尴尬）。
- 子进程 `stdio` 重定向到 `<userData>/logs/magic-resume.log`（滚动 5 个 × 2 MB）。**没有日志就没有归因**。
- Windows 退出清理：`before-quit` 里 `child.kill()`，并兜底 `taskkill /PID <pid> /T /F`（Electron 在 Windows 上 `kill()` 有时留孤儿）。

### 2.7 Electron 内置 Node：**实测通过**，退路保留

实测（`06` 报告 §4）：Electron **33.4.11** 内置 **Node 20.18.3**，`ELECTRON_RUN_AS_NODE=1 electron.exe server.mjs` 起服务后 `/zh`、`/app/dashboard`、`/api/models(POST)`、字体流全部正常，内存 102.5 MB，**无任何原生模块/ABI 报错**。

→ **默认走 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，不额外打包 node。**

退路仍然写在这里，因为 Electron 大版本升级（内置 Node 跳到 22/24）时可能要回来查：

```js
const NODE = path.join(resourcesPath, "runtime", "node.exe");   // 便携 Node 22 LTS
spawn(NODE, ["server.mjs"], { env: { PORT, HOSTNAME: "127.0.0.1" }, cwd });
```

| 项 | 退回便携 Node 的代价 |
|---|---|
| 包体 | +30~60 MB（`node.exe` 约 60 MB 未压缩） |
| 进程数/内存 | 多一个独立进程，内存 +约 40 MB（V8 基线） |
| 签名/杀软 | 多一个可执行文件要过 SmartScreen，用户可能看到"未知发布者" |
| 升级 | Node 版本多一条维护线 |
| 好处 | 与 Electron 版本完全解耦 |

### 2.8 升级替换（原子的）

```
<userData>/magic-resume/
├─ current.json          { "version": "2.0.12", "dir": "2.0.12" }
├─ 2.0.12/               ← 当前
└─ 2.0.13.tmp/           ← 下载/解压中的新版本
```

流程：解压到 `.tmp` → 校验（`dist/server/server.js` 存在 + `node_modules` 完整）→ 用**新目录另起一个临时端口**探活 → 通过则写 `current.json` 原子改名 → 重启子进程 → 失败则删 `.tmp`，保留旧版。**永远保留 N-1 一个版本**用于回滚。

---

## 三、字体裁剪清单

完整清单与字节数见 `06` 报告 §5。这里给结论与依据。

### 3.1 一个必须先纠正的认知

`src/utils/fonts.ts` 通过 `src/generated/resume-fonts.json` 把 **`.ttf/.otf` 文件名映射到 `/fonts/resume/*.woff2`**：

```json
"MiSans-Normal.ttf": "/fonts/resume/MiSans-Normal.07c198f1822a.woff2"
```

所以**根目录 149 MB 的 `.otf/.ttf` 是源字体/落地页素材，运行时根本不加载**；真正加载的是 `public/fonts/resume/*.woff2`（74.6 MB，10 个字族全覆盖）。`Document.tsx` 里那两个 `<link rel="preload">` 指向 `AlibabaPuHuiTi-3-55-Regular.ttf` / `-85-Bold.ttf`，是**预加载提示、不是渲染依赖**——但删了会产生 404 控制台噪音，为保持"零改动零噪音"，**保留**。

### 3.2 保留（不可删）

| 路径 | 体积 | 原因 |
|---|---|---|
| `public/fonts/resume/*.woff2`（10 个） | 74.6 MB | 运行时真正加载的字体；删了预览和 PDF 导出全崩 |
| `public/fonts/ui/*.woff2`（6 个 + OFL 授权文件） | 0.5 MB | UI 字体（Newsreader） |
| `public/fonts/AlibabaPuHuiTi-3-55-Regular.ttf` | 8.1 MB | `Document.tsx` preload 直引 |
| `public/fonts/AlibabaPuHuiTi-3-85-Bold.ttf` | 8.0 MB | 同上 |

### 3.3 删除（已实际执行，重建后功能正常）

`Source_Han_Serif_SC_Light_Light.otf`(23.0)、`NotoSansSC-Bold.otf`(16.2)、`NotoSansSC-Medium.otf`(15.8)、`NotoSansSC-Regular.otf`(15.7)、`NotoSansSC.ttf`(12.7)、`SourceHanSerifSC-Bold.otf`(11.5)、`SourceHanSerifSC-Medium.otf`(11.2)、`SourceHanSerifSC-Regular.otf`(11.1)、`MiSans-Normal.ttf`(7.7)、`MiSans-Medium.ttf`(7.7)、`public/fonts/landing/`(0.18)

**合计 139 225 504 B ≈ 132.8 MB。`public/fonts` 从 224.1 MB → 91.3 MB。**

### 3.4 裁剪后的验证结果

| 项 | 结果 |
|---|---|
| 重建 | ✅ 74 s 成功，`dist` 244.8 MB → **112.0 MB** |
| `/zh`、`/app/dashboard` | ✅ 200 |
| `/fonts/resume/*.woff2` | ✅ 200（4 188 508 B） |
| 被删的 `/fonts/MiSans-Normal.ttf` | 404（预期，代码无引用） |
| 字体选择器里逐个切换字体 | ⚠️ **未验证**（需 GUI 人工，静态分析指向 woff2，理论无影响） |

### 3.5 不建议裁的部分

- `template-snapshots`（9.1 MB）：模板真实缩略图，属于功能。
- `resume/*.woff2` 的二次子集化：能把 74.6 MB 压到 10 MB 以内，但需要**改字体加载链路**（触及源码），**不做**。真嫌大就接受 91 MB，这是"零改动"的定价。

---

## 四、许可证合规（Apache-2.0 + 附加商业限制）

原文要点（`_ref/mr/LICENSE`）：
1. 个人非商业（个人学习交流、做自己的简历）免费；
2. 未经授权禁止：① 作为 SaaS/PaaS/网站工具向公众提供并获利（收费、商业广告、平台引流）；② **嵌入、整合到其他商业软件、闭源产品或企业内部业务系统**；③ 二次开发（改名、改 logo、改代码、改功能）并用于商业运营。

### 4.1 我们的定位判定

| 情形 | 判定 |
|---|---|
| 「面试副驾」整体**开源 + 免费 + 无广告 + 不接受与功能绑定的付费** | ✅ 落在"个人非商业"范围内 |
| 收赞助（GitHub Sponsors / 爱发电） | 🟠 **灰区**：条款只列举"收费/广告/引流"，但"获取商业利益"是兜底表述。→ **赞助必须与功能完全解耦**，页面写死"赞助不换取任何功能、服务或优先支持，本项目全部功能永久免费" |
| 将来推出付费版 / 企业版 | ❌ **必须先取得作者商业授权**（Siyue，18806723365@163.com） |
| 我们改名换 logo 并内置 | 🟠 条款 3 针对"二次开发 + 商业运营"；非商业可解释，但**不要改名、不要删署名**，把风险降到零 |

### 4.2 四条硬约束（写进代码与发布流程）

1. **署名与 LICENSE 保留**
   - `<userData>/magic-resume/<version>/LICENSE` **原样保留**，分发时一并带上；
   - 「关于」页固定文案：
     > 内置 [魔方简历](https://magicv.art) © Siyue，Apache-2.0 + 附加商业限制条款。本项目未修改其源码，仅在本地以独立进程方式运行其官方构建产物。商业使用需另行取得原作者授权。
   - 仓库根 `NOTICE` 或 `THIRD-PARTY.md` 里登记：项目名、版本（v2.0.12）、上游地址、许可证、是否修改（**否**）。

2. **不 fork、不改源码（本 ADR 的第一原则）**
   - 我们的仓库**不包含** `_ref/mr` 的源码；
   - 构建脚本从上游 release/tag 拉取并构建，产物进 `resources/`；
   - 任何"想在它里面加个按钮"的念头，一律改成**在我们自己的 UI 上叠一层**（比如浮窗侧边条），不动它的 DOM。

3. **赞助与功能解耦**：赞助入口不得出现在魔方简历模块内部；不得以"赞助解锁 XX"表述。

4. **不触"嵌入闭源/商业产品"**：只要我们整体开源、源码可得，就不构成"嵌入其他商业软件或闭源产品"。**这条是我们必须维持开源的真正原因**——不是为了情怀。

### 4.3 发布前检查清单（建议做成 CI 一步）

- [ ] `LICENSE` 在分发目录内
- [ ] 「关于」页署名文案存在
- [ ] `THIRD-PARTY.md` 含上游版本号与"未修改"声明
- [ ] 发布包里没有 `src/`（只有 `dist` + `node_modules`）
- [ ] 包内无广告 SDK、无内购、无与功能绑定的赞助位

---

## 五、「魔方简历 → 面试副驾」数据交换契约

### 5.1 三条通路对比

| 通路 | 机制 | 优点 | 坑 | 采用 |
|---|---|---|---|---|
| **① localStorage 直读** | WebContentsView 与页面同源（`http://127.0.0.1:46800`），主进程 `view.webContents.executeJavaScript('localStorage.getItem("resume-storage")')` | 零用户操作、实时、拿到的就是最新编辑态 | ① **端口变了 origin 就变，数据"消失"**（§2.2 已处理）；② zustand persist 是异步 rehydrate，页面刚加载时可能读到 `null`；③ 只能读到"当前 origin 的那份" | ✅ **主通路** |
| **② 导出 JSON 文件** | 用户在应用里点"导出 JSON"（`exportResumeAsJson`，纯前端，`downloadTextFile` 触发下载）→ 我们 `will-download` 拦截或读下载目录 | 数据是"用户主动确认过的一份快照"，可版本化、可备份、跨设备 | 每次都要用户点；不能反映未导出的改动 | ✅ **备通路 + 首次引导** |
| **③ 目录同步（File System Access）** | 上游已有能力：`syncResumeToFile()` 把 `<title>.json` 写入用户选定的目录（句柄存 IndexedDB `FileHandleDB`），1.5 s 防抖 | 自动、用户无感、文件在磁盘上我们可直读 | 需要用户先授权一次目录；**重启后权限可能需要重新授予**；`showDirectoryPicker` 在 Electron 里的权限弹窗行为**未验证**；文件名用 `title`（改标题会留下旧文件，上游自己也会清，但并发时可能残留） | 🟠 可选增强（v2） |

**最终契约：①为主，②兜底，③当"高级用户"开关。**

### 5.2 读数据的正确姿势（伪代码）

```js
const STORAGE_KEY = "resume-storage";     // 上游 persist name，已核对源码

async function readResumeStore(view, { retries = 40 } = {}) {
  for (let i = 0; i < retries; i++) {
    const raw = await view.webContents.executeJavaScript(
      `window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)})`, true
    );
    if (raw) {
      const parsed = JSON.parse(raw);      // { state: { resumes: {}, activeResumeId }, version }
      const { resumes, activeResumeId } = parsed.state ?? {};
      if (resumes && Object.keys(resumes).length) {
        return {
          version: parsed.version,
          activeResumeId,
          resumes,                          // Record<id, ResumeData>
          active: resumes[activeResumeId] ?? Object.values(resumes)[0],
        };
      }
    }
    await sleep(250);                        // 等 rehydrate，最多约 10 s
  }
  return null;                               // → 走通路②，提示用户"先导出一份 JSON"
}
```

**三条必须写进代码的注意点**：
1. `resumes` 是 **`Record<string, ResumeData>` 而不是数组**（`PersistedResumeStore`），别按数组写。
2. 只能在**页面 `did-finish-load` 之后**读，且要重试（zustand 异步 rehydrate）。
3. 读到的是**全量多份简历**，我们只取 `activeResumeId` 那份；但"历史项目"可以让用户手动选另一份当锚定源。

### 5.3 用于"思路锚定"的字段路径清单

思路卡（见 `10 思路卡输出规格`）的「锚点」必须 100% 来自下列字段，不允许自由发挥。按重要性排序：

| 优先级 | 字段路径 | 类型 | 用途 |
|---|---|---|---|
| **P0** | `projects[].name` | string | 项目名，锚定"你在 X 项目里…" |
| **P0** | `projects[].description` | string（**含 HTML**，tiptap 富文本） | 讲做了什么、用了什么、结果如何。**思路卡的弹药主要来自这里** |
| **P0** | `experience[].company` | string | 公司名，锚定"在万金天宇…" |
| **P0** | `experience[].position` | string | 职位，决定话术身份 |
| **P0** | `experience[].details` | string（**含 HTML**） | 职责与业绩原文，最容易被追问的部分 |
| P1 | `basic.name` / `basic.title` | string | 自我介绍起手式、岗位匹配话术 |
| P1 | `experience[].date` / `projects[].date` | string | 时间线锚定（"2023 到 2025 那两年"） |
| P1 | `skillContent` | string（富文本） | 技能段落，用于"你简历里写了 VMware，追问虚拟机网络怎么配" |
| P1 | `selfEvaluationContent` | string（富文本） | 自我评价，用于态度类问题 |
| P2 | `projects[].role` | string | 你在项目里的角色（主导/参与），影响"用什么人称" |
| P2 | `education[].school` / `.major` / `.degree` | string | 学历追问 |
| P2 | `education[].startDate` / `.endDate` | string | 应届/工作年限推算 |
| P3 | `certificates[]`（`url` 是 base64 图片，**不要读**） | — | 有/无证书这一事实即可 |
| P3 | `publications[]`（可选字段，可能不存在） | — | 学术岗才用 |
| P3 | `customData` | `Record<string, CustomItem[]>` | 自定义段落（`title/subtitle/dateRange/description`） |
| — | `skill[]`（`{id,name,level}`） | **注意：ResumeData 里没有顶层 `skill` 数组**，技能是 `skillContent` 富文本 | 别写错 |
| — | `basic.photo` | base64 | **不读、不入库**（隐私） |
| — | `basic.email` / `basic.phone` | string | **默认不喂给 LLM**（除自我介绍需要时报出姓名） |

**两个过滤规则（很重要）**：
1. **只取"真的会出现在简历上"的内容**：遍历前先看 `menuSections[].enabled`（`order` 决定顺序），只处理 `enabled === true` 的段；`experience[]`/`projects[]`/`education[]` 还有各自的 `visible` 字段，`visible === false` 的条目**必须跳过**——否则会给用户提示一段他自己都隐藏了的经历，当场穿帮。
2. **富文本先转纯文本再喂模型**：`description` / `details` / `skillContent` 是 HTML。用 turndown 或简单的 `stripHtml` 转成纯文本，并**截断到每段 400–600 字**（一份简历全量约 3–8 KB，够用且省 token）。

### 5.4 建议的 `ResumeDigest`（送给思路引擎的最小结构，约 2 KB）

```jsonc
{
  "resumeId": "…", "updatedAt": "2026-10-26T…",       // 用来判断"简历改过了，缓存失效"
  "name": "罗广", "title": "信息化经理",
  "experiences": [
    { "company": "昆山万金天宇贸易有限公司", "position": "IT 负责人", "date": "2019/03 - 2026/09",
      "details": "（纯文本，≤600 字）" }
  ],
  "projects": [
    { "name": "ERP 库存成本异常定位", "role": "主导", "date": "2024/05",
      "description": "（纯文本，≤600 字）" }
  ],
  "skills": "（纯文本，≤400 字）",
  "selfEvaluation": "（纯文本，≤300 字）",
  "education": [{ "school": "…", "major": "…", "degree": "…", "date": "…" }]
}
```

这个结构由电脑端生成，**同步给 Android 端也只需要它**（这就是 `04` 里"手机端只读 2 KB 摘要"的落地形态）。

### 5.5 `exportResumeAsMarkdown` 怎么调

先给结论：**它不能直接在 Electron 主进程里 `require` 来用。**

原因：`exportResumeAsMarkdown({ resume, title, onStart, onEnd, successMessage, errorMessage, markdownOptions })` 内部走 `downloadTextFile` → `document.createElement("a").click()`，还调 `toast`（sonner）。**它是纯浏览器函数。**

三条可行路径：

| 路径 | 做法 | 评价 |
|---|---|---|
| **① UI 触发（零改源码，推荐）** | 在 WebContentsView 里用 `executeJavaScript` 点掉导出菜单，或让用户自己点；主进程用 `session.on("will-download")` / `webContents.session.on("will-download")` 拦截 `*.md`，`item.setSavePath(<我们的目录>)` 落盘后读取 | ✅ 完全合规（就是"用户在用这个功能"），实现最省事。**缺点**：依赖 DOM 结构（按钮文案/层级变了就得改选择器） |
| **② 复用纯函数（自己的进程里算）** | 直接把 `generateResumeMarkdown(resume, options)` 的**逻辑**搬进我们自己的代码（它的依赖是 `turndown` + `@/config` + `@/types`），在 Node 侧调用。注：`turndown` 自带 domino，**Node 里能跑**（不需 jsdom） | 🟠 可行但**引入了"复制上游逻辑"**，属于代码级复用，需在 `THIRD-PARTY.md` 明确标注来源与许可证；且上游改了排版逻辑我们不会跟上。**标记：本路径的可行性未实测** |
| **③ 自己写 Markdown 渲染** | 用 `ResumeDigest` 自己拼 | ✅ 最干净（我们只需要"给模型看的文本"，不需要和上游导出格式一致）。**推荐给思路卡用这一条** |

**最终选择**：
- **思路锚定** → 用 ③（`ResumeDigest` 自己拼，反正要截断和剥 HTML）。
- **用户想"导出我的简历为 md"** → 用 ①（把他的导出功能原样暴露，落盘到我们的目录）。

---

## 六、风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | `ELECTRON_RUN_AS_NODE` 实跑失败 | **已排除**（实测通过） | — | 已实测：Electron 33.4.11 / Node 20.18.3 全链路正常；退路见 §2.7 |
| R1b | Electron 大版本升级后内置 Node 变化导致不兼容 | 低 | 中 | 锁 Electron 主版本；升级时重跑 `06` §4 的四条探针 |
| R2 | 生产 `node_modules` 打包体积失控 | 中 | 中 | 打包时剔 `sharp/puppeteer/@sparticuz`（实测约 200 MB 无用）；`pnpm deploy --prod` 后复测 |
| R3 | 端口被占导致 origin 变化、简历"丢失" | 低 | **高** | 固定端口 + 复用探测 + 临时端口数据迁移（§2.2） |
| R4 | 用户以为这是我们的功能，出事找我们 | 中 | 中 | 「关于」页署名 + 首次打开时一行提示"简历编辑由内置的魔方简历提供" |
| R5 | 上游发版破坏兼容 | 中 | 中 | 锁版本 v2.0.12 + 升级走"另起临时端口探活"（§2.8）+ 保留 N-1 |
| R6 | 非商业承诺被后续商业化打破 → 许可证违约 | 中 | **高** | 把"整体开源 + 免费 + 无广告"写进 README 与 LICENSE 声明；商业化前先拿授权 |
| R7 | 面试场景下 6 s 冷启动被用户感知为"卡" | 高 | 中 | 提前 spawn + 骨架屏 + "用到才加载"（§2.5） |

---

## 七、明天动手的第一段代码（明确到文件）

**`electron/main/magic-resume/server-host.ts`**，约 150 行，只做四件事：

1. `spawnMagicResume()`：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`，`cwd = <userData>/magic-resume/<version>`，`PORT=46800`，`stdio` 写日志文件；
2. `waitForReady()`：轮询 `GET /zh`，条件 `200 && body.includes("Magic Resume")`，上限 12 s；
3. `ensureSingleInstance()` + 崩溃重启与熔断（§2.6）；
4. `killOnQuit()`：`before-quit` 里 kill + Windows 兜底。

**验收标准**（当天可验）：在这台机器上 `npm run dev` 后，Electron 窗口里能打开魔方简历，`netstat` 能看到 46800 被我们自己的进程监听，杀掉子进程后 200 ms 自动重启。

**这一段不写它，先写它 —— 因为 A 方案的全部不确定性都压在这 150 行里。** 数据契约（§5）可以放到第二步，它没有技术风险，只有工作量。

---

## 附录 A：给作者 Siyue 的说明邮件草稿（**尚未发送，等待人工确认**）

> **收件人**：18806723365@163.com
> **主题**：关于「魔方简历」在个人开源面试辅助工具中以本地进程方式内置的说明
> **状态**：草稿 / 未发送

```
Siyue 你好，

我是「面试副驾」的作者，一个开源的、非商业的桌面面试辅助工具（Windows + Android），
面向求职者做面试时的「思路提示」——只给要点和结构，不代答、不生成答案。

我在这个工具里内置了魔方简历（v2.0.12），想先向你说明清楚我的用法，避免误解：

1）做法：我把你发布的构建产物（dist + 依赖）原样放在用户本机的应用数据目录，
   由 Electron 以独立子进程方式启动你自带的 server.mjs，界面通过 127.0.0.1 访问。
   我**没有修改你任何一行源码**，也没有改名、改 logo、去署名。
2）用途：让用户在自己电脑上编辑简历；工具读取这份简历里的项目和经历，
   用来在面试时生成「锚定他自己经历」的提示要点。
3）分发：整体开源、免费、无广告、无内购。唯一的收入形式是 GitHub Sponsors / 爱发电的
   自愿赞助，且赞助不换取任何功能或服务。不做 SaaS，不向公众提供在线简历服务，
   不把魔方简历嵌入任何闭源或商业产品。
4）署名：我会在应用「关于」页与仓库 THIRD-PARTY 文件中注明
   「内置魔方简历 © Siyue，Apache-2.0 + 附加商业限制条款，https://magicv.art」，
   并原样保留你的 LICENSE 文件。

如果你的附加条款里对「本地进程托管 + 只读数据」这种用法有不同理解，
或者你希望我做额外的事（比如加显式入口、限制某些功能），请直接告诉我，我会改。
如果我将来要做任何形式的商业化，我会先来找你拿商业授权，不会先做再说。

顺带一句：你这个项目的排版和字体处理做得很好，我在集成时学了不少东西。

祝好，
<你的名字>
<GitHub / 项目地址>
```

**注意**：此邮件**不要自动发送**。发送前需要人工确认三件事——(a) 项目地址/仓库是否已公开；(b) 赞助渠道是否已上线；(c) 是否愿意在信里给出真实姓名。Sending 是外部动作，按项目约定必须人工确认。

---

## 附录 B：被本 ADR 推翻/修正的旧结论

| 旧结论（`04` 笔记） | 实测修正 |
|---|---|
| 「`public/fonts/*.otf/.ttf` 149 MB 大部分可删，但两个 TTF 必须保留」 | 方向对，但**可删范围更大**：`fonts.ts` 实际加载的是 `resume/*.woff2`，两个 TTF 只是 `Document.tsx` 的 preload，**非渲染必需**（保留是为了零 404 噪音） |
| 「字体可从 225 MB 压到 ~83 MB」 | 实测压到 **91.3 MB**（保留了两个 TTF 的 16.5 MB）；`dist` 总量 244.8 → **112.0 MB** |
| 「`sharp` 只在校徽代理里用，可能没被 require」 | **确认没被 require**：`src/` 与 `dist/server/` 均零引用；但它仍在 `dependencies` 里，打包会白带约 200 MB（sharp+puppeteer+@sparticuz），需剔除 |
| （未提及）`dist` 是否自包含 | **不自包含**：`dist/server/*.js` 有裸 import，必须随包带生产 `node_modules` |
| （未提及）`/api/models` 探活 | **不能用 GET 探活**：该路由只注册 POST，GET 返回 200 的 HTML 外壳，会假阳性 |
| （未提及）端口与 localStorage 的关系 | **origin 含端口**，端口一变简历"消失"，端口策略从"随便找个空闲的"改为"固定 + 复用探测 + 迁移" |
