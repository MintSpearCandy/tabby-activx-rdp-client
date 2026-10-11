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
    /** False for tabs restored at startup: they wait for an explicit reconnect
     * instead of firing N simultaneous sessions on launch. */
    @Input() autoConnect = true

    @ViewChild('hole') hole: ElementRef<HTMLDivElement>

    diag: native.NativeDiagnostics | null = null
    state: RdpTabState = 'idle'
    stateDetail = ''
    showReconnect = false

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
        // Parking is driven by tab activation, not BaseTabComponent's
        // visibility$ (that one is window-level: minimized/hidden). An
        // inactive tab's popup would otherwise keep covering the window.
        this.subscribeUntilDestroyed(this.focused$, () => {
            if (this.viewHost) {
                this.viewHost.setVisible(true)
            }
        })
        this.subscribeUntilDestroyed(this.blurred$, () => {
            if (this.viewHost) {
                this.viewHost.setVisible(false)
            }
        })
    }

    ngAfterViewInit (): void {
        if (this.diag && this.diag.status !== 'ok') {
            return
        }
        if (!this.autoConnect) {
            // Restored tab: park it idle with a reconnect affordance instead
            // of auto-firing (a dozen restored sessions at once would hammer
            // both the local machine and the target).
            this.state = 'disconnected'
            this.stateDetail = 'restored tab — reconnect to continue'
            this.showReconnect = true
            return
        }
        // The native window pump must run outside Angular's zone.
        this.zone.runOutsideAngular(() => this.startSession())
    }

    ngOnDestroy (): void {
        this.stopSession()
        super.ngOnDestroy()
    }

    private async startSession (): Promise<void> {
        const o = this.profile.options
        if (!o?.host) {
            this.applyState('error', 'no host configured — open the profile settings and set one')
            return
        }
        const hwnd = nativeWindowHandle()
        if (!hwnd) {
            this.diag = { status: 'no-window-handle', detail: 'Could not get the Tabby window handle.' }
            return
        }
        const el = this.hole.nativeElement
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
        // Password: Vault when enabled, plain-text options otherwise.
        const password = await this.credentials.getPassword(this.profile)
        try {
            this.sessionId = native.get().create({
                hwnd,
                x: phys.x,
                y: phys.y,
                w: phys.w,
                h: phys.h,
                width: (o.width > 0 ? o.width : 0) || phys.w || 1024,
                height: (o.height > 0 ? o.height : 0) || phys.h || 768,
                server: o.host,
                port: o.port || 3389,
                username: o.username || '',
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
                break
            case 'loginComplete':
                this.state = 'connected'
                this.stateDetail = ''
                break
            case 'disconnected':
                this.state = 'disconnected'
                this.stateDetail = `reason ${ev.a}`
                this.showReconnect = true
                break
            case 'fatalError':
                this.state = 'error'
                this.stateDetail = `${ev.a}/${ev.b}`
                this.showReconnect = true
                break
            case 'logonError':
                this.state = 'error'
                this.stateDetail = `logon ${ev.a}`
                this.showReconnect = true
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
        this.showReconnect = false
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
