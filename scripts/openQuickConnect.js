// openQuickConnect.js — drive a Tabby instance's quick-connect bar to open an
// RDP tab (exercises the plugin's QuickConnectProfileProvider).
// Usage: node scripts/openQuickConnect.js <port> <host>
const port = process.argv[2] || '9241'
const host = process.argv[3] || '172.24.242.124'

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

    // Dismiss any first-run overlay, then hunt the quick-connect input: it
    // lives in the left dock (profiles panel); try each tab-bar toggle.
    const found = await evalJs(`(async () => {
        const primary = document.querySelector('button.btn-primary');
        if (primary) primary.click();
        await new Promise(r => setTimeout(r, 500));
        const buttons = [...document.querySelectorAll('.tab-bar button.btn-tab-bar, .window .btn-group button')];
        for (const b of buttons) {
            b.click();
            await new Promise(r => setTimeout(r, 350));
            const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent);
            const qc = inputs.find(i => /quick.?connect|快速连接|连接|address|地址/i.test(i.placeholder || ''));
            if (qc) return { ph: qc.placeholder };
        }
        return { ph: null, inputs: [...document.querySelectorAll('input')].filter(i => i.offsetParent).map(i => i.placeholder).slice(0, 6) };
    })()`)
    console.log('quick-connect input:', JSON.stringify(found))
    if (!found || !found.ph) {
        process.exit(1)
    }

    // Type the host into it and press Enter (Angular ngModel trio).
    const opened = await evalJs(`(async () => {
        const qc = [...document.querySelectorAll('input')].find(i => /quick.?connect|快速连接|连接|address|地址/i.test(i.placeholder || ''));
        qc.focus();
        qc.value = ${JSON.stringify(host)};
        qc.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
        qc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        await new Promise(r => setTimeout(r, 5000));
        return {
            rdpTabs: document.querySelectorAll('activx-rdp-tab').length,
            state: (document.querySelector('activx-rdp-tab .rdp-state') || { textContent: '?' }).textContent,
        };
    })()`)
    console.log('after quick connect:', JSON.stringify(opened))
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
