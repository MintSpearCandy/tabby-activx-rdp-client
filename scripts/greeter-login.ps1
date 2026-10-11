# greeter-login.ps1 — auto-type credentials into the xrdp greeter shown in the
# RDP popup (the WSL test target has no NLA in xrdp 0.9.x so the greeter is
# expected; real Windows targets log in via CredSSP/NLA).
#
# Focus chain that works: activate the RDP tab (CDP), bring the window up,
# then CLICK the popup itself — only a real click hands the keyboard to the
# mstscax surface; SetForegroundWindow on the owner leaves focus in the web
# content and SendKeys land in a local terminal.
# Usage: powershell -File scripts\greeter-login.ps1 [-User mscandy] [-Pass rdppoc123]
param(
  [string]$User = 'mscandy',
  [string]$Pass = 'rdppoc123',
  [string]$PathLike = '*arc*'
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct R4 { public int L, T, Rt, B; }
public class G {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R4 r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
"@

# Per-Monitor V2: all coordinates in raw physical pixels.
[G]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

$pids = @((Get-Process -Name Tabby -ErrorAction Stop | Where-Object { $_.Path -like $PathLike }).Id)
$proc = Get-Process -Name Tabby | Where-Object { $_.Path -like $PathLike -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Output 'no Tabby window'; exit 1 }

# Find the visible AtlAxWin popup belonging to the arc processes.
$script:popup = $null
$cb = {
  param($h, $l)
  $pid2 = [uint32]0
  [G]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pids -contains [int]$pid2 -and [G]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 64
    [G]::GetClassNameW($h, $sb, 64) | Out-Null
    if ($sb.ToString().StartsWith('AtlAxWin')) {
      $r = New-Object R4
      [G]::GetWindowRect($h, [ref]$r) | Out-Null
      if ($r.L -gt -10000) { $script:popup = @{ H = $h; R = $r } }
    }
  }
  return $true
}
[G]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if (-not $popup) { Write-Output 'no visible popup (is the RDP tab active?)'; exit 1 }

[G]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 200
[G]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
[G]::SetForegroundWindow($popup.H) | Out-Null
Start-Sleep -Milliseconds 300

# Click the greeter dialog's username area: the xrdp login dialog sits in the
# popup's UPPER-LEFT (on large panes the popup center lands on empty teal
# background and focus never reaches the form).
$r = $popup.R
$cx = [int]($r.L + ($r.Rt - $r.L) * 0.22)
$cy = [int]($r.T + ($r.B - $r.T) * 0.30)
Add-Type "using System; using System.Runtime.InteropServices; public class FG1 { [DllImport(""user32.dll"")] public static extern IntPtr GetForegroundWindow(); }"
# Click and VERIFY the popup actually holds the foreground — the user's own
# windows (video player etc.) race us for it, and SendKeys silently go to
# whoever ends up in front. Retry a few times before giving up.
$fgOk = $false
for ($try = 1; $try -le 4; $try++) {
  [G]::SetCursorPos($cx, $cy) | Out-Null
  Start-Sleep -Milliseconds 150
  [G]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [G]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 450
  $fgH = [FG1]::GetForegroundWindow()
  if ($fgH -eq $popup.H) { $fgOk = $true; break }
  Write-Output ("click {0}: foreground stolen (0x{1:x}), retrying" -f $try, $fgH)
}
if ($fgOk) {
  # Username (greeter opens focused in it), tab, password, enter — typed as
  # raw keystrokes through the mstscax keyboard path. The RDP clipboard channel
  # syncs asynchronously: pasting right after Set-Clipboard raced it and got
  # stale/partial content ("av") submitted to sesman.
  function Esc-ForSendKeys ([string]$s) {
    # escape SendKeys metacharacters
    return ($s -replace '([+^%~(){}\[\]])', '{$1}')
  }
  [System.Windows.Forms.SendKeys]::SendWait((Esc-ForSendKeys $User))
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait((Esc-ForSendKeys $Pass))
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Output ('clicked popup 0x{0:x} at {1},{2} — credentials typed' -f $popup.H, $cx, $cy)
} else {
  # Foreground unrecoverable (always-on-top windows keep stealing it): post
  # the keystrokes directly to the popup with PostMessage — no foreground
  # needed. WM_CHAR per character, VK keys for TAB/ENTER.
  Write-Output ('foreground stolen — falling back to PostMessage keys to popup 0x{0:x}' -f $popup.H)
  Add-Type "using System; using System.Runtime.InteropServices; public class PM1 { [DllImport(""user32.dll"")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }"
  foreach ($ch in $User.ToCharArray()) { [PM1]::PostMessage($popup.H, 0x102, [IntPtr][int][char]$ch, [IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 40 }
  [PM1]::PostMessage($popup.H, 0x100, [IntPtr]9, [IntPtr]::Zero)  | Out-Null  # WM_KEYDOWN VK_TAB
  [PM1]::PostMessage($popup.H, 0x101, [IntPtr]9, [IntPtr]::Zero)  | Out-Null  # WM_KEYUP
  Start-Sleep -Milliseconds 150
  foreach ($ch in $Pass.ToCharArray()) { [PM1]::PostMessage($popup.H, 0x102, [IntPtr][int][char]$ch, [IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 40 }
  [PM1]::PostMessage($popup.H, 0x100, [IntPtr]13, [IntPtr]::Zero) | Out-Null  # WM_KEYDOWN VK_RETURN
  [PM1]::PostMessage($popup.H, 0x101, [IntPtr]13, [IntPtr]::Zero) | Out-Null  # WM_KEYUP
  Write-Output 'credentials posted'
}

# (The focused-input path lives in the $fgOk branch above; the PostMessage
# fallback covers stolen foregrounds. No leading ^a in either: the greeter's
# fields don't support select-all and Ctrl-A lands as a literal 'a'.)

