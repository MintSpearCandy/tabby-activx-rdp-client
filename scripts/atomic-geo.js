// atomic-geo.js — one-shot geometry dump: DOM rect + Electron DIP + zoom +
// scale + native popup rect (via a helper ps1), all within the same moment.
// Usage: node scripts/atomic-geo.js [port]
const { execFileSync } = require('child_process')
const path = require('path')

const port = process.argv[2] || 9242

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null)).json()
    if (!list) { console.error('CDP down'); process.exit(1) }
    const page = list.find(t => t.type === 'page' && t.url.includes('index'))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let nextId = 1
    const pending = new Map()
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m.result)
            pending.delete(m.id)
        }
    }
    const call = (method, params = {}) => new Promise(resolve => {
        const id = nextId++
        pending.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params }))
    })
    const evalJs = async (expr) => {
        const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true })
        return r.result && r.result.value
    }

    const dom = await evalJs(`(() => {
        const hole = document.querySelector('activx-rdp-tab .hole');
        const r = hole ? hole.getBoundingClientRect() : null;
        const tb = document.querySelector('.tab-bar');
        const tr = tb ? tb.getBoundingClientRect() : null;
        const remote = require('@electron/remote');
        const win = remote.getCurrentWindow();
        const cb = win.getContentBounds();
        const wb = win.getBounds();
        const disp = remote.getBuiltin('screen').getDisplayMatching(cb);
        return {
            hole: r && { x: r.x, y: r.y, w: r.width, h: r.height },
            tabBar: tr && { y: tr.y, h: tr.height },
            contentBounds: { x: cb.x, y: cb.y, w: cb.width, h: cb.height },
            winBounds: { x: wb.x, y: wb.y, w: wb.width, h: wb.height },
            zoom: remote.getCurrentWebContents().getZoomFactor(),
            scale: disp.scaleFactor,
        };
    })()`)
    const pop = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'popup-rect.ps1')], { encoding: 'utf8' })
    const popups = pop.split('\n').filter(l => l.includes('AtlAxWin'))
    console.log(JSON.stringify(dom, null, 1))
    console.log('native popups:')
    popups.forEach(l => console.log('  ' + l.trim()))
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
