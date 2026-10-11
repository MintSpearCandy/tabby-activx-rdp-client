/**
 * @hidden
 * Hole-rect → viewport-relative physical rect.
 *
 * The JS side only knows CSS px; window.devicePixelRatio converts those to
 * physical pixels *relative to the viewport origin* (screen scale × page
 * zoom — a plain DOM read that cannot fail, unlike a remote 'screen' call
 * in the zone-less rAF loop).
 *
 * The viewport's physical origin on screen is NOT resolved in JS: Electron's
 * DIP bounds × scale disagreed with the real window by DWM invisible
 * borders (40 px at the top here), which lifted the popup over the tab bar.
 * Instead the native side adds the owner window's ClientToScreen origin at
 * MoveWindow time — correct across mixed-DPI monitors and window moves.
 */

export interface PhysicalRect {
    x: number
    y: number
    w: number
    h: number
}

/** CSS rect → viewport-relative physical rect (× devicePixelRatio). */
export function holeToViewportPhysical (
    rect: { x: number, y: number, width: number, height: number },
): PhysicalRect {
    const dpr = window.devicePixelRatio || 1
    return {
        x: Math.round(rect.x * dpr),
        y: Math.round(rect.y * dpr),
        w: Math.max(1, Math.round(rect.width * dpr)),
        h: Math.max(1, Math.round(rect.height * dpr)),
    }
}

export function physicalKey (r: PhysicalRect): string {
    return `${r.x},${r.y},${r.w},${r.h}`
}

/**
 * A rect parked in the void: far outside every monitor. (Parking just off
 * the left edge — WebViewer's original semantics — lands on a secondary
 * monitor on multi-display setups.)
 */
export function parkedRect (r: PhysicalRect): PhysicalRect {
    return { x: -32000, y: -32000, w: r.w, h: r.h }
}
