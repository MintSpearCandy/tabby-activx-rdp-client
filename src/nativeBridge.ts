/**
 * @hidden
 * Bridge to the native rdp_host.node addon (N-API: ATL OLE container hosting
 * the system MsTscAx ActiveX on a dedicated STA thread). Loaded from
 * <plugin dir>/native/rdp_host.node with a plain require.
 *
 * Everything here must be failure-tolerant: a plugin whose module evaluation
 * throws takes down every user plugin loaded after it (Tabby's loader has no
 * per-plugin isolation). So: lazy require, captured errors, and a diagnostics
 * object the tab component can render instead of the desktop.
 */
import * as path from 'path'
import { RdpEvent } from './api'

export interface NativeDiagnostics {
    /** 'ok' | a short machine-readable reason otherwise */
    status: 'ok' | 'not-windows' | 'load-failed' | 'missing-binary' | 'no-window-handle'
    /** Human-readable detail for the failure states. */
    detail?: string
}

export interface CreateSessionOptions {
    x: number
    y: number
    w: number
    h: number
    server: string
    port: number
    username: string
    password: string
    domain: string
    width: number
    height: number
    enableCredSsp: boolean
}

interface RdpHostModule {
    create (opts: CreateSessionOptions & { hwnd: Buffer }): number
    connect (id: number): boolean
    disconnect (id: number): boolean
    setBounds (id: number, x: number, y: number, w: number, h: number): boolean
    setVisible (id: number, visible: boolean): boolean
    updateDisplay (id: number, w: number, h: number): boolean
    destroy (id: number): boolean
    setEventHandler (cb: (ev: RdpEvent) => void): void
    shutdown (): void
}

type Listener = (ev: RdpEvent) => void
const listeners = new Map<number, Set<Listener>>()

/**
 * The addon supports a single global event handler; register it once and
 * fan events out to per-session listeners. High-frequency progress events
 * (desktopSizeChange/serviceMessageReceived) are sampled 1-in-32 the same
 * way the addon samples its trace — nobody needs 60 of those per second.
 */
function ensureEventPump (): void {
    const m = load()
    if (!m || (m as any).__activxPump) {
        return
    }
    let hf = 0
    m.setEventHandler((ev: RdpEvent) => {
        if (ev.dispid === 12 || ev.dispid === 27) {
            if ((hf++ & 31) !== 0) {
                return
            }
        }
        const set = listeners.get(ev.id)
        if (set) {
            for (const l of set) {
                try {
                    l(ev)
                } catch {
                    // a broken listener must not break the pump
                }
            }
        }
    })
    ;(m as any).__activxPump = true
}

/** Subscribe to a session's events. Returns an unsubscribe function. */
export function onSessionEvents (sessionId: number, l: Listener): () => void {
    ensureEventPump()
    let set = listeners.get(sessionId)
    if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
    }
    set.add(l)
    return () => {
        set!.delete(l)
        if (set!.size === 0) {
            listeners.delete(sessionId)
        }
    }
}

declare const __non_webpack_require__: ((id: string) => unknown) | undefined

/**
 * The real CommonJS require. A plain `require(variable)` gets rewritten by
 * webpack into __webpack_require__ (module-table lookup) even with a
 * /* webpackIgnore: true *​/ comment — which reported MODULE_NOT_FOUND for a
 * file that exists. __non_webpack_require__ is webpack's official escape
 * hatch; eval('require') covers bundlers without it.
 */
const nodeRequire: (id: string) => any =
    typeof __non_webpack_require__ === 'function'
        ? __non_webpack_require__ as (id: string) => any
        : (typeof eval === 'function' ? eval('require') : require) as (id: string) => any

let module_: RdpHostModule | null = null
let loadError: Error | null = null
let binaryPath = ''

function addonPath (): string {
    if (binaryPath) {
        return binaryPath
    }
    // __dirname in the webpack bundle is <plugin>/dist → native sits next to it.
    // Allow an override first (dev builds / asar-unpacked layouts).
    binaryPath = process.env.ACTIVX_RDP_NODE_PATH ||
        path.join(__dirname, '..', 'native', 'rdp_host.node')
    return binaryPath
}

function load (): RdpHostModule | null {
    if (module_ || loadError) {
        return module_
    }
    try {
        const p = addonPath()
        module_ = nodeRequire(p) as RdpHostModule
    } catch (e) {
        loadError = e as Error
    }
    return module_
}

export function diagnostics (): NativeDiagnostics {
    if (process.platform !== 'win32') {
        return {
            status: 'not-windows',
            detail: `The MsTscAx ActiveX control only exists on Windows (this host is ${process.platform}).`,
        }
    }
    const fs = require('fs') as typeof import('fs')
    const p = addonPath()
    if (!fs.existsSync(p)) {
        return {
            status: 'missing-binary',
            detail: `Native addon not found at ${p}. Run \`npm run build:native\` in the plugin checkout, or reinstall the plugin.`,
        }
    }
    if (!load()) {
        return {
            status: 'load-failed',
            detail: `Loading ${p} failed: ${loadError?.message ?? 'unknown error'}`,
        }
    }
    return { status: 'ok' }
}

/** True when the native bridge is usable (cheap; call per-tab at init). */
export function available (): boolean {
    return diagnostics().status === 'ok'
}

/** The addon path as resolved (for the settings page). */
export function addonPathForDisplay (): string {
    return addonPath()
}

export function get (): RdpHostModule {
    const m = load()
    if (!m) {
        throw new Error(`rdp_host.node unavailable: ${loadError?.message ?? 'not loaded'}`)
    }
    return m
}
