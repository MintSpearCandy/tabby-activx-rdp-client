/**
 * @hidden
 * Keeps the native RDP popup glued to the tab's hole div: an rAF loop reads
 * the hole's rect every frame and pushes viewport-relative physical
 * coordinates to the addon, which adds the owner window's real
 * ClientToScreen origin (Electron's DIP bounds disagree with the window's
 * physical rect by DWM invisible borders on mixed-DPI setups).
 *
 * Frame-sync pattern (rAF poll, off-screen parking for hidden panes,
 * bounds-key dedup) follows Tabby's WebViewer plugin. Native-side live
 * resize is debounced (250 ms) inside the addon, so per-frame setBounds is
 * cheap — only the final size triggers an RDP resolution change.
 */
import * as native from './nativeBridge'
import { holeToViewportPhysical, parkedRect, physicalKey, PhysicalRect } from './geometry'

export class RdpViewHost {
    private hostEl: HTMLElement | null = null
    private sessionId = 0
    private rafId: number | null = null
    private dead = false
    private visibleFlag = true
    private boundsKey = ''
    private frameCount = 0

    attach (hostEl: HTMLElement, sessionId: number): void {
        this.hostEl = hostEl
        this.sessionId = sessionId
        this.rafId = requestAnimationFrame(() => this.syncFrame())
    }

    setVisible (v: boolean): void {
        if (this.dead || v === this.visibleFlag) {
            return
        }
        this.visibleFlag = v
        if (!v) {
            // The tab was switched away: park the popup off-screen (the
            // native side has no notion of pane visibility, and an owned
            // popup would otherwise keep covering the window).
            if (this.sessionId) {
                try {
                    native.get().setBounds(this.sessionId, -32000, -32000, 640, 480)
                } catch {
                    // session gone; kill() will clean up
                }
            }
        }
        // The park push bypasses the bounds-key cache, so invalidate it:
        // otherwise the first visible frame computes the same key as before
        // the park and never re-pushes — the popup stays parked forever.
        this.boundsKey = ''
        if (v && this.rafId === null) {
            this.rafId = requestAnimationFrame(() => this.syncFrame())
        }
    }

    kill (): void {
        this.dead = true
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId)
            this.rafId = null
        }
        this.hostEl = null
    }

    private syncFrame (): void {
        if (this.dead || !this.visibleFlag || !this.hostEl) {
            this.rafId = null
            return
        }
        const rect = this.hostEl.getBoundingClientRect()
        let phys: PhysicalRect
        if (rect.width < 2 || rect.height < 2 ||
            rect.x < -5000 || rect.x > 20000 || rect.y < -5000 || rect.y > 20000) {
            // Collapsed (pane maximized away) or parked by Tabby's layout
            // (hidden panes are moved far off-viewport, e.g. x=-9640) — park
            // the popup off-screen so it never covers the window.
            phys = parkedRect(holeToViewportPhysical(rect))
        } else {
            phys = holeToViewportPhysical(rect)
        }
        const key = physicalKey(phys)
        if (key !== this.boundsKey) {
            this.boundsKey = key
            try {
                native.get().setBounds(this.sessionId, phys.x, phys.y, phys.w, phys.h)
            } catch {
                // Session died underneath us; the loop will be killed by
                // the tab component.
            }
        }
        if (++this.frameCount >= 60) {
            this.frameCount = 0
            console.debug('[arc] syncFrame alive: rect=', Math.round(rect.x), Math.round(rect.y),
                Math.round(rect.width), Math.round(rect.height),
                '→ viewport-phys', phys.x, phys.y, phys.w + 'x' + phys.h)
        }
        this.rafId = requestAnimationFrame(() => this.syncFrame())
    }
}
