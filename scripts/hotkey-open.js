// hotkey-open.js — inject the Ctrl-F9 profile hotkey (two rounds, defeats the
// hotkey engine's timeStamp dedup) and report RDP tab state.
// Usage: node scripts/hotkey-open.js [port] [waitMs]
const port = process.argv[2] || '9241'
const waitMs = parseInt(process.argv[3] || '12000', 10)

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
    await sleep(waitMs)
    const state = await evalJs(`(() => ({
        rdpTabs: document.querySelectorAll('activx-rdp-tab').length,
        states: [...document.querySelectorAll('activx-rdp-tab .rdp-state')].map(e => e.textContent),
        details: [...document.querySelectorAll('activx-rdp-tab .rdp-detail')].map(e => e.textContent.trim()),
    }))()`)
    console.log(JSON.stringify(state))
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
