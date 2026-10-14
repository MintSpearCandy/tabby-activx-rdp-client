// tooltip-noyield-test.js — hover a tab header via the CDP input layer to
// trigger ngbTooltip (rendered as a body child), then verify the RDP popup
// STAYS visible: tooltips are pointer-events:none hint layers and must not
// trigger the overlay yield.
// Usage: node scripts/tooltip-noyield-test.js [port]
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
    const call = (method, params = {}) => new Promise(res => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const evalJs = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value

    console.log('baseline:', popupVisible())

    const pos = await evalJs(`(() => {
        const h = document.querySelectorAll('tab-header')[0];
        const r = h.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    console.log('hover target:', JSON.stringify(pos))

    // Park the cursor on the header until the tooltip opens.
    for (let i = 0; i < 6; i++) {
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y })
        await sleep(300)
    }
    await sleep(1200)
    const tooltip = await evalJs(`(() => {
        const t = document.querySelector('body > .tooltip, body > ngb-tooltip-window');
        if (!t) return { shown: false };
        const r = t.getBoundingClientRect();
        const cs = getComputedStyle(t);
        return { shown: true, rect: [r.x, r.y, r.width, r.height], pe: cs.pointerEvents };
    })()`)
    console.log('tooltip:', JSON.stringify(tooltip))
    console.log('with tooltip:', popupVisible())

    // Move away, let it close.
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 700 })
    await sleep(1500)
    console.log('after hover away:', popupVisible())
    ws.close()
    process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
