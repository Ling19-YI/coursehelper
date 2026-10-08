param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$OutDir = '',
  [string]$Match = 'coursehelper'
)
$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'promo\shots' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;
public class C2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][C2]::SetProcessDPIAware()   # 必须最先调用，避免 175% 缩放导致裁切

$proc = Get-Process | Where-Object { $_.Path -and $_.Path -like "*$Match*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Host 'window not found'; exit 1 }
$h = $proc.MainWindowHandle
[void][C2]::ShowWindow($h, 5)
[void][C2]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 700

$r = New-Object C2+RECT
[void][C2]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Host 'bad rect'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][C2]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$file = Join-Path $OutDir ($Out + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "captured $file ($w x $ht)"