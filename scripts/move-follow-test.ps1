# move-follow-test.ps1 — move the arc instance's main window by (+200,+100),
# then sample the RDP popup's rect after a short delay (well under the old
# 300 ms glue period). If the popup followed within the delay, the WinEvent
# re-anchor path works.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public struct R { public int L, T, Rt, B; }
}
"@
[M]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

function Find-Windows {
  $found = @{}
  $cb = {
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 64
    [void][M]::GetClassNameW($h, $sb, 64)
    $cls = $sb.ToString()
    if ($cls -like 'AtlAxWin*') { $found['popup'] = $h }
    if ($cls -eq 'Chrome_WidgetWin_1') {
      $rp = 0
      [void][M]::GetWindowThreadProcessId($h, [ref]$rp)
      $proc = Get-Process -Id $rp -ErrorAction SilentlyContinue
      if ($proc -and $proc.Path -like '*arc*') { $found['owner'] = $h }
    }
    return $true
  }
  [void][M]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

$w = Find-Windows
if (-not $w['popup'] -or -not $w['owner']) { Write-Output "popup=$($w['popup']) owner=$($w['owner']) — not found"; exit 1 }

$r0 = New-Object M+R; [void][M]::GetWindowRect($w['popup'], [ref]$r0)
Write-Output ("before: popup {0},{1} {2}x{3}" -f $r0.L, $r0.T, ($r0.Rt-$r0.L), ($r0.B-$r0.T))

# Move the owner (+200,+100), keep size: SWP_NOZORDER(0x4)|SWP_NOACTIVATE(0x10)|SWP_ASYNCWINDOWPOS(0x4000)
$r1 = New-Object M+R; [void][M]::GetWindowRect($w['owner'], [ref]$r1)
[void][M]::SetWindowPos($w['owner'], [IntPtr]::Zero, ($r1.L+200), ($r1.T+100), ($r1.Rt-$r1.L), ($r1.B-$r1.T), 0x4014)
$r1b = New-Object M+R; [void][M]::GetWindowRect($w['owner'], [ref]$r1b)
Write-Output ("owner now: {0},{1}" -f $r1b.L, $r1b.T)

Start-Sleep -Milliseconds 100
$r2 = New-Object M+R; [void][M]::GetWindowRect($w['popup'], [ref]$r2)
$dx = $r2.L - $r0.L; $dy = $r2.T - $r0.T
Write-Output ("after 100ms: popup {0},{1} — delta {2},{3} (expected 200,100)" -f $r2.L, $r2.T, $dx, $dy)
if ($dx -eq 200 -and $dy -eq 100) { Write-Output 'FOLLOWED: WinEvent re-anchor works'; exit 0 }
else { Write-Output 'NOT FOLLOWED yet'; exit 2 }
