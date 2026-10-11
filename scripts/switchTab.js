// switchTab.js — click the tab header matching a substring (switch-back helper)
// Usage: node scripts/switchTab.js <port> <substring>
const port = process.argv[2] || 9242
const needle = process.argv[3] || 'RDP'

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
    const r = await call('Runtime.evaluate', {
        expression: `(() => {
            const tabs = document.querySelectorAll('tab-header');
            for (const t of tabs) {
                if ((t.textContent || '').indexOf(${JSON.stringify(needle)}) >= 0) {
                    t.click();
                    return 'clicked';
                }
            }
            return 'not found among ' + tabs.length;
        })()`,
        returnByValue: true,
    })
    console.log(JSON.stringify(r.result && r.result.value))
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
