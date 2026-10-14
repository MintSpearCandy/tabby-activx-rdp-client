// tabs-switch-test.js — switch away from the RDP tab and back via the tab
// bar, sampling the popup's native visibility around each switch, and check
// the native trace for UpdateSessionDisplaySettings calls during the switch
// (the old coordinate-park re-negotiated the remote resolution to 640x480).
// Usage: node scripts/tabs-switch-test.js [port]
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
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
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
"@
[V]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$vis = $null
$cb = {
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 64
  [void][V]::GetClassNameW($h, $sb, 64)
  if ($sb.ToString() -like 'AtlAxWin*') { $script:vis = [V]::IsWindowVisible($h) }
  return $true
}
[void][V]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output "visible=$vis"
`], { encoding: 'utf8' })
    return out.trim()
}

function traceSize () {
    const p = path.join(os.tmpdir(), 'tabby-activx-rdp', 'trace.log')
    return fs.existsSync(p) ? fs.statSync(p).size : 0
}

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.url.includes('index'))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 1
    const pending = new Map()
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    }
    const evalJs = expr => new Promise(res => {
        const i = id++
        pending.set(i, res)
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    })
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    console.log('baseline:', popupVisible())
    const t0 = traceSize()

    // Switch away: click the FIRST tab header (an idle error tab).
    await evalJs(`(() => {
        const h = document.querySelectorAll('tab-header')[0];
        h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'clicked';
    })()`)
    await sleep(1200)
    console.log('switched away:', popupVisible())

    // Switch back: click the LAST tab header (the connected RDP tab).
    await evalJs(`(() => {
        const hs = document.querySelectorAll('tab-header');
        hs[hs.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'back';
    })()`)
    await sleep(1200)
    console.log('switched back:', popupVisible())

    const t1 = traceSize()
    // Read the tail of the trace to inspect what the switch produced.
    const p = path.join(os.tmpdir(), 'tabby-activx-rdp', 'trace.log')
    const tail = fs.readFileSync(p, 'utf8').slice(-(t1 - t0) - 64)
    const disp = tail.split('\n').filter(l => l.includes('UpdateSessionDisplaySettings'))
    console.log('display negotiations during switch:', disp.length ? disp : 'none')
    ws.close()
    process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
