// geoProbe.js — open an RDP tab via hotkey and dump hole/DIP/scale geometry.
// Usage: node scripts/geoProbe.js [port]
const port = process.argv[2] || 9242

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
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
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const evalJs = async (expr) => {
        const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        return r.result && r.result.value
    }

    await evalJs('document.activeElement && document.activeElement.blur(), 1')
    for (let i = 0; i < 2; i++) {
        await call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 })
        await sleep(40)
        await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 })
        await sleep(300)
    }
    await sleep(12000)

    const geo = await evalJs(`(() => {
        const hole = document.querySelector('activx-rdp-tab .hole');
        const r = hole ? hole.getBoundingClientRect() : null;
        const remote = require('@electron/remote');
        const win = remote.getCurrentWindow();
        const cb = win.getContentBounds();
        const disp = remote.getBuiltin('screen').getDisplayMatching(cb);
        return {
            hole: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
            contentBounds: { x: cb.x, y: cb.y, w: cb.width, h: cb.height },
            zoom: remote.getCurrentWebContents().getZoomFactor(),
            dispScale: disp.scaleFactor,
            dispBounds: disp.bounds,
            monitors: remote.getBuiltin('screen').getAllDisplays().map(d => ({ b: d.bounds, s: d.scaleFactor })),
        };
    })()`)
    console.log(JSON.stringify(geo, null, 1))
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
