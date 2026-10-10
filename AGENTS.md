# AGENTS.md

给在本仓库工作的 AI agent 与协作者的约定。**动手前必读。**

---

## 一、项目是什么

刷课助手 CourseHelper —— 超星学习通的 Windows 桌面客户端（Electron + React + TypeScript）。

- 完全免费，无激活码
- 账号密码仅存本机（Electron `safeStorage` 加密），不上传服务器
- 核心价值：视频自动播放/倍速、任务点自动完成、章节测验 AI 答题

---

## 二、分支纪律（最重要）

本仓库由**多个 agent 并行开发**，动分支前必须确认。

### 当前分支布局

| 分支 | 负责人 | 说明 |
|---|---|---|
| `main` | 主开发（chat） | 发布主干，所有发版基于此 |
| `feat/multi-platform` | 另一 agent | 多平台支持（雨课堂），**开发中，勿动** |

### 铁律

1. **提交前必须确认当前分支**

   ```bash
   git branch --show-current
   ```

2. **只在 `main` 上提交，除非明确要求切分支**

   ```bash
   git checkout main
   ```

3. **不要往别人的开发分支提交任何东西**（哪怕只是加文档）

4. **不要合并、不要 rebase 他人的分支**，等对方主动提出

5. 动别人的分支前先备份：
   ```bash
   git branch backup-<branch>-before-change
   ```

> 真实事故记录：曾在 `feat/multi-platform` 上误提交文档，用
> `git reset --hard HEAD~1` + 重新提交到 main 修正。
> 养成先查分支的习惯。

---

## 三、常用命令

```bash
npm run dev         # 开发模式（vite + esbuild watch + electron）
npm run typecheck   # 类型检查，改完必跑
npm run build       # 构建 main/preload/renderer
npm run dist        # 完整打包 → release/
```

### 测试脚本

项目**没有测试框架**，验证逻辑用独立脚本，放在 `scripts/test-*.mjs`：

```bash
npx tsx scripts/test-timeout.mts          # 超时保护
node scripts/test-fallback.mjs            # 双源更新
node scripts/test-account-switch.mjs      # 换账号判定
node scripts/test-channel.mjs             # AI 通道选择
```

新增验证脚本时沿用 `test-*.mjs` 命名，**会被入库**。

### 发布前检查（必跑）

```bash
node scripts/local-preflight.mjs 1.5.1
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
git commit -am "chore(release): v1.6.0"
git tag v1.6.0
git push origin main && git push gitcode main
git push origin v1.6.0 && git push gitcode --tags

# 3. 构建
npm run dist

# 4. 发布前检查（必跑）
node scripts/local-preflight.mjs 1.6.0

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

## 九、当前状态（2026-10-10）

- 最新发布：**v1.5.1**
- `main` 已包含：双源更新、视频不检测随堂题、换账号修复、收款码更新
- `feat/multi-platform` 开发中：PlatformDriver 契约、多平台命名空间
- AI 答题默认**关闭**，用户需自行配置多模态 Key
- 已知限制：各校题目结构差异大，答题准确率无法保证

---

## 十、给 agent 的最后叮嘱

1. **先查分支，再动手**
2. **改配置用 Node，不用 PowerShell 的 `Set-Content`**
3. **改完跑 `npm run typecheck`**
4. **发布前跑 preflight**
5. **不确定就问，不要猜着改**——尤其是账号、答题、发布相关的逻辑
