# popup-rect.ps1 — enumerate the arc instance's native windows (the RDP
# AtlAxWin popup) and print their physical rects vs the Tabby main window.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class P {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct R { public int L, T, Rt, B; }
}
"@

# Per-Monitor V2 (-4): system-DPI-aware observers get coordinates for OTHER
# monitors rescaled (x1.5/1.25 here), which previously made correct popups
# look misplaced.
[P]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$target = (Get-Process -Name Tabby -ErrorAction Stop | Where-Object { $_.Path -like '*arc*' } | Select-Object -First 1).Id
Write-Output "arc pids: $((Get-Process -Name Tabby | Where-Object { $_.Path -like '*arc*' }).Id -join ',')"

$out = @()
$cb = {
  param($h, $l)
  $pid2 = 0
  [P]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pid2 -eq $target -or $true) {
    # filter later; collect Tabby-pid top-levels with class names
    $sb = New-Object System.Text.StringBuilder 256
    [P]::GetClassNameW($h, $sb, 256) | Out-Null
    $cls = $sb.ToString()
    if ($cls -match 'AtlAx|Chrome_WidgetWin') {
      $r = New-Object P+R
      [P]::GetWindowRect($h, [ref]$r) | Out-Null
      $script:out += [pscustomobject]@{
        Hwnd = ('0x{0:x}' -f $h)
        Pid = $pid2
        Class = $cls
        Visible = [P]::IsWindowVisible($h)
        Owner = ('0x{0:x}' -f [P]::GetWindow($h, 4))   # GW_OWNER
        Rect = "$($r.L),$($r.T) $($r.Rt-$r.L)x$($r.B-$r.T)"
      }
    }
  }
  return $true
}
[P]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$out | Where-Object { $_.Pid -in ((Get-Process -Name Tabby | Where-Object { $_.Path -like '*arc*' }).Id) } | Format-Table -AutoSize
