import { Component, Input, ViewChild, ElementRef, Injector, NgZone, OnInit, AfterViewInit, OnDestroy } from '@angular/core'
import { BaseTabComponent, RecoveryToken } from 'tabby-core'

import { RdpEvent, RdpProfile } from './api'
import { RdpCredentialsService } from './credentials'
import * as native from './nativeBridge'
import { RdpViewHost } from './viewHost'
import { nativeWindowHandle } from './electronApi'

type RdpTabState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

@Component({
    selector: 'activx-rdp-tab',
    template: require('./rdpTab.component.pug'),
    styles: [require('./rdpTab.component.scss')],
})
export class RdpTabComponent extends BaseTabComponent implements OnInit, AfterViewInit, OnDestroy {
    static readonly RECOVERY_TYPE = 'activx-rdp-tab'

    @Input() profile: RdpProfile
    /** Kept for recovery-token compatibility; every new tab now shows the
     * confirmation gate before connecting (restored tabs used to be the only
     * ones that waited). */
    @Input() autoConnect = true

    @ViewChild('hole') hole: ElementRef<HTMLDivElement>

    diag: native.NativeDiagnostics | null = null
    state: RdpTabState = 'idle'
    stateDetail = ''
    /** Connection form — prefilled from the profile, editable on the gate.
     * Lets an empty RDP tab (builtin profile) carry its own target. */
    connForm = {
        host: '',
        port: 3389,
        username: '',
        password: '',
    }

    get busy (): boolean {
        return this.state === 'connecting'
    }

    get targetText (): string {
        const f = this.connForm
        if (!f.host) {
            return ''
        }
        const host = f.port && f.port !== 3389 ? `${f.host}:${f.port}` : f.host
        return f.username ? `${host} — ${f.username}` : host
    }

    get gateActionLabel (): string {
        switch (this.state) {
            case 'connecting': return 'Connecting…'
            case 'error': return 'Retry'
            case 'disconnected': return 'Reconnect'
            default: return 'Connect'
        }
    }

    private sessionId: number | null = null
    private viewHost: RdpViewHost | null = null
    private unsubscribe: (() => void) | null = null

    constructor (
        injector: Injector,
        private zone: NgZone,
        private credentials: RdpCredentialsService,
    ) {
        super(injector)
    }

    async getRecoveryToken (): Promise<RecoveryToken | null> {
        return {
            type: RdpTabComponent.RECOVERY_TYPE,
            profileId: this.profile?.id,
        } as any as RecoveryToken
    }

    ngOnInit (): void {
        this.setTitle(this.profile.name)
        this.icon = 'fas fa-desktop'
        this.state = 'idle'
        this.diag = native.diagnostics()
        // Prefill the gate form from the profile (an empty/builtin profile
        // just yields an empty form). The stored password arrives async —
        // startSession falls back to the credential store if the user
        // connects before the prefill lands.
        const o = this.profile.options
        if (o) {
            this.connForm.host = o.host || ''
            this.connForm.port = o.port || 3389
            this.connForm.username = o.username || ''
        }
        void this.credentials.getPassword(this.profile).then(pwd => {
            this.zone.run(() => {
                if (!this.connForm.password) {
                    this.connForm.password = pwd
                }
            })
        })
        // NOTE: no focused$/blurred$ here. In a split tab Tabby blurs every
        // non-focused pane (SplitTabComponent.focus), and parking on blur hid
        // plainly visible desktops; visibility is now derived entirely from
        // the hole's rect in the view host's frame loop.
    }

    ngAfterViewInit (): void {
        // Every tab starts at the confirmation gate (state 'idle') — no
        // session is created until the user presses Connect. Opening a
        // profile must not fire an RDP connection on its own.
    }

    ngOnDestroy (): void {
        this.stopSession()
        super.ngOnDestroy()
    }

