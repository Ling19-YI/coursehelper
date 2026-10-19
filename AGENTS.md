# AGENTS.md

给在本仓库工作的 AI agent 与协作者的约定。**动手前必读。**

---

## 一、项目是什么

刷课助手 CourseHelper —— 超星学习通的 Windows 桌面客户端（Electron + React + TypeScript）。

- 完全免费，无激活码
- 账号密码仅存本机（Electron `safeStorage` 加密），不上传服务器
- 核心价值：视频自动播放/倍速、任务点自动完成、章节测验 AI 答题

---

## 二、分支与协作纪律（最重要）

本仓库由**多个 agent 并行开发**。已发生的两次协作事故都在这一节，
动手前请读完。

### 分支布局

| 分支 | 说明 |
|---|---|
| `main` | **双方共享的发布主干**。任何人都在这里提交，不存在"谁的分支" |
| `feat/multi-platform` | 多平台支持（雨课堂），开发中，**勿动** |
| `feat/quiz-answering` | 答题链，**已并入 v2.0.0**，分支保留备用 |

### 铁律

1. **动手前先同步，别凭上一次的认知开工**

   ```bash
   git fetch --all
   git log --oneline -10 origin/main
   git branch --show-current
   ```

2. **只在 `main` 上提交**（除非明确要求切分支）

