# 官网下载页文案（草稿）

## 标题

刷课助手 CourseHelper —— 超星学习通自动刷课工具

## 下载按钮

- [Windows 版下载（CourseHelper-Setup-1.0.0.exe）](链接)
- 大小：约 110 MB · 仅支持 Windows 10/11 x64
- 校验：发版时执行 `Get-FileHash release\CourseHelper-Setup-<版本>.exe -Algorithm SHA256` 填写

## ⚠️ 安装前必读：Windows SmartScreen 提示

本软件**未购买代码签名证书**，首次运行 Windows 可能弹出「Windows 已保护你的电脑」蓝色提示，**这是正常现象，并非病毒**。按以下步骤即可正常运行：

1. 出现「Windows 已保护你的电脑」提示时，点击左下角的 **「更多信息」**
2. 点击下方出现的 **「仍要运行」** 按钮
3. 软件即可正常启动（只需操作一次，之后不再提示）

> 若提示「无法验证发布者」：同样点击「更多信息 → 仍要运行」。
> 杀毒软件如误报，请将安装目录加入信任区。

图示：

```
┌──────────────────────────────┐
│  Windows 已保护你的电脑      │
│  Microsoft Defender SmartScreen│
│                              │
│  [更多信息]                  │  ← 点这里
│                              │
└──────────────────────────────┘

┌──────────────────────────────┐
│  Microsoft Defender          │
│  SmartScreen 已阻止…         │
│                              │
│  [运行]        [不运行]      │  ← 点「运行」
└──────────────────────────────┘
```

## 支持作者（自愿）

本工具**完全免费、无需激活码**。如果你觉得有用，欢迎在软件「关于」页扫码请作者喝杯奶茶；不支持也完全不影响使用。

## 使用说明（快速上手）

1. 打开软件（无需激活）→ 左侧「设置」填写超星账号密码 → 保存
2. 「课程」页点「刷新课程」→ 勾选课程
3. 「任务」页点「开始刷课」→「日志」页看实时进度
4. 支持暂停 / 继续 / 停止，进度自动保存，下次从断点继续

## 免责声明

本工具仅供学习与技术研究使用。使用本工具产生的一切后果（包括但不限于违反平台/学校规定）由使用者自行承担。购买即视为知悉并同意此条款。

## 发布检查清单（维护者）

- [ ] `npm run typecheck` 通过
- [ ] `npm run typecheck && npm run smoke && node scripts/verify-ui.mjs && node scripts/verify-installer.mjs` 全绿
- [ ] `npm run dist` 产出 `release/CourseHelper-Setup-<版本>.exe`
- [ ] 记录 SHA256：`Get-FileHash release\CourseHelper-Setup-<版本>.exe -Algorithm SHA256`
- [ ] 干净虚拟机：安装 → 拉课程 → 跑一门 → 卸载
- [ ] GitHub Release 附安装包 + 宣传视频 + SHA256 + 本页 SmartScreen 说明
