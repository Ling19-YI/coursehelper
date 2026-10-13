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
GC_TOKEN="$(cat 'C:/Users/colorful/.coursehelper-gitcode-token')" node scripts/local-gc-release.mjs v2.1.1
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

### 视频相关

拍视频前必读 `docs/视频拍摄指南.md`。要点：

- 账号、学校学院、本机用户名**不能入镜**
- 日志面板会自动打印本地路径
- 下载渠道 GitCode 放前面（国内用户多）
- 视频里**不要提雨课堂**，尚未上线

---

## 九、当前状态（2026-10-13）

- 最新发布：**v2.1.1**（发布说明唯一来源：`docs/v2.1.1发布说明.md`，
  两个发布脚本的内嵌 notes 均由它生成）
- `feat/quiz-answering` 已并入 `main`，该分支保留未删
- `main` 已包含：
  - **章节测验 AI 答题**：纯文本答案链 + 本地题库沉淀 + 交卷覆盖率闸门
  - **截图识题**：图片题干 / 超星字体替换（`font-cxsecret`）两条只能看渲染画面的路
  - **视频随堂弹题**：按真实 DOM 契约实现，设置项 `answerPopup` 默认**关闭**
  - 视频静音开关、扫码/验证码/人脸弹窗检测（命中即停所有模拟动作）
  - 双源更新、换账号修复、收款码更新
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
- **多模态 Key 由用户自填**，只要求支持 OpenAI 兼容的 `chat/completions` +
  `image_url`（实测 mimo-v2.5 / mimo-v2.6-flash / qwen3-vl-plus / glm-4.6v /
  glm-5v-turbo 可用）。纯文本模型不吃图，会返回空答案而不是报错
- 已知限制：各校题目结构差异大，答题准确率无法保证

### 超星页面形态的坑（改 quiz.ts / blocker.ts 前必读）

关键词匹配一定要配结构判据，否则会大面积误判。已踩过两次：

1. 课程主页 `studentstudy` 的章节侧边栏目录含「作业」「待完成」等字样，
   整页文本匹配会把视频章节判成测验 → 见 `NON_QUIZ_FRAME_URL`、
   `isPlausibleQuestion`
2. 页面里藏着 `display:none` 的弹窗模板，里面有「扫码」二字。取整页文本时
   **必须用真实 `body.innerText`**，`cloneNode` 出来的游离节点会让 innerText
   退化成 textContent，把隐藏内容全算进去（实测 715 字 → 99987 字）→ 见
   `blocker.ts` 第 2 步注释

---

## 十、给 agent 的最后叮嘱

1. **先 `git fetch` + 看 `git log`，再动手**——`main` 是共享主干
2. **发布前用 `git log <上tag>..HEAD` 确认发的是什么**，别凭记忆
3. **先查分支，再提交**
4. **改配置用 Node，不用 PowerShell 的 `Set-Content`**
5. **改完跑 `npm run typecheck`**
6. **发布前跑 preflight**
7. **不确定就问，不要猜着改**——尤其是账号、答题、发布相关的逻辑
