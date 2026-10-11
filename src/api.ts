import { ConnectableProfile } from 'tabby-core'

export const RDP_PROFILE_TYPE = 'activx-rdp'
export const PLUGIN_ID = 'activx-rdp-client'

export interface RdpProfileOptions {
    host: string
    port: number
    username: string
    /** Stored in plain text in config.yaml (PoC-grade; see README). */
    password: string
    domain: string
    /** Initial desktop size in physical pixels (0 = follow pane size). */
    width: number
    height: number
}

export interface RdpProfile extends ConnectableProfile {
    options: RdpProfileOptions
}

export type RdpEventName =
    'connecting' | 'connected' | 'loginComplete' | 'disconnected' |
    'fatalError' | 'warning' | 'desktopSizeChange' | 'logonError' |
    'authWarningDisplayed' | 'autoReconnecting' | string

export interface RdpEvent {
    id: number
    dispid: number
    name: RdpEventName
    a: number
    b: number
}

/** Parse a quick-connect query `host[:port]` (bare hostname or IPv4). */
export function parseRdpTarget (query: string): { host: string, port: number } | null {
    const q = query.trim()
    if (!q) {
        return null
    }
    const m = q.match(/^([a-zA-Z0-9._-]+)(?::(\d{1,5}))?$/)
    if (!m || !m[1].includes('.')) {
        return null
    }
    const port = m[2] ? parseInt(m[2], 10) : 3389
    if (!(port > 0 && port < 65536)) {
        return null
    }
    return { host: m[1], port }
}
