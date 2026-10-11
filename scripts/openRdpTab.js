// openRdpTab.js — drive the arc instance's command palette via CDP to open
// our RDP profile tab (M3 verification helper).
// Usage: node scripts/openRdpTab.js [port]
const fs = require('fs')

const port = process.argv[2] || 9242

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.url.includes('index'))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

    let nextId = 1
    const pending = new Map()
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m.result)
            pending.delete(m.id)
        }
    }
    const call = (method, params = {}) => new Promise((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params }))
    })
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const evalJs = async (expr) => {
        const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        return r.result && r.result.value
    }

    // Recipe from the tabby-debug skill: blur first (palette input focus
    // filters hotkeys), then send the chord TWICE (timeStamp dedup eats the
    // first), avoiding Alt.
    await evalJs('document.activeElement && document.activeElement.blur(), "ok"')

    const chord = [
        { type: 'keyDown', modifiers: 10, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 },
        { type: 'keyUp', modifiers: 10, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 },
    ]
    for (let round = 0; round < 2; round++) {
        for (const k of chord) {
            await call('Input.dispatchKeyEvent', k)
            await sleep(30)
        }
        await sleep(280)
    }
    await sleep(800)

    const palette = await evalJs(`(() => {
        const inp = document.querySelector('input[placeholder="Commands"]');
        return { found: !!inp, ph: inp && inp.placeholder, cls: inp && inp.className.slice(0,60) };
    })()`)
    console.log('palette:', JSON.stringify(palette))

    if (!palette || !palette.found) {
        console.log('palette did not open; dumping visible inputs')
        const inputs = await evalJs(`[...document.querySelectorAll('input')].map(i => ({ph: i.placeholder, cls: i.className.slice(0,50)}))`)
        console.log(JSON.stringify(inputs, null, 1))
        process.exit(1)
    }

    // Type "activx" into the palette input via DOM events (Angular ngModel).
    const typed = await evalJs(`(async () => {
        const inp = document.querySelector('input[placeholder="Commands"]');
        inp.focus();
        inp.value = 'activx';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        const items = [...document.querySelectorAll('.command-palette li, .command-palette .list-group-item, [class*=command-palette] button, ul.list-group li')]
            .map(e => (e.textContent || '').trim().replace(/\\s+/g, ' ')).filter(t => t);
        return { items: items.slice(0, 12) };
    })()`)
    console.log('matching commands:', JSON.stringify(typed, null, 1))

    // Press Enter on the first match.
    await evalJs(`(() => {
        const inp = document.querySelector('input[placeholder="Commands"]');
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return 'enter';
    })()`)
    await sleep(1500)

    const state = await evalJs(`(() => ({
        tabs: document.querySelectorAll('tab-header').length,
        ourTab: !!document.querySelector('activx-rdp-tab'),
        ourState: (document.querySelector('activx-rdp-tab .rdp-state') || {}).textContent,
        ourDetail: (document.querySelector('activx-rdp-tab .rdp-detail') || {}).textContent,
        diag: (document.querySelector('activx-rdp-tab .rdp-diag p') || {}).textContent,
    }))()`)
    console.log('after open:', JSON.stringify(state, null, 1))
    fs.writeFileSync('open-rdp-result.json', JSON.stringify(state, null, 1))
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
