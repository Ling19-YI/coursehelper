param([string]$OutDir = (Join-Path $PSScriptRoot '..\promo\shots'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  public static List<string> Children(IntPtr parent) {
    var r = new List<string>();
    IntPtr c = FindWindowEx(parent, IntPtr.Zero, null, null);
    while (c != IntPtr.Zero) {
      var cn = new StringBuilder(64); GetClassName(c, cn, 64);
      var tx = new StringBuilder(256); GetWindowText(c, tx, 256);
      r.Add(c.ToInt64() + "|" + cn.ToString() + "|" + tx.ToString());
      c = FindWindowEx(parent, c, null, null);
    }
    return r;
  }
  public static void Click(IntPtr h) { SendMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }   // BM_CLICK
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool Dlg(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Dlg d, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<string> List() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.Length > 0) r.Add(h.ToInt64() + "|" + sb.ToString()); }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
[void][Win]::SetProcessDPIAware()   # 抓图前先声明 DPI 感知，避免缩放裁切

function Save-Window([IntPtr]$h, [string]$name) {
  $r = New-Object Win+RECT
  [void][Win]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  if ($w -le 0 -or $ht -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # 优先 PrintWindow（不受遮挡影响）
  $hdc = $g.GetHdc()
  [void][Win]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $path = Join-Path $OutDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "  shot -> $name ($w x $ht)"
  return $true
}

function Save-Screen([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $path = Join-Path $OutDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "  shot -> $name (screen)"
}

$ws = New-Object -ComObject WScript.Shell

# ---------- 0. 关掉已安装的旧版 ----------
$instDir = Join-Path $env:LOCALAPPDATA 'Programs\coursehelper'
Get-Process | Where-Object { $_.Path -like "$instDir*" } | ForEach-Object { try { $_.Kill() } catch {} }
Start-Sleep -Milliseconds 800
$unins = Get-ChildItem $instDir -Filter 'Un*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($unins) {
  Write-Host "卸载旧版: $($unins.Name)"
  Start-Process -FilePath $unins.FullName -ArgumentList '/S' -Wait
  Start-Sleep -Seconds 3
}

# ---------- 1. 安装向导截图 ----------
$setup = Get-ChildItem (Join-Path $PSScriptRoot '..\release\CourseHelper-Setup-*.exe') | Select-Object -First 1
if (-not $setup) { throw 'installer not found' }
Get-Process | Where-Object { $_.Path -like '*CourseHelper-Setup*' } | ForEach-Object { try { $_.Kill() } catch {} }
Write-Host "启动安装向导: $($setup.Name)"
$p = Start-Process -FilePath $setup.FullName -PassThru

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 500
  $p.Refresh()
  if ($p.HasExited) { throw "installer exited early code=$($p.ExitCode)" }
  $h = $p.MainWindowHandle
}
if ($h -eq [IntPtr]::Zero) { throw 'installer window not found' }
[void][Win]::ShowWindow($h, 5)   # SW_SHOW
[void][Win]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1200

Write-Host '捕获向导页面...'
function Get-Handle($proc) {
  for ($i = 0; $i -lt 20; $i++) {
    $proc.Refresh()
    if (-not $proc.HasExited -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { return $proc.MainWindowHandle }
    Start-Sleep -Milliseconds 300
  }
  return [IntPtr]::Zero
}

# 点击页面上匹配的正向按钮（下一步/安装/完成）
function Click-Next([IntPtr]$h) {
  $pats = '下一步|安装|完成|确定|是\(&Y\)|next|install|finish'
  foreach ($c in [Win]::Children($h)) {
    $parts = $c -split '\|', 3
    if ($parts.Length -lt 3) { continue }
    $cls = $parts[1]; $txt = ($parts[2] -replace '&', '')
    if ($cls -match 'Button' -and $txt -match $pats) {
      [Win]::Click([IntPtr]::new([int64]$parts[0]))
      return $txt
    }
  }
  # 兜底：直接发回车
  [void][Win]::PostMessage($h, 0x0100, [IntPtr]0x0D, [IntPtr]::Zero)   # WM_KEYDOWN VK_RETURN
  [void][Win]::PostMessage($h, 0x0101, [IntPtr]0x0D, [IntPtr]::Zero)   # WM_KEYUP
  return $null
}

$exePath = Join-Path $env:LOCALAPPDATA 'Programs\coursehelper\刷课助手 CourseHelper.exe'
for ($step = 1; $step -le 8; $step++) {
  $hh = Get-Handle $p
  if ($hh -eq [IntPtr]::Zero) { Write-Host "  向导窗口已关闭（第 $step 页后）"; break }
  [void][Win]::ShowWindow($hh, 5)
  [void][Win]::SetForegroundWindow($hh)
  Start-Sleep -Milliseconds 400
  [void](Save-Window $hh ("wizard-$step.png"))
  $btn = Click-Next $hh
  Write-Host "  点击: $btn"
  Start-Sleep -Milliseconds 1800
  if (Test-Path $exePath) {
    # 已装好，可能停在「完成」页，再截一张
    $hh2 = Get-Handle $p
    if ($hh2 -ne [IntPtr]::Zero) { [void][Win]::ShowWindow($hh2, 5); [void][Win]::SetForegroundWindow($hh2); Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
    $hh3 = Get-Handle $p
    if ($hh3 -ne [IntPtr]::Zero) { [void](Save-Window $hh3 ("wizard-$($step + 1)-finish.png")) }
    break
  }
}

# 点完 Finish 后窗口关闭
for ($i = 0; $i -lt 20 -and -not $p.HasExited; $i++) { Start-Sleep -Milliseconds 500; $p.Refresh() }
if (-not $p.HasExited) { try { $p.Kill() } catch {} }

$exe = Join-Path $instDir '刷课助手 CourseHelper.exe'
if (Test-Path $exe) { Write-Host "已安装: $exe" } else { throw 'install failed' }

# ---------- 2. SmartScreen 提示截图（模拟下载文件带 MOTW） ----------
Write-Host '捕获 SmartScreen 提示...'
$dl = Join-Path $PSScriptRoot '..\promo\dl'
New-Item -ItemType Directory -Force -Path $dl | Out-Null
$tmp = Join-Path $dl 'CourseHelper-Setup-1.0.0.exe'
Copy-Item $setup.FullName $tmp -Force
try {
  Set-Content -Path "$tmp`:Zone.Identifier" -Value "[ZoneTransfer]`nZoneId=3`n" -Encoding ASCII -ErrorAction Stop
} catch { Write-Host '  (无法写入 Zone.Identifier，跳过)' }

$sp = Start-Process -FilePath $tmp -PassThru
Start-Sleep -Seconds 4
# 找一个像 SmartScreen 的窗口
$target = $null
foreach ($t in [Win]::List()) {
  $parts = $t -split '\|', 2
  $title = $parts[1]
  if ($title -match 'SmartScreen|Windows.*保护|已保护你的电脑|protected your PC') { $target = [IntPtr]::new([int64]$parts[0]); $title; break }
}
if ($target -ne [IntPtr]::Zero) {
  [void][Win]::SetForegroundWindow($target)
  Start-Sleep -Milliseconds 700
  [void](Save-Window $target 'smartscreen-1.png')
  # 展开「更多信息」
  $ws.SendKeys('%a'); Start-Sleep -Milliseconds 800
  [void][Win]::SetForegroundWindow($target)
  [void](Save-Window $target 'smartscreen-2-more.png')
  $ws.SendKeys('{ESC}'); Start-Sleep -Milliseconds 500
} else {
  Write-Host '  未出现 SmartScreen 对话框（Defender 设置或策略所致）→ 改用设计稿示意'
  Save-Screen 'smartscreen-screen.png'
}
if (-not $sp.HasExited) { try { $sp.Kill() } catch {} }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Remove-Item "$tmp`:Zone.Identifier" -Force -ErrorAction SilentlyContinue

Write-Host "DONE -> $OutDir"