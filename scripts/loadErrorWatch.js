// loadErrorWatch.js — start the arc instance with CDP, attach early and
// capture renderer console output (plugin discovery/loading + exceptions)
// to diagnose silent plugin-load failures.
// Usage: node scripts/loadErrorWatch.js [port] [waitMs]
const { spawn } = require('child_process')
const port = process.argv[2] || 9242
const waitMs = parseInt(process.argv[3] || '18000', 10)

async function tryAttach () {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.url.includes('index'))
    if (!page) throw new Error('no page target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const lines = []
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data)
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')
            lines.push(`[${m.params.type}] ${text}`)
        } else if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails
            lines.push(`[EXC] ${d.text} ${d.exception?.description?.slice(0, 500) ?? ''}`)
        }
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
    return { ws, lines }
}

async function main () {
    spawn('D:\\Env\\TabbyEnv\\instances\\arc\\Tabby.exe', [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref()
    // attach as early as possible; retry while booting
    let attached = null
    for (let i = 0; i < 20 && !attached; i++) {
        await new Promise(r => setTimeout(r, 1000))
        try { attached = await tryAttach() } catch { /* not up yet */ }
    }
    if (!attached) { console.error('could not attach'); process.exit(1) }
    console.log('attached, collecting...')
    await new Promise(r => setTimeout(r, waitMs))
    const interesting = attached.lines.filter(l =>
        /activx|Loading |Found |bootstrapping|error|Error|EXC/i.test(l))
    console.log(interesting.slice(0, 40).join('\n'))
    process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
