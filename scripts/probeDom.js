// probeDom.js — one-shot DOM probe of the arc instance main window.
// Usage: node scripts/probeDom.js [port] [optional js expression file]
const fs = require('fs')
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
    const expr = process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : `(() => ({
        modalWin: !!document.querySelector('ngb-modal-window'),
        selModal: !!document.querySelector('selector-modal'),
        inp: !!document.querySelector('input[placeholder="Commands"]'),
        active: document.activeElement ? document.activeElement.tagName : null,
        bodyKids: [...document.body.children].map(e => e.tagName).join(','),
    }))()`
    const r = await evalJs(expr)
    console.log(JSON.stringify(r.result?.value ?? r, null, 1))
    ws.close()
    process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
