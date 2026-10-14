# phys-shot.ps1 — physical screenshot of a window rectangle (native popups are
# invisible to CDP captureScreenshot; CopyFromScreen sees the real screen).
# Usage: powershell -File scripts\phys-shot.ps1 [-WindowTitle <like-pattern>] [-Out <path>]
param(
  [string]$WindowTitle = 'Tabby',
  [string]$Out = "out\phys-shot.png",
  [string]$PathLike = '*arc*'
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern IntPtr FindWindowW([MarshalAs(UnmanagedType.LPWStr)] string cls, [MarshalAs(UnmanagedType.LPWStr)] string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public struct RECT { public int L, T, R, B; }
}
"@

# Per-Monitor V2 (-4): physical pixels everywhere, no cross-monitor rescale.
[Win]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$proc = Get-Process -Name Tabby -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and ($_.Path -like $PathLike) } |
    Select-Object -First 1
if (-not $proc) {
  $proc = Get-Process -Name Tabby -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
$h = if ($proc) { $proc.MainWindowHandle } else { [IntPtr]::Zero }
if ($h -eq [IntPtr]::Zero) { Write-Output 'no window found'; exit 1 }

$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
Write-Output ("window 0x{0:x} rect=({1},{2} {3}x{4})" -f $h, $r.L, $r.T, $w, $ht)

# Foreground the window first: CopyFromScreen captures the screen region, so
# anything stacked above the target would pollute the shot. A background
# process may only take foreground after an ALT keypress.
[Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][Win]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
$g.Dispose()
$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $Out"
