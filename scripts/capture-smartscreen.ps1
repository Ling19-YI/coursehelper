param([string]$OutDir = (Join-Path $PSScriptRoot '..\promo\shots'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class W2 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
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

function Save-W([IntPtr]$h, [string]$name) {
  $r = New-Object W2+RECT
  [void][W2]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  if ($w -le 0 -or $ht -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][W2]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "  shot -> $name ($w x $ht)"
}

$ws = New-Object -ComObject WScript.Shell
$dl = Join-Path $PSScriptRoot '..\promo\dl'
New-Item -ItemType Directory -Force -Path $dl | Out-Null
$setup = Get-ChildItem (Join-Path $PSScriptRoot '..\release\CourseHelper-Setup-*.exe') | Select-Object -First 1
$tmp = Join-Path $dl 'CourseHelper-Setup-1.0.0.exe'
Copy-Item $setup.FullName $tmp -Force

$ads = "$tmp`:Zone.Identifier"
if (-not (Test-Path -LiteralPath $ads)) {
  Set-Content -LiteralPath $ads -Encoding ASCII -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://github.com/Ling19-YI/coursehelper/releases/download/v1.0.0/CourseHelper-Setup-1.0.0.exe`r`n"
}
Write-Host "启动带 MOTW 的安装包副本（不会真正安装，只为触发 SmartScreen）..."
$sp = Start-Process -FilePath $tmp -PassThru

$target = [IntPtr]::Zero
for ($i = 0; $i -lt 20 -and $target -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 600
  foreach ($t in [W2]::List()) {
    $parts = $t -split '\|', 2
    if ($parts[1] -match 'SmartScreen|Windows.*保护|已保护你的电脑|protected your PC') {
      $target = [IntPtr]::new([int64]$parts[0]); break
    }
  }
}

if ($target -eq [IntPtr]::Zero) {
  Write-Host '未出现 SmartScreen（Defender 设置/策略所致）'
} else {
  Write-Host 'SmartScreen 出现'
  [void][W2]::ShowWindow($target, 5)
  [void][W2]::SetForegroundWindow($target)
  Start-Sleep -Milliseconds 1200
  Save-W $target 'smartscreen-1.png'
  # Alt+A = 显示更多选项（SmartScreen 的访问键）
  [void][W2]::PostMessage($target, 0x0100, [IntPtr]0x12, [IntPtr]::Zero)   # WM_SYSKEYDOWN ALT
  [void][W2]::PostMessage($target, 0x0101, [IntPtr]0x41, [IntPtr]::Zero)   # 'A'
  Start-Sleep -Milliseconds 1200
  Save-W $target 'smartscreen-2-more.png'
  [void][W2]::PostMessage($target, 0x0100, [IntPtr]0x1B, [IntPtr]::Zero)   # ESC 关闭
  Start-Sleep -Milliseconds 800
}

if (-not $sp.HasExited) { try { $sp.Kill() } catch {} }
Start-Sleep -Milliseconds 500
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Write-Host 'DONE'