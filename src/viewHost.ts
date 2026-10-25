/**
 * @hidden
 * Keeps the native RDP popup glued to the tab's hole div.
 *
 * Visibility is derived entirely from the hole's rect, every frame:
 * Tabby hides inactive tabs by moving their DOM far off-viewport and hides
 * maximized-away split panes by collapsing them — both collapse the rect,
 * which parks the popup. Panes that merely lose *focus* (an active sibling
 * in a split) keep a normal rect and keep showing: driving the park off
 * focused$/blurred$ used to hide every non-focused split pane even while
 * it was plainly visible next to the active one. While parked, the loop
 * drops to a low-frequency poll to rest the renderer.
 *
 * The other yield is Tabby's floating layers (modals, dropdowns, tooltips,
 * toasts), which render in the DOM below the Win32 popup: while a
 * mouse-opaque element covers any sampled point of the hole, the popup
 * yields (elementFromPoint skips pointer-events:none hint layers by
 * itself). Window moves need nothing here — the addon tracks the owner via
 * WinEvents and re-anchors natively, per move step.
 */
import * as native from './nativeBridge'
import { focusWebContents } from './electronApi'
import { holeToViewportPhysical, parkedRect, physicalKey, PhysicalRect } from './geometry'

/** Hit-test targets that never block the mouse, whatever their CSS. */
const HARMLESS_OVERLAY_SELECTOR = '.tooltip, #toast-container, toast-container'

/** Poll interval (ms) while the hole is parked/collapsed. */
const PARKED_POLL_MS = 120

export class RdpViewHost {
    private hostEl: HTMLElement | null = null
    private sessionId = 0
    private rafId: number | null = null
    private pollTimer: number | null = null
    private dead = false
    /** Session-level display intent: only a connected session shows the
     * desktop. After a disconnect the control window turns blank but stays
     * on top of the DOM — hiding it is what makes the gate card reachable. */
    private sessionActive = false
    private overlayHit = false
    private parked = false
    private boundsKey = ''

    attach (hostEl: HTMLElement, sessionId: number): void {
        this.hostEl = hostEl
        this.sessionId = sessionId
        this.rafId = requestAnimationFrame(() => this.syncFrame())
    }

    /** Connected/dead switch — the popup is only shown while connected. */
    setSessionActive (v: boolean): void {
        if (this.dead || v === this.sessionActive) {
            return
        }
        this.sessionActive = v
        this.pushVisibility(this.effectiveVisible(), { restoreFocus: true })
    }

    /** Force the next frame to re-push the rect (e.g. after 'connected'). */
    invalidateBounds (): void {
        this.boundsKey = ''
    }

    kill (): void {
        this.dead = true
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId)
            this.rafId = null
        }
        if (this.pollTimer !== null) {
            clearTimeout(this.pollTimer)
            this.pollTimer = null
        }
        this.hostEl = null
    }

    private effectiveVisible (): boolean {
        return this.sessionActive && !this.overlayHit && !this.parked
    }

    /**
     * Push a visibility change to the popup. `restoreFocus` is set for
     * transitions WE initiate because the desktop stopped being usable
     * (disconnect/error, tab parked): if the mstscax window held focus at
     * that moment, hiding it can leave the thread with a NULL focus window
     * while Tabby stays foreground — every keystroke then vanishes until a
     * click inside the client area. Overlay yielding never restores (focus
     * is already in the DOM when an overlay is up).
     */
    private pushVisibility (visible: boolean, opts?: { restoreFocus?: boolean }): void {
        if (!this.sessionId) {
            return
        }
        try {
            native.get().setVisible(this.sessionId, visible)
        } catch {
            // session gone; kill() will clean up
        }
        if (!visible && opts?.restoreFocus) {
            focusWebContents()
        }
    }

    /**
     * True when a mouse-opaque element covers the hole. elementFromPoint
     * returns the topmost element that would take the event — pointer-events
     * none layers (tooltip/toast containers) are skipped for us; the popup
     * itself is a native window the DOM hit-test cannot see. Samples the
     * center and the four corners (clamped into the viewport), so a modal
     * covering only part of the hole still yields.
     */
    private overlayCoversHole (hole: DOMRect): boolean {
        const w = window.innerWidth, h = window.innerHeight
        const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max - 1))
        const x1 = clamp(hole.left, w), x2 = clamp(hole.right - 1, w)
        const y1 = clamp(hole.top, h), y2 = clamp(hole.bottom - 1, h)
        const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2
        const points: Array<[number, number]> = [
            [midX, midY], [x1, y1], [x2, y1], [x1, y2], [x2, y2],
        ]
        for (const [x, y] of points) {
            const el = document.elementFromPoint(x, y)
            if (el && !this.hostEl.contains(el) &&
                !(el.closest && el.closest(HARMLESS_OVERLAY_SELECTOR))) {
                return true
            }
        }
        return false
    }

    private scheduleNext (): void {
        if (this.parked) {
            // Nothing to follow while collapsed — rest until the next poll.
            this.pollTimer = window.setTimeout(() => this.syncFrame(), PARKED_POLL_MS)
        } else {
            this.rafId = requestAnimationFrame(() => this.syncFrame())
        }
    }

    private syncFrame (): void {
        this.rafId = null
        this.pollTimer = null
        if (this.dead || !this.hostEl) {
            return
        }
        const rect = this.hostEl.getBoundingClientRect()
        const wasParked = this.parked
        this.parked = rect.width < 2 || rect.height < 2 ||
            rect.x < -5000 || rect.x > 20000 || rect.y < -5000 || rect.y > 20000
        if (this.parked !== wasParked) {
            // Collapsed (pane maximized away) or parked by Tabby's layout
            // (inactive tabs move to left:-1000%) — hide the popup outright
            // rather than leaving a visible window in the void (DWM still
            // composes off-screen windows). Restore on the way back.
            this.pushVisibility(this.effectiveVisible(), { restoreFocus: true })
        }
        let phys: PhysicalRect
        if (this.parked) {
            // Belt and braces: also move it to the sentinel rect.
            phys = parkedRect(holeToViewportPhysical(rect))
        } else {
            phys = holeToViewportPhysical(rect)
            // Overlay yield (only meaningful while actually on screen).
            const hit = this.overlayCoversHole(rect)
            if (hit !== this.overlayHit) {
                this.overlayHit = hit
                this.pushVisibility(this.effectiveVisible())
            }
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
        this.scheduleNext()
    }
}
