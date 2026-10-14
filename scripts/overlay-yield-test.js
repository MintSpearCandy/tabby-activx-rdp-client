// overlay-yield-test.js — open the command palette via CDP, sample the RDP
// popup's native visibility, close it, sample again. The popup must yield
// (SW_HIDE) while the palette covers the hole and come back after Esc.
// Usage: node scripts/overlay-yield-test.js [port]
const { execFileSync } = require('child_process')
const port = process.argv[2] || 9242

function popupVisible () {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class V {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct R { public int L, T, Rt, B; }
}
"@
[V]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$vis = $null; $rect = $null
$cb = {
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 64
  [void][V]::GetClassNameW($h, $sb, 64)
  if ($sb.ToString() -like 'AtlAxWin*') { $script:vis = [V]::IsWindowVisible($h); $r = New-Object V+R; [void][V]::GetWindowRect($h, [ref]$r); $script:rect = "$($r.L),$($r.T) $($r.Rt-$r.L)x($r.B-$r.T)" }
  return $true
}
[void][V]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output "visible=$vis rect=$rect"
`], { encoding: 'utf8' })
    return out.trim()
}

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.url.includes('index'))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 1
    const pending = new Map()
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    }
    const call = (method, params = {}) => new Promise(res => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const evalJs = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value

    console.log('baseline:', popupVisible())

    await evalJs('document.activeElement && document.activeElement.blur(), "ok"')
    const chord = [
        { type: 'keyDown', modifiers: 10, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 },
        { type: 'keyUp', modifiers: 10, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 },
    ]
    for (let round = 0; round < 2; round++) {
        for (const k of chord) { await call('Input.dispatchKeyEvent', k); await sleep(30) }
        await sleep(280)
    }
    await sleep(900)
    const paletteOpen = await evalJs(`!!document.querySelector('input[placeholder="Commands"]')`)
    console.log('palette open:', paletteOpen)
    await sleep(300)
    console.log('with palette:', popupVisible())

    // Close via the proven path (scripts/closeAllModals.js): focus each
    // stacked modal's input and dispatch Escape on it.
    for (let layer = 0; layer < 6; layer++) {
        const closed = await evalJs(`(() => {
            const inp = document.querySelector('ngb-modal-window input');
            if (!inp) return 0;
            inp.focus();
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            return 1;
        })()`)
        if (!closed) break
        await sleep(600)
    }
    await sleep(900)
    const paletteClosed = await evalJs(`!document.querySelector('input[placeholder="Commands"]')`)
    console.log('palette closed:', paletteClosed)
    await sleep(300)
    console.log('after close:', popupVisible())
    ws.close()
}

main().catch(e => { console.error(e); process.exit(1) })