    private async startSession (): Promise<void> {
        const o = this.profile.options
        const f = this.connForm
        if (!f.host) {
            this.applyState('idle', 'enter a host to connect')
            return
        }
        const hwnd = nativeWindowHandle()
        if (!hwnd) {
            this.diag = { status: 'no-window-handle', detail: 'Could not get the Tabby window handle.' }
            return
        }
        const el = this.hole.nativeElement
        // Let the tab's layout settle before sampling the hole: reading the
        // rect inside ngAfterViewInit catches the content area mid-layout,
        // and a wrong initial size becomes the RDP desktop resolution. Retry
        // a few frames for a non-collapsed rect (never blocks > ~10 frames).
        for (let i = 0; i < 10; i++) {
            const r = el.getBoundingClientRect()
            if (r.width >= 64 && r.height >= 64) {
                break
            }
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }
        const rect = el.getBoundingClientRect()
        // Initial rect in viewport-relative physical px (the native side
        // adds the owner's ClientToScreen origin).
        const dpr = window.devicePixelRatio || 1
        const phys = {
            x: Math.round(rect.x * dpr),
            y: Math.round(rect.y * dpr),
            w: Math.max(64, Math.round(rect.width * dpr)),
            h: Math.max(64, Math.round(rect.height * dpr)),
        }
        // Gate form wins for the connection target; the profile still owns
        // the advanced knobs (domain, desktop size, CredSSP). Password: the
        // form value if set (prefilled from the store), else the store now.
        const password = f.password || await this.credentials.getPassword(this.profile)
        try {
            this.sessionId = native.get().create({
                hwnd,
                x: phys.x,
                y: phys.y,
                w: phys.w,
                h: phys.h,
                width: (o.width > 0 ? o.width : 0) || phys.w || 1024,
                height: (o.height > 0 ? o.height : 0) || phys.h || 768,
                enableCredSsp: o.enableCredSsp !== false,
                server: f.host,
                port: f.port || 3389,
                username: f.username || '',
                password,
                domain: o.domain || '',
            })
        } catch (e) {
            this.applyState('error', `create failed: ${(e as Error).message}`)
            return
        }
        this.unsubscribe = native.onSessionEvents(this.sessionId, ev => {
            this.zone.run(() => this.onNativeEvent(ev))
        })
        this.viewHost = new RdpViewHost()
        this.viewHost.attach(el, this.sessionId)
        native.get().connect(this.sessionId)
        this.applyState('connecting')
    }

    private stopSession (): void {
        if (this.viewHost) {
            this.viewHost.kill()
            this.viewHost = null
        }
        if (this.unsubscribe) {
            this.unsubscribe()
            this.unsubscribe = null
        }
        if (this.sessionId != null) {
            try {
                native.get().destroy(this.sessionId)
            } catch {
                // already gone
            }
            this.sessionId = null
        }
    }

    private onNativeEvent (ev: RdpEvent): void {
        switch (ev.name) {
            case 'connecting':
                this.state = 'connecting'
                break
            case 'connected':
                this.state = 'connected'
                this.stateDetail = ''
                // The native side replays any resolution queued while the
                // session was connecting; force a rect re-push too so the
                // popup bounds and the desktop size converge on the settled
                // pane rect even if it never changed since create.
                this.viewHost?.setSessionActive(true)
                this.viewHost?.invalidateBounds()
                break
            case 'loginComplete':
                this.state = 'connected'
                this.stateDetail = ''
                break
            case 'disconnected':
                this.state = 'disconnected'
                this.stateDetail = `reason ${ev.a}`
                // The control window blanks but stays above the DOM — hide
                // it so the gate card (reconnect) is visible and clickable.
                this.viewHost?.setSessionActive(false)
                break
            case 'fatalError':
                this.state = 'error'
                this.stateDetail = `${ev.a}/${ev.b}`
                this.viewHost?.setSessionActive(false)
                break
            case 'logonError':
                this.state = 'error'
                this.stateDetail = `logon ${ev.a}`
                this.viewHost?.setSessionActive(false)
                break
        }
    }

    private applyState (state: RdpTabState, detail = ''): void {
        this.zone.run(() => {
            this.state = state
            this.stateDetail = detail
        })
    }

    reconnect (): void {
        if (this.sessionId == null && !this.connForm.host) {
            this.stateDetail = 'enter a host to connect'
            return
        }
        this.state = 'connecting'
        this.stateDetail = ''
        if (this.sessionId == null) {
            // A restored tab reconnects by creating the session now.
            this.zone.runOutsideAngular(() => this.startSession())
            return
        }
        native.get().connect(this.sessionId)
    }

    /** Hotkey entry: disconnect the live session without closing the tab. */
    disconnect (): void {
        if (this.sessionId == null) {
            return
        }
        try {
            native.get().disconnect(this.sessionId)
        } catch {
            // already gone
        }
    }
}
