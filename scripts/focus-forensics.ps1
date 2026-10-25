# focus-forensics.ps1 — report the Win32 focus/foreground state of the arc
# instance's windows (renderer threads + RDP popup), optionally clicking the
# popup center with REAL input first (the popup is a native window; CDP
# synthetic clicks never reach it).
# Usage: powershell -File scripts\focus-forensics.ps1 [-ClickPopup] [-SendText 'x']
param(
  [switch]$ClickPopup,
  [string]$SendText = ''
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUIINFO gi);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct R { public int L, T, Rt, B; }
  [StructLayout(LayoutKind.Sequential)]
  public struct GUIINFO {
    public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus;
    public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }
}
"@
[F]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

# find the RDP popup and the electron main window of the arc instance
$script:popup = [IntPtr]::Zero; $script:popupRect = New-Object F+R
$script:electron = [IntPtr]::Zero
$cb = {
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 64
  [void][F]::GetClassNameW($h, $sb, 64)
  $cls = $sb.ToString()
  if ($cls -like 'AtlAxWin*') {
    $script:popup = $h; $r = New-Object F+R; [void][F]::GetWindowRect($h, [ref]$r); $script:popupRect = $r
  }
  if ($cls -eq 'Chrome_WidgetWin_1' -and $script:electron -eq [IntPtr]::Zero) {
    $pid2 = 0; [void][F]::GetWindowThreadProcessId($h, [ref]$pid2)
    $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -like '*arc*') { $script:electron = $h }
  }
  return $true
}
[void][F]::EnumWindows($cb, [IntPtr]::Zero)

Write-Output ("popup=0x{0:x} visible={1} rect=({2},{3} {4}x{5})" -f $popup,
  [F]::IsWindowVisible($popup), $popupRect.L, $popupRect.T,
  ($popupRect.Rt-$popupRect.L), ($popupRect.B-$popupRect.T))

if ($ClickPopup -and $popup -ne [IntPtr]::Zero) {
  # ALT first (background process foreground rule), then real click at center
  [F]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [F]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][F]::SetForegroundWindow($popup)
  Start-Sleep -Milliseconds 300
  $cx = $popupRect.L + ($popupRect.Rt - $popupRect.L) / 2
  $cy = $popupRect.T + ($popupRect.B - $popupRect.T) / 2
  [void][F]::SetCursorPos($cx, $cy)
  [F]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)              # LEFTDOWN
  [F]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)              # LEFTUP
  Start-Sleep -Milliseconds 400
  Write-Output ("clicked popup center at {0},{1}" -f $cx, $cy)
}

if ($SendText) {
  # type into whatever is focused (real input path; a low-level keyboard
  # hook that swallows keys makes this a no-op)
  foreach ($ch in $SendText.ToCharArray()) {
    $vk = [int][char]::ToUpper($ch)
    [F]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)   # Ctrl down
    [F]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)    # key down
    [F]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)    # key up
    [F]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)   # Ctrl up
  }
  Start-Sleep -Milliseconds 200
}

$fg = [F]::GetForegroundWindow()
$sbFg = New-Object System.Text.StringBuilder 64
[void][F]::GetClassNameW($fg, $sbFg, 64)
Write-Output ("foreground=0x{0:x} class={1}" -f $fg, $sbFg.ToString())

# GUI thread info for: the popup's thread and the electron window's thread
foreach ($target in @($popup, $electron)) {
  if ($target -eq [IntPtr]::Zero) { continue }
  $t_pid = 0
  $tid = [F]::GetWindowThreadProcessId($target, [ref]$t_pid)
  $gi = New-Object F+GUIINFO
  $gi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($gi)
  if ([F]::GetGUIThreadInfo($tid, [ref]$gi)) {
    $focusCls = New-Object System.Text.StringBuilder 64
    if ($gi.hwndFocus -ne [IntPtr]::Zero) { [void][F]::GetClassNameW($gi.hwndFocus, $focusCls, 64) }
    Write-Output ("thread {0} (pid {1}, of 0x{2:x}): focus=0x{3:x} ({4})" -f $tid, $t_pid, $target,
      $gi.hwndFocus, $(if ($gi.hwndFocus -ne [IntPtr]::Zero) { $focusCls.ToString() } else { 'NULL' }))
  }
}