3. **不要往别人的 feat/* 分支提交任何东西**（哪怕只是加文档）

4. **不要合并、不要 rebase 他人的分支**，等对方主动提出

5. **发布前必须确认本次要发的提交**

   ```bash
   git log --oneline <上次发布tag>..HEAD
   ```

   别凭记忆说"这次只有我修的几条"——`main` 上可能已并入别人的大量工作。

6. 动别人的分支前先备份：
   ```bash
   git branch backup-<branch>-before-change
   ```

### 共享模块要格外小心

以下文件双方都可能改，编辑前先看最近谁动过、是不是有正在进行的工作：

| 文件 | 风险 |
|---|---|
| `src/main/engine/quiz.ts` | 双方都改过，已重构多次 |
| `src/main/engine/video.ts` | 视频逻辑，改动互相影响 |
| `src/main/engine/blocker.ts` | 人工介入检测，误判会卡死整节课 |
| `AGENTS.md` | 双方都在维护，注意别覆盖对方的更新 |

改这几个文件前建议先 `git log -3 -- <文件>` 看近期改动。
**第九章「超星页面形态的坑」是改 quiz.ts / blocker.ts 前必读。**

> **事故一（分支）**：曾在 `feat/multi-platform` 上误提交文档。
> 用 `git reset --hard HEAD~1` + 重新提交到 main 修正。
>
> **事故二（认知过期）**：v2.0.0 发布前，我依据旧的认知认为
> 「2.0 只有六个 bug 修复」，还去问用户 2.0 该包含什么——
> 而当时 `git log` 里已经躺着另一个 agent 合并的整套答题重构
> （约 2100 行）。**答案在仓库里，别问人，先看 log。**

---

## 三、常用命令

```bash
npm run dev         # 开发模式（vite + esbuild watch + electron）
npm run typecheck   # 类型检查，改完必跑
npm run build       # 构建 main/preload/renderer
npm run dist        # 完整打包 → release/
```

### 测试脚本

项目**没有测试框架**，验证逻辑用独立脚本，放在 `scripts/test-*.mjs` 或
`scripts/test-*.ts`：

```bash
npx tsx scripts/test-timeout.mts          # 超时保护
node scripts/test-fallback.mjs            # 双源更新
node scripts/test-account-switch.mjs      # 换账号判定
node scripts/test-channel.mjs             # AI 通道选择
```

新增验证脚本时沿用 `test-*.mjs` / `test-*.ts` 命名，**会被入库**。

答题相关有两套，改动后必跑：

```bash
npm test          # typecheck + 下面两个
npm run test:answer   # 答案链、题库归一化、AI 不猜
npm run test:vision   # 截图识题的答案解析与越界丢弃
```

### 发布前检查（必跑）

```bash
node scripts/local-preflight.mjs 2.0.0
```

检查 `latest.yml` 编码、asar 内容、密钥泄漏、构建产物完整性。

---

## 四、代码结构

```
src/
├── main/              主进程
│   ├── engine/        核心引擎
│   │   ├── chaoxing.ts   登录、课程列表、章节导航
│   │   ├── video.ts       视频轮询、卡顿检测
│   │   ├── quiz.ts        章节测验、纯文本答题
│   │   ├── keepalive.ts   倍速维持、播放保活
│   │   ├── document.ts    文档任务点滚动
│   │   └── agent/         视觉 AI 答题
│   │       ├── loop.ts    逐题截图 → 分批送模型 → 坐标点击
│   │       ├── llm.ts     OpenAI 兼容调用
│   │       └── shot.ts    截图、脱敏
│   ├── updater.ts     应用内更新（双源回退）
│   ├── store.ts       设置与凭据存储
│   ├── session.ts     浏览器会话管理
│   └── ipc.ts         IPC 桥接
├── preload/           暴露给渲染进程的 API
├── renderer/          React 界面（pages/ 下是各页面）
└── shared/            类型定义
```

### 约定

- 注释用中文，与现有代码保持一致
- 关键逻辑写「为什么」而非「做了什么」
- 引擎函数通过 `EngineHooks` 接收日志与控制能力，不直接依赖 Electron

---

## 五、安全红线

### 合规定位：全仓库都是对外呈现

v2.1.3 起因：账号在平台被封，封禁原因是「功能描述违规」。

**上一轮只把宣传素材（视频口播/标题/标签）过了合规机检，软件本体和分发链路
整个漏掉** —— 安装包属性、桌面快捷方式、窗口标题、任务管理器进程名、
数据目录名、GitHub 仓库描述、落地页标题，全都写着旧定位。那些是任何审核
一眼就能看到的证据，比视频标题严重得多。**换平台解决不了，只能改软件。**

三层都要查，`npm run check:compliance` 强制：

| 层 | 位置 | 查什么 |
|---|---|---|
| 产品元数据 | `package.json` / `electron-builder.yml` | productName、description（装完就摆在眼前） |
| 软件本体 | `src/` | 窗口标题、`<title>`、数据目录名、设置页与关于页文案 |
| 分发链路 | `site/`、`README.md`、`docs/` | 落地页标题与描述、功能截图、下载链接 |

**三处名称必须逐字相同**（`package.json.productName` /
`electron-builder.yml.productName` / `src/shared/paths.ts` 的 `APP_DIR_NAME`）。
不同步就会出现「安装包叫新名、快捷方式叫旧名、数据目录又是第三个名」。

关于 `brand.ts`：v2.1.3 起**彻底转中性，没有开关**。曾经有个
`CH_BRAND=compliant` 构建开关能切回旧文案——留这种后门等于留一颗雷，
一旦误发布就前功尽弃。

**例外：引擎内部的技术性描述不用改。** URL 路由、DOM 选择器、
「超星字体替换」这类注释必须保留原词——排查真机故障时要对得上页面，
改了就失去参照。合规机检也只锚定「真正面向用户的字符串」。

### 历史文案归档

`docs-archive/` 与 `promo-archive/` 存放转中性之前的旧文案，**已 gitignore**。
仓库是公开的，留着等于把改掉的东西原样挂在网上。历史决策记录仍可在本地查阅。

### 绝对不能进仓库

| 内容 | 说明 |
|---|---|
| API Key / 令牌 | 用环境变量，如 `GH_TOKEN`、`GC_TOKEN` |
| 超星账号密码 | 用户的，存本机加密，**永不提交** |
| `scripts/local-*.mjs` / `local-*.cjs` | 本地发布工具，含令牌处理，已 gitignore |
| `tools/keys/`、`test-data/` | 本地数据，已 gitignore |

### 打包安全

`electron-builder.yml` 用**严格白名单**打包。历史上曾因 `app/dist/**/*` 把
本地探针脚本、真实作业截图、本机路径打进安装包（87 个文件 / 20.9MB）。

**新增需要打包的文件时，必须同步加进 `files` 白名单。**

改完跑 `node scripts/local-preflight.mjs <版本号>` 验证。

---

## 六、常见坑

### 1. PowerShell 的 `Set-Content -Encoding UTF8` 会加 BOM

会导致 `package.json`、`PostCSS 配置`解析失败。

**改配置文件一律用 Node：**

```bash
node -e "const fs=require('fs');fs.writeFileSync('package.json', fs.readFileSync('package.json','utf8').replace(/^\uFEFF/,''),'utf8')"
```

提交前养成习惯：

```bash
node -e "const b=require('fs').readFileSync('package.json'); console.log(b[0]===0xFEFF?'✗ 有 BOM':'✓ 无 BOM')"
```

### 2. GitHub 与 GitCode 的 API 行为不一致

| 平台 | 鉴权头 | 上传方式 |
|---|---|---|
| GitHub | `Authorization: Bearer` | 直接 POST 到 `upload_url` |
| GitCode | `private-token` 或 `X-Auth-Token` | 两阶段：先取 `upload_url?file_name=x`，再 PUT |

GitCode 参数名是 `file_name`（不是 `filename`）。

### 3. GitCode 的下载路径容易拼错

```
✓ 正确：releases/download/<tag>/<文件>
✗ 错误：releases/<tag>/download/<文件>   ← 返回 3.5KB 的 HTML，HTTP 仍是 200
```

拼错时**状态码正常**，只能靠 `content-range` 里的总大小发现。

### 4. 令牌存放约定（重要，勿改）

两个令牌都存在**家目录**，不在任何 git 仓库内：

| 文件 | 用途 | 身份 |
|---|---|---|
| `C:\Users\colorful\.coursehelper-github-token` | GitHub 细粒度令牌 | `Ling19-YI` |
| `C:\Users\colorful\.coursehelper-gitcode-token` | GitCode 私人令牌 | `2603_95808828` |

格式：**单一纯文本、无换行、无 BOM**（`cat` 出来可直接用）。

用法（令牌不会进入命令历史或对话）：

```bash
# GitHub
GH_TOKEN="$(cat 'C:/Users/colorful/.coursehelper-github-token')" node scripts/local-release.mjs
AUTH=$(printf 'x-access-token:%s' "$(cat 'C:/Users/colorful/.coursehelper-github-token')" | base64 -w0)
git -c "http.extraHeader=Authorization: Basic $AUTH" push origin main

