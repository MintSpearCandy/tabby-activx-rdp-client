// blankTabConnectTest.js — open the builtin (empty) "ActiveX RDP" tab via the
// palette, verify the gate form starts blank, fill it via DOM, connect and
// wait for connected.
// Usage: node scripts/blankTabConnectTest.js [port]
const port = process.argv[2] || 9242

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
    const evalJs = expr => new Promise(res => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })) })
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    await evalJs('document.activeElement && document.activeElement.blur(), "ok"')
    const chord = [
        { type: 'keyDown', modifiers: 10, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 },
        { type: 'keyUp', modifiers: 10, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 },
    ]
    for (let round = 0; round < 2; round++) {
        for (const k of chord) { await call('Input.dispatchKeyEvent', k); await sleep(30) }
        await sleep(280)
    }
    await sleep(800)

    // Filter to the builtin entry, then ArrowDown once to pick the second
    // item ("New tab: ActiveX RDP" — the builtin, not the saved profile).
    await evalJs(`(async () => {
        const inp = document.querySelector('input[placeholder="Commands"]')
        if (!inp) return 'no palette'
        inp.focus()
        inp.value = 'ActiveX RDP'
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(r => setTimeout(r, 700))
        const items = [...document.querySelectorAll('ngb-modal-window .list-group-item')]
            .map(e => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50))
        return items.slice(0, 4)
    })()`).then(r => console.log('palette:', JSON.stringify(r.result?.value)))

    await evalJs(`(() => {
        const inp = document.querySelector('input[placeholder="Commands"]')
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }))
        return 'down'
    })()`)
    await sleep(200)
    await evalJs(`(() => {
        const inp = document.querySelector('input[placeholder="Commands"]')
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
        return 'enter'
    })()`)
    await sleep(1800)

    // Close any palette leftover, then inspect the newest tab's gate form.
    await evalJs(`(() => {
        const inp = document.querySelector('ngb-modal-window input')
        if (inp) { inp.focus(); inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })) }
        return 'esc'
    })()`)
    await sleep(800)

    const blank = await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('activx-rdp-tab')]
        const t = tabs[tabs.length - 1]
        if (!t) return { err: 'no tab' }
        return {
            title: (t.querySelector('.rdp-gate-title')||{}).textContent,
            fields: [...t.querySelectorAll('.rdp-gate-card input')].map(i => i.value),
            state: (t.querySelector('.rdp-state')||{}).textContent,
        }
    })()`)
    console.log('blank tab gate:', JSON.stringify(blank.result?.value))

    // Fill the form on that tab (DOM value + input event for ngModel).
    await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('activx-rdp-tab')]
        const t = tabs[tabs.length - 1]
        const inputs = [...t.querySelectorAll('.rdp-gate-card input')]
        const set = (idx, val) => { const i = inputs[idx]; i.value = val; i.dispatchEvent(new Event('input', { bubbles: true })) }
        set(0, '172.24.242.124')
        set(1, '3389')
        set(2, 'mscandy')
        set(3, 'rdppoc123')
        return 'filled'
    })()`)
    const filled = await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('activx-rdp-tab')]
        const t = tabs[tabs.length - 1]
        return [...t.querySelectorAll('.rdp-gate-card input')].map(i => i.value)
    })()`)
    console.log('filled:', JSON.stringify(filled.result?.value))

    await evalJs(`(() => {
        const tabs = [...document.querySelectorAll('activx-rdp-tab')]
        const t = tabs[tabs.length - 1]
        t.querySelector('.rdp-gate-btn')?.click()
        return 'connect'
    })()`)
    for (let i = 0; i < 8; i++) {
        await sleep(2000)
        const s = await evalJs(`(() => {
            const tabs = [...document.querySelectorAll('activx-rdp-tab')]
            const t = tabs[tabs.length - 1]
            return { state: (t.querySelector('.rdp-state')||{}).textContent, gate: !!t.querySelector('.rdp-gate') }
        })()`)
        console.log('state:', JSON.stringify(s.result?.value))
        if (s.result?.value?.state === 'connected') break
    }
    process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
