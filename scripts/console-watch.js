// console-watch.js — attach to the arc renderer and capture console.debug
// lines matching a prefix for N seconds.
// Usage: node scripts/console-watch.js [port] [seconds] [filter]
const port = process.argv[2] || 9242
const seconds = parseInt(process.argv[3] || '8', 10)
const filter = process.argv[4] || '[arc]'

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.url.includes('index'))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    const lines = []
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')
            if (text.includes(filter)) {
                lines.push(text)
            }
        }
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
    setTimeout(() => {
        console.log(`captured ${lines.length} lines:`)
        lines.slice(-12).forEach(l => console.log('  ' + l))
        ws.close()
        process.exit(0)
    }, seconds * 1000)
}

main().catch(e => { console.error(e.message); process.exit(1) })
