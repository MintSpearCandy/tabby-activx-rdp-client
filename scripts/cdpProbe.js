// cdpProbe.js — minimal CDP evaluator against an isolated Tabby instance.
// Usage: node scripts/cdpProbe.js <port> "<js expression>"
// (no external deps; Node >=22 native WebSocket)
const port = process.argv[2]
const expr = process.argv[3]
if (!port || !expr) {
    console.error('usage: node cdpProbe.js <port> "<expr>"')
    process.exit(1)
}

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.url.includes('index')) || list.find(t => t.type === 'page')
    if (!page) {
        console.error('no page target; targets:', list.map(t => `${t.type}:${t.url}`).join(', '))
        process.exit(1)
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const result = await new Promise((resolve) => {
        const id = 1
        ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data)
            if (m.id === id) resolve(m.result)
        }
        ws.send(JSON.stringify({
            id, method: 'Runtime.evaluate',
            params: { expression: expr, returnByValue: true, awaitPromise: true },
        }))
        setTimeout(() => resolve({ error: 'timeout' }), 15000)
    })
    console.log(JSON.stringify(result, null, 1))
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