# GitCode
GC_TOKEN="$(cat 'C:/Users/colorful/.coursehelper-gitcode-token')" node scripts/local-gc-release.mjs v2.1.2
```

**三条硬规则**：

1. **令牌原文不写进任何文件、提交、注释或记忆文件。** 记忆文件会在每个后续会话
   被读进上下文，写进去等于把密钥长期摊开。
2. **不要把令牌贴进对话。** 让助手从上述文件读取即可。
3. `.gitignore` 已加 `*token*` / `*.token` / `*.env` / `*.secret` 作为兜底，
   **但那只是兜底**——凭据的正确存放位置是家目录，不是仓库。

### 5. GitCode 的 release 无法通过 API 修改（2026-10-13 实测）

| 尝试 | 结果 |
|---|---|
| `PATCH /repos/{o}/{r}/releases` | 405 |
| `PUT /releases` | 405 |
| `PATCH /releases/tags/{tag}` | 405 `METHOD_NOT_ALLOWED` |
| `POST /releases`（同 tag） | 409 `Release already exists` |

`GET /releases` 返回的对象**连 `id` 字段都没有**，无法按 id 定位。
GitHub 则可 `PATCH /releases/{id}` 原地改。

**⇒ 发布说明必须在创建 release 之前写对**，事后只能去网页版手改：
<https://gitcode.com/2603_95808828/coursehelp/-/releases>

这也是两平台描述容易不同步的根源（历史上已出过两次），改说明时两边都要确认。

### 7. 上传资产可能碰上 `uploads.github.com` 瞬时 DNS 失败（2026-10-13）

发 v2.1.2 时跑到第二个文件（`latest.yml`）报
`getaddrinfo ENOTFOUND uploads.github.com`，EXE 已传成功、剩下两个没传上。
几分钟后同一机器解析正常——是瞬时故障，**不是配置问题**。
`scripts/local-release.mjs` 会先删旧资产再从头发三件，这时不要重跑整个脚本
（会白传 110MB），用 `scripts/local-upload-missing.mjs <tag>`：只补缺失的，
不删已有、不重传。

### 6. 验GitCode 下载链接别用 HEAD

`curl -I` 返回 **401**，看着像链接失效；真实 GET（`curl -r 0-0`）是 **206** 正常。
**GitCode 的 CDN 拒 HEAD 只收 GET**，并会302 到 `file-cdn.gitcode.com` 带签名。

### 4. GitCode 的 `releases/latest/download/` 不可用

该地址返回 HTML 而非 `latest.yml`。必须先调 API 取最新 tag 再拼路径。

### 5. PowerShell 里多行命令用分号会被解析器拆开

写多行 git commit message 要用文件：

```bash
git commit -F .git/MSGTMP
```

### 6. 中文文件名在 PowerShell 里显示为乱码

不影响文件本身，但**不要据此判断文件损坏**。读文件内容用 `Read` 工具或 Node。

### 7. `fs.cpSync` 在「目标是不存在的目录」时会硬杀进程（2026-10-15 实测）

`src/shared/paths.ts` 的改名迁移原本用 `fs.cpSync(src, dst, { recursive: true })`
搬 `data/` 目录。在 Node 22 + Windows 上，只要 `dst` 尚不存在就直接终止进程——
**try/catch 接不住**，退出码 127，stderr 全空，连调用方后面的 `console.log` 都不打。

迁移失败 = 应用起不来，比不迁移严重得多。现已换成自建的 `copyPath()`
（`statSync` 判类型后分别走 `copyFileSync` / 自建递归），行为完全可控。

**教训**：涉及「应用启动必经」的路径上，不要用会硬退出的 API。
`scripts/test-migration.ts` 是这条的回归锁，改迁移逻辑必须跑它。

### 8. 改名会改掉 userData 路径，老用户数据会「消失」

Electron 的 userData 目录名直接来自 `productName`。产品改名后新版会指向一个
全新空目录，老用户的账号凭证和学习进度看起来全没了（数据还在，只是没人搬）。

`src/shared/paths.ts` 的 `migrateDirInto()` 负责搬。三条原则不可动摇：
- **只搬不删**：旧目录原地保留，判断错了也要能手工找回
- **目标已有数据就整个跳过**：宁可让用户手工拷一次，也不能覆盖正在用的
- **迁移失败不拦启动**：最坏情况是用户重新登录一次

---

## 七、发布流程

### 双平台同步发布

```
https://github.com/Ling19-YI/coursehelper/releases
https://gitcode.com/2603_95808828/coursehelp/-/releases
```

### 三个文件缺一不可

| 文件 | 缺失后果 |
|---|---|
| `CourseHelper-Setup-<版本>.exe` | 用户装不了 |
| `latest.yml` | **在线更新完全失效** |
| `CourseHelper-Setup-<版本>.exe.blockmap` | 更新退化为全量下载 |

`latest.yml` 只有几百字节，**最容易漏**。

### 步骤

```bash
# 1. 改版本号（用 Node，不要用 PowerShell）
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='1.6.0';fs.writeFileSync('package.json',JSON.stringify(p,null,2),'utf8')"

