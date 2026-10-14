// closeAllModals.js — close every stacked ngb modal in the arc instance by
// focusing each layer's input (autofocus lost after blur) and dispatching
// Escape on it (bubbles through the selector-modal host).
// Usage: node scripts/closeAllModals.js [port]
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
    const evalJs = expr => new Promise(res => {
        const i = id++
        pending.set(i, res)
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    })
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    for (let layer = 0; layer < 6; layer++) {
        const closed = await evalJs(`(() => {
            const inp = document.querySelector('ngb-modal-window input');
            if (!inp) return 0;
            inp.focus();
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            return 1;
        })()`)
        if (!closed.result?.value) break
        await sleep(600)
        const left = await evalJs(`document.querySelectorAll('ngb-modal-window').length`)
        console.log(`layer ${layer}: esc sent, ${left.result?.value} modal(s) left`)
    }
    ws.close()
    process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
