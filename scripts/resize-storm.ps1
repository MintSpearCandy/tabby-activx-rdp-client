# resize-storm.ps1 — hammer an electron window with rapid SetWindowPos calls,
# simulating the user dragging the window edge continuously.
# Usage: powershell -File tools\resize-storm.ps1 [-ProcId <pid>] [-Seconds 30]
param(
  [int]$ProcId = 0,
  [int]$Seconds = 30,
  [int]$IntervalMs = 20
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}
"@

if (-not $ProcId) {
  $p = Get-Process Tabby -ErrorAction Stop | Where-Object { $_.Path -like "*arc*" } | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { Write-Output 'no electron window found'; exit 1 }
  $ProcId = $p.Id
}
$proc = Get-Process -Id $ProcId -ErrorAction Stop
$h = $proc.MainWindowHandle
if (-not $h) { Write-Output "pid $ProcId has no window"; exit 1 }

$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
Write-Output ("storming pid={0} hwnd=0x{1:x} rect=({2},{3} {4}x{5}) for {6}s every {7}ms" -f $ProcId, $h, $r.L, $r.T, $w, $ht, $Seconds, $IntervalMs)

$SWP_NOMOVE = 0x2
$deadline = (Get-Date).AddSeconds($Seconds)
$i = 0
while ((Get-Date) -lt $deadline) {
  # grow then shrink, mimicking drag jitter around a target size
  $dw = [Math]::Sin($i / 7.0) * 180
  $dw2 = [Math]::Sin($i / 5.3) * 120
  [Win]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, [int]($w + $dw), [int]($ht + $dw2), $SWP_NOMOVE) | Out-Null
  $i++
  Start-Sleep -Milliseconds $IntervalMs
}
Write-Output "storm done: $i resizes sent; process exited: $((Get-Process -Id $ProcId -ErrorAction SilentlyContinue) -eq $null)"
