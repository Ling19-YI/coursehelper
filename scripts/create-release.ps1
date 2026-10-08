param([string]$Version = '1.0.0')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exePath = Join-Path $root "release\CourseHelper-Setup-$Version.exe"
if (-not (Test-Path $exePath)) { throw "installer not found: $exePath" }

$sha = (Get-FileHash $exePath -Algorithm SHA256).Hash
Write-Host "SHA256: $sha"

$all = (("protocol=https`nhost=github.com`n`n") | git credential fill | Out-String)
$tok = [regex]::Match($all, '(?m)^password=(.*)$').Groups[1].Value.Trim()
if (-not $tok) { throw 'github credential not found' }

$h = @{
  Authorization = "Bearer $tok"
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'coursehelper-release'
  'X-GitHub-Api-Version' = '2022-11-28'
}

$notes = @"
## 刷课助手 CourseHelper v$Version（首个发布版）

超星学习通（泛雅）自动刷课桌面客户端。单窗口内嵌浏览器，无需另装 Chrome/Edge。

### 下载
- ``CourseHelper-Setup-$Version.exe``（约 110 MB，Windows 10/11 x64）
- SHA256：``$sha``

### ⚠️ 安装前必读（SmartScreen 提示）
本软件**未购买代码签名证书**，首次运行可能弹出「Windows 已保护你的电脑」，这是**正常现象**：
1. 点击左下角 **「更多信息」**
2. 点击 **「仍要运行」**（只需操作一次）

### 功能
- **完全免费，无需激活码**
- 自动播放视频章节（保持平台 1x 倍速，不篡改倍速），页内守护 + 鼠标抖动防暂停
- 文档/PDF 任务点自动滚动到底并等待平台确认
- 断点续跑：进度本机落盘；**平台已手动刷过的章节自动跳过**，整课已完成的课程直接跳过
- 章节测验自动答题（选填，需配置 DeepSeek Key）
- 暂停 / 继续 / 停止，实时日志

### 使用
1. 安装后直接打开即可使用
2. 「设置」页填写超星账号 → 「课程」页勾选 → 「任务」页开始

### 支持作者（自愿）
软件完全免费。宣传视频结尾有微信收款码，觉得有用可以请作者喝杯奶茶 —— 不支持也完全不影响使用。

### 免责声明
本工具仅供学习与技术研究使用，使用产生的一切后果由使用者自行承担。
"@

$body = @{
  tag_name = "v$Version"
  target_commitish = 'main'
  name = "v$Version"
  body = $notes
  draft = $false
  prerelease = $false
} | ConvertTo-Json

$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/Ling19-YI/coursehelper/releases' -Method Post -Headers $h -Body $body -ContentType 'application/json'
Write-Host "release: $($rel.html_url)"

$upload = [regex]::Replace($rel.upload_url, '\{\?name,label\}$', '')
$assetUrl = "$upload" + "?name=" + [uri]::EscapeDataString((Split-Path $exePath -Leaf))
$asset = Invoke-RestMethod -Uri $assetUrl -Method Post -Headers @{ Authorization = $h.Authorization; Accept = $h.Accept; 'User-Agent' = $h['User-Agent'] } -ContentType 'application/octet-stream' -InFile $exePath -TimeoutSec 1800
Write-Host "asset: $($asset.browser_download_url)"

$tok = $null; $all = $null