# 2. 提交并打 tag（两个远程都要推）
git commit -am "chore(release): v2.0.0"
git tag v2.0.0
git push origin main && git push gitcode main
git push origin v2.0.0 && git push gitcode --tags

# 3. 构建
npm run dist

# 4. 发布前检查（必跑）
node scripts/local-preflight.mjs 2.0.0

# 5. 上传（见 scripts/local-release.mjs，gitignored）
```

### 发行版标题

必须与 tag 一致。`scripts/local-release.mjs` 已改为自动从 `package.json` 取版本，
**不要再手写版本号**。

---

## 八、协作约定

- 提交信息用中文，格式：`<type>(<scope>): <简述>`
- type 用 `feat` / `fix` / `docs` / `chore` / `refactor`
- 一个提交只做一件事
- 改动前先读现有代码，沿用既有模式
- 不擅自 `git push --force` 到 main

### 发布说明只有一份（2026-10-13 加的工具）

`node scripts/sync-release-notes.mjs <版本> [--check]`：把 `docs/v<版本>发布说明.md`
的「发布说明正文」段写进两个发布脚本的内嵌 `notes`，并逐字比对两平台是否一致。
**不要在两个脚本里各手写一份**——历史上两次「两平台说明不同步」就是这么来的。
GitCode 的 release 建完无法用 API 改，说明必须先写对。

### 接口地址的清洗（改 AI 通道前必读）

用户高频错误：把服务商文档里的**完整接口路径**（以 `/chat/completions` 结尾）整段填进
「接口地址」。我们调用时会再拼一次 → `…/chat/completions/chat/completions` →
服务端回 `No static resource …` 的 400。2026-10-13 两位用户反馈同款。

所以：**任何用到 `visionBaseUrl` 的地方都要过 `src/shared/baseUrl.ts` 的
`normalizeBaseUrl()`**，不要在 fetch 处只做 `.replace(/\/$/, '')`。当前三处已覆盖：
`ipc.ts` 的 `settings:set`（保存侧纠正）与 `getVision`、`engine/index.ts` 的
`visionChannel`（兜底，让老配置无需重新保存也生效）。

### 视频相关

拍视频前必读 `docs/视频拍摄指南.md`。要点：

- 账号、学校学院、本机用户名**不能入镜**
- 日志面板会自动打印本地路径
- 下载渠道 GitCode 放前面（国内用户多）
- 视频里**不要提雨课堂**，尚未上线

---

## 九、当前状态（2026-10-19）

- **最新发布：v2.1.2。v2.1.3 已改完、待发布**（发布说明唯一来源：
  `docs/v2.1.3发布说明.md`，两个发布脚本的内嵌 notes 由
  `node scripts/sync-release-notes.mjs 2.1.3` 同步生成，当前逐字一致）
- **v2.1.3 共 9 个提交、65 文件、+2923/−2174**：合规整改 + 4 个真机实测
  抓出的引擎缺陷。**不是「零增删的收尾版」** —— 这句话已从发布说明删掉。
- **真机验证已打通（2026-10-19）**：用 DeepSeek 开启答题跑完
  「解析题目 → 作答 → 提交 → 平台标记完成 → 整章完成」，
  同轮 5 个章节 completed；题干为超星字体替换时自动转截图识别 3/3。
  ⚠️ 测试凭据在 `tools/keys/`（gitignore 双重忽略）：
  `test-account.json`（账号）、`vision.json`（AI 通道）。
- **本周踩到的 4 个「假成功」是同一类错误**（详见第十一、十二章）：
  `jobUnfinishCount` 读不到→当成没活 / 测验 iframe 不在 DOM→当成不是测验 /
  `tabIndex` 走满→当成全完成 / `foundWork` 为 false→当成全完成。
  **修法共同点：不推断，只数「亲眼确认过的事实」。**
- **chapters 已完成的能力清单**（相对 v2.1.2）：
  - 章节内容分页：`listJobTabs()` / `activateJobTab()`（`ul.prev_ul` +
    `changeDisplayContent`，等 cards frame 的 `num` 对上才返回）
  - 完成判定：`doneTabs` 集合 + `currentJobPageDone()`（照平台 `checkJob()`
    判据，不依赖帧类型识别）+ `waitTabFinished()`（等异步记账）
  - 课程页 Vue 化：`ensureEnteredCourse()` 自动点「进入课程」
  - 关于页：QQ 群 1128273483；收款码软件内与落地页两处同步（md5 校验）
- **发布前必须知道的环境坑**：
  - 环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 变成 Node 跑，
    报 `app.isPackaged` undefined。跑 Electron 前要 `env -u ELECTRON_RUN_AS_NODE`
  - 无 GPU 环境要加 `ELECTRON_EXTRA_ARGS="--disable-gpu ..."`
    （`dev.mjs` 与 `verify-ui.mjs` 都已支持透传）
  - `verify-ui.mjs` 用 CDP 9333 驱动真实界面，比手点可靠，发布前跑它
  - **全仓库转中性**：`brand.ts` 不再有 `CH_BRAND` 开关（旧文案无法再被构建出来）。
    productName / 窗口标题 / `<title>` / 数据目录名 / 设置页 / 关于页 / 落地页 /
    README / 图标 / 功能截图全部改掉。见第五章「合规定位」。
  - **改名迁移**：`src/shared/paths.ts` 的 `migrateDirInto()`，5 个回归用例
    （`npm run test:migration`）锁住「只搬不删 / 不覆盖 / 失败不拦启动」。
  - **新增合规机检** `scripts/check-compliance.mjs`（`npm run check:compliance`，
    已挂进 `npm test`）：覆盖产品元数据 / 软件本体 / 分发链路三层 + 三处名称一致性
    + 归档区未入库。**首跑即抓出 11 处漏网**，验证了上一轮确实只查了宣传素材。
  - **修复混合章节「视频未放完就去答题」**：`hasUnfinishedVideoJob()` 给
    `index.ts` 与 `isQuizPage` 两处回退路径都加了闸；新增
    `describeJobInventory()` 诊断日志。**仅静态断言通过，待真机验证**——
    用户已提供账号可实测，复现时日志会打出 `⚠ 本章还有未完成的视频任务点…`
    与完整任务点清单，据此区分「判错类型」与「选错任务点」。
  - **历史文案归档**到 `docs-archive/`、`promo-archive/`（已 gitignore）。
    注意 Windows 上 `git add -A` 会把**已追踪**的归档文件重新加回（gitignore
    只对未追踪文件生效），提交前用 `npm run check:compliance` 的第 6 节拦。
- **推广计划已作废**：账号被封后不再有 B 站投放计划。原 75s 正片与配音版仍在
  `promo/bilibili/` 与桌面，口播与画面本来就是中性合规的那一版，可继续用于
  视频号 / 小红书。
- **平台建议**：内容描述被封的定性下，优先视频号（腾讯系，工具类宽松）、
  次选小红书（外链只能走评论区/私信）。抖音/ 快手对自动化工具类处置偏重。
- 历史版本信息（v2.1.2 / v2.1.1 / v2.1.0）见下方各段。

<details>
<summary>更早的版本记录（v2.1.2 及之前）</summary>

- 最新发布：**v2.1.2**（发布说明唯一来源：`docs/v2.1.2发布说明.md`，
  两个发布脚本的内嵌 notes 由 `node scripts/sync-release-notes.mjs 2.1.2` 同步生成）
- `feat/quiz-answering` 已并入 `main`，该分支保留未删
- `main` 已包含：
  - **章节测验 AI 答题**：纯文本答案链 + 本地题库沉淀 + 交卷覆盖率闸门
  - **截图识题**：图片题干 / 超星字体替换（`font-cxsecret`）两条只能看渲染画面的路
  - **视频随堂弹题**：按真实 DOM 契约实现，设置项 `answerPopup` 默认**关闭**
  - 视频静音开关、扫码/验证码/人脸弹窗检测（命中即停所有模拟动作）
  - 双源更新、换账号修复、收款码更新
- **v2.1.2 主要变化**（面向用户的完整说明在 `docs/v2.1.2发布说明.md`，热修版）：
  - **接口地址自动纠正**：`src/shared/baseUrl.ts` 的 `normalizeBaseUrl()` 剥掉整段
    粘贴带来的 `/chat/completions` 结尾、尾斜杠与误粘引号；保存侧（`settings:set`）、
    读取侧（`getVision`）、通道侧（`visionChannel`）三处生效，**老配置不用重新保存**
  - **401 直接提示「密钥无效或未授权」**（`searcher.ts` / `visionSearcher.ts`）
  - 设置页补地址填写说明；落地页 FAQ 加「接口地址该怎么填」
  - 新增 `scripts/sync-release-notes.mjs`（发布说明单源同步 + 两平台逐字校验）
  - 新增 `scripts/test-baseurl.ts`（10 用例，已挂进 `npm test`）
- **v2.1.1 主要变化**（面向用户的完整说明在 `docs/v2.1.1发布说明.md`）：
  - **AI 答题「无解」四层根因**：失败不上浮 / 输出预算一开始给足（16000，
    推理吃光自动升档 32000 重试）/ 配置判定一致 / 自检列明缺什么
  - **单通道收敛**：删除旧版 DeepSeek 回退（`api.deepseek.com` 已不在包内）
  - **混合章节按任务点分派**（`jobpoint`）：一页里的视频/文档/测验依次做完
  - **目标标记跨轮残留**（`clearTargetMark`）与**平台记账滞后**（`waitUnfinishDrop`）
  - **扫码弹窗三连修**：保活 ticker 认 `__kaBlocked`、`BLOCK_CLEAN_POLLS=3`
    连续稳定才算处理完、风控页按 URL 判定并中止整轮（`riskBlocked`，
    收尾不再假报「任务完成」）
  - **手动切章节**：`user_switched` 让位、从手动点的那节重新开始、不记账
  - **更新器修复**：`isAddNoCacheQuery=false`（GitCode 源不吃查询串）——
    ⚠️ 该修复在 v2.1.0 安装包构建之后，**v2.1.0 用户手上的更新器是坏的**，
    升级说明必须引导覆盖安装
  - 收款码更新（关于页 + 落地页）
- `feat/multi-platform` 开发中：PlatformDriver 契约、多平台命名空间
- **`src/main/engine/agent/`（973 行）是预留能力，不是死代码**：
  为「结构化解析失效的界面」（平台改版、富交互题型、纯 Canvas 渲染、新平台）
  和后续新功能准备。接口与接线方式见 `src/main/engine/agent/README.md`。
  **清理代码时请保留整目录。**
  ⚠️ 实测（2026-10-13）：**该目录不在主进程 bundle 内**——`app/dist/main/index.js`
  里只有 `searcher.ts` / `visionSearcher.ts` / `quiz.ts` 等上线路径的文件注释，
  没有 `agent/*`（唯一引用 `agent/llm.ts` 的 `agent/loop.ts` 自身也没被引入）。
  **改 agent/ 里的报错文案或逻辑不会影响用户**；要改用户可见行为，去
  `searcher.ts`（文本答题）与 `visionSearcher.ts`（截图识题）。
- **多模态 Key 由用户自填**，只要求支持 OpenAI 兼容的 `chat/completions` +
  `image_url`（实测 mimo-v2.5 / mimo-v2.6-flash / qwen3-vl-plus / glm-4.6v /
  glm-5v-turbo 可用）。纯文本模型不吃图，会返回空答案而不是报错
- 已知限制：各校题目结构差异大，答题准确率无法保证
- **仍未修的已知问题（v2.1.3 候选）**：截图识别的答案与 DOM 选项**错配**——
  实测 5 题只存活 1 题，其余被覆盖率闸门以「选项不在范围内」丢弃。属于
  「答案对但映射错位」，不是模型答错。

### 超星页面形态的坑（改 quiz.ts / blocker.ts 前必读）

关键词匹配一定要配结构判据，否则会大面积误判。已踩过两次：

1. 课程主页 `studentstudy` 的章节侧边栏目录含「作业」「待完成」等字样，
   整页文本匹配会把视频章节判成测验 → 见 `NON_QUIZ_FRAME_URL`、
   `isPlausibleQuestion`
2. 页面里藏着 `display:none` 的弹窗模板，里面有「扫码」二字。取整页文本时
   **必须用真实 `body.innerText`**，`cloneNode` 出来的游离节点会让 innerText
   退化成 textContent，把隐藏内容全算进去（实测 715 字 → 99987 字）→ 见
   `blocker.ts` 第 2 步注释

</details>

---

## 十、给 agent 的最后叮嘱

1. **先 `git fetch` + 看 `git log`，再动手**——`main` 是共享主干
2. **发布前用 `git log <上tag>..HEAD` 确认发的是什么**，别凭记忆
3. **先查分支，再提交**
4. **改配置用 Node，不用 PowerShell 的 `Set-Content`**
5. **改完跑 `npm run typecheck`**
6. **发布前跑 preflight**
7. **不确定就问，不要猜着改**——尤其是账号、答题、发布相关的逻辑

---

## 十一、2026-10-16 真机实测：目录计数与页面结构的矛盾

用测试账号（`tools/keys/test-account.json`，已被 gitignore 双重忽略）**只读**探测
「改革开放史」课程，拿到一批与代码假设冲突的事实。**动手改任务点相关逻辑前先读这一节。**

探测脚本一律 `scripts/local-probe-*.mjs`（gitignored），**只读 DOM，不播放不答题**。

### 事实 1：课程主页已全面 Vue 化

- 课程详情页 frame：`mooc1.chaoxing.com/course-ans-vue/88/detail.html?...model=template2`
- 该 frame 内 `[onclick*="toOld"]` = **0 个**，`input.knowledgeJobCount` = **0 个**
- 必须点「进入课程」跳到 `mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu`，
  再由它加载 `mycourse/studentcourse` 目录 frame —— 那一层 `toOld` 才有 **40 个**
- **直接访问 `stu` 地址时目录 frame 不就绪**（读到 0 条章节）。必须走「课程页 → 进入课程」

### 事实 2：`jobUnfinishCount` 在这个账号上读不到有效值 ⚠️

- `window.getJobCount()` 实测返回 **0**
- `input[name="jobUnfinishCount"]` / `.jobUnfinishCount` 在 studentstudy 页**不存在**
- 引擎 `video.ts` 的 `readUnfinishedCount()` 因此返回 **null**
- `index.ts` 拿到 null 后 `break`（「读不到就别自作聪明地循环」）
- ⚠️ `video.ts` 里那句注释「实机见到 4 个 `.jobUnfinishCount`」是**旧版页面**的实测，
  在当前页面上已经不成立。任何依赖它的判断都需要重新验证。

### 事实 3：`knowledgeJobCount` 不是任务点总数

目录里未完成的章节，`input.knowledgeJobCount` 的值是 **1**，同时文本显示
「11个待完成任务点」。**两个数都不是本章任务点总数**：
- `knowledgeJobCount` = 已完成数
- 文本里的「N 个待完成任务点」= **课程级**待完成总数（40 个未完成章节全显示 11）

因此 `index.ts` 里
`if (chapter.jobCount > 0 && active.total < chapter.jobCount)` 这条告警会**恒成立**，
属于噪声，`wantJobs` 的收敛语义也需要重新定义。

### 事实 4：章节测验是懒加载的，初始不在 DOM 里

进入章节后实测：
- 章节详情文本写明 `1视频 2章节测验`
- `knowledge/cards` frame 里 `.ans-job-icon` 只有 **1 个**（视频，且已带 `ans-job-finished`）
- 第二个 `ans-attach-ct` 是**讨论区**（`insertbbs`），不是任务点
- **没有任何测验 iframe**

即任务点逐个滚动到视口才渲染。`collectJobFrames()` 一次只能看到当前渲染的那几个，
「本章一共有几个任务点」这个问题在页面上**根本不存在直接答案**。

### 事实 5：平台自己的判定函数（可直接借用）

`studentstudy` 的 window 上有：
- `getJobCount(obj)` — 遍历 `.jobUnfinishCount` 求和（实测返回 0）
- `checkJob()` — 「`#iframe`.contents() 里 `.ans-job-icon` 有没有非 `ans-job-finished` 的」
- `jobflag()` — 统计 `frames[0].document` 里 `.ans-job-icon` 与 `.ans-job-finished` 的数量
- `scroll2Job()` — 滚到第一个未完成的 `.ans-job-icon` 的父容器

**关键差异**：平台判定「还有没有活」用的是**数图标 + 查完成标记**，
不是读计数 input。引擎若继续依赖 `jobUnfinishCount`，课程页一改版就全线失效。

### 当前判断

v2.1.3 里 `hasUnfinishedVideoJob()` 那道闸针对的是「unknown 回退被测验 iframe 劫持」。
**实测中混合章节的测验 iframe 压根不在 DOM 里，那道闸不会触发** ——
它无害，但没有打到用户反馈的那个点上。

用户反馈的「同章节视频和题目，没放完视频就去答题」，最可能的真实成因是**事实 2**：
`readUnfinishedCount()` 返回 null → 一轮之后 `break`，或「待完成数被判为已清零」而提前收手。

**下一步动手前先确认**：那条反馈是不是同一个账号/同一门课上的现象。

---

## 十二、⚠️ 已确认的根因：章节内容是「标签页分页」，测验在另一个标签里

用户确认出问题的章节是 **中华民族共同体概论 3.1 夏商周王朝的建立**。
在该章节上实测（只读）拿到了完整证据链。

### 现象

章节详情文本写着 **`1课程视频  2章节测验`**（共 3 个任务点），但进入章节后：

| 观测项 | 实测值 |
|---|---|
| `.ans-job-icon` | **1 个**（视频，已带 `ans-job-finished`） |
| cards frame 里的 iframe | **1 个**（video） |
| `input.jobUnfinishCount` | **0 个** |
| `window.getJobCount()` | **0** |
| `window.checkJob()` | **false** |

即：**页面只渲染了第一个任务点，剩下 2 个测验完全不在 DOM 里。**

### 机制：标签页 = 任务点分页器

`studentstudy` 顶部有一个 `ul.prev_ul`，每个 `li` 对应**一个任务点**：

```html
<li class="active" onclick="changeDisplayContent(1,2,'章节id','课程id','班级id','');">1课程视频</li>
<li           onclick="changeDisplayContent(2,2,'章节id','课程id','班级id','');">2章节测验</li>
```

`changeDisplayContent(num, totalnum, chapterId, courseId, clazzid, knowledgestr, crossid)`
做的唯一实质动作是**改 iframe 的 src**：

```js
document.getElementById("iframe").src =
  "/mooc-ans/knowledge/cards?...&knowledgeid=" + chapterId + "&num=" + (num-1) + "...";
```

**`num` 就是任务点序号**（点第 1 个 → `num=0`，第 2 个 → `num=1`）。
它同时把对应 `li` 加上 `.active` 并更新标题栏文本。

### 引擎为什么看不见这些

1. `src/main/engine/` 里**搜不到任何** `prev_ul` / `changeDisplayContent` / `prev_list` 相关逻辑。
2. 引擎只读 `input.jobUnfinishCount`，而该页面**一个都不存在** →
   `readUnfinishedCount()` 返回 `null` → `index.ts` 拿到 null 就 `break`，
   **于是一章只做第一个任务点就收手**。
3. 于是用户看到的是：视频任务点因为已播完被跳过，程序判定「本章没有活」，
   转而去找能做的其它任务 —— 表现就是「没放完视频就去答题」。

### 修法方向（已由实测确定，不是推测）

任务点不是「并列在同一个页面里」，而是**按 `num` 分页渲染**。
引擎必须**主动遍历标签页**，而不是指望一次读到全部任务点：

- 读 `ul.prev_ul > li` 得到本章共有几个任务点（`totalnum`）
- 对每个 `li`：调 `changeDisplayContent(i, totalnum, ...)` 或直接点它
  → 等 iframe 的 src 变成 `.../knowledge/cards?...&num=i-1&...`
  → 等 cards frame 加载完 → 这时 `collectJobFrames()` 才能看到该任务点
  → 按类型分派（视频 / 文档 / 测验）
- 全部标签页扫完才算本章处理完

⚠️ 注意：`changeDisplayContent` 会**整页替换 iframe.src**，前一个任务点的状态
只能靠平台的 `ans-job-finished` 标记和进度计数判断，不能靠「它还在 DOM 里」。
`scroll2Job()` 在这个结构下也只能在**当前 num 页内**滚动。

### 对既有代码的影响

- `index.ts` 里 `wantJobs = chapter.jobCount` 这套逻辑作废 ——
  `knowledgeJobCount` 实测是「已完成数」（值 1），不是总数。
- `test-mixed-chapter.ts` 里那些断言基于「多任务点并列在同一页」的旧假设，
  需要按分页模型重写。
- `jobpoint.ts` 的 `collectJobFrames()` 本身没问题（它遍历 `page.frames()`），
  但**只在当前 num 页内有效**。

### ⚠️ tabIndex 走满 ≠ 本章做完了（真机实测抓到的假成功）

用**改革开放史 2.3「在对世界大势的新判断下开启改革大幕」**做验收时抓到的。
该章正是「视频已完成（`ct=882`）+ 测验未完成」的组合：

```
切 tab1 → 视频已完成 → 跳下一个
切 tab2 → 测验未完成 → break        ← 找到了活，本该去处理
但此时 tabIndex 已经等于标签总数 → 被误判成「本章全完成」
→ markDone() 记账 + 日志说「此前已完成，无需重做」
→ 这一章的测验永远不会被再处理
```

**两个标签时必然踩中**：切到最后一个标签发现它没做完 → break 出来时
`tabIndex` 恰好等于标签数，与「全部走完」无法区分。

修法：`index.ts` 里用两个独立标志，不拿 `tabIndex` 当完成依据：
- `foundWork` — 这一轮找到了**还有活**的标签 → 该去处理它
- `tabsExhausted` — 标签**全部走完且每个都已确认完成**

切换失败（`activateJobTab` 返回 false）也算 `foundWork`：状态未知时
宁可再试一次分派，也不能静默认定成功。

**教训**：遍历型逻辑里「索引走到头」和「事情做完了」是两件事，
用同一个变量表达迟早出事。
若是，修法应转向「用 `checkJob()` 那套数图标的判据替代计数 input」，而不是继续加类型闸门。
