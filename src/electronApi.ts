/**
 * @hidden
 * Single entry point for everything @electron/remote. Tabby's renderer runs
 * with nodeIntegration enabled and Tabby bundles @electron/remote, so the
 * module resolves from the host at runtime (webpack externals keep it out of
 * the bundle).
 *
 * Two hard-won rules (verified in this Tabby line, Electron 43 / Node 22):
 *  1. Use a plain CJS require — @electron/remote's entry sets __esModule
 *     without a default export, so an ES default import yields undefined.
 *  2. NEVER use remote.require('electron') — its main-side handler relies on
 *     process.mainModule, which Electron 43 (Node 22) removed. Use
 *     remote.getBuiltin('<module>') for every main-process module instead.
 */
const remote: any = require('@electron/remote')

/** The BrowserWindow hosting this renderer, as an @electron/remote proxy. */
export function currentWindow (): any {
    return remote.getCurrentWindow()
}

export function currentWebContents (): any {
    return remote.getCurrentWebContents()
}

/**
 * Native HWND of the current window as a Buffer (as Electron returns it),
 * or null when unavailable. This is the z-order owner the RDP popup
 * attaches to.
 */
export function nativeWindowHandle (): Buffer | null {
    try {
        const buf = remote.getCurrentWindow().getNativeWindowHandle()
        return Buffer.isBuffer(buf) && buf.length >= 4 ? buf : null
    } catch {
        return null
    }
}

/**
 * Return keyboard focus to this window's webContents. Hiding the RDP popup
 * while it holds focus can leave the thread with a NULL focus window: the
 * Tabby window stays foreground, but every keystroke (Ctrl+C, hotkeys) is
 * routed into a void until the user happens to click inside the client
 * area — clicking the title bar or taskbar does not recover it. Calling
 * this after every hide we initiate makes the recovery unconditional
 * (idempotent when focus is already in the DOM).
 */
export function focusWebContents (): void {
    try {
        remote.getCurrentWebContents().focus()
    } catch {
        // window going away; nothing to restore
    }
}

/**
 * Scale factor of the display the window is on, in the sense of Electron's
 * `screen` module (1.0 = 100%). `getBoundingClientRect` values are in CSS px
 * (= window DIP including the host's zoom factor); physical pixels =
 * DIP * displayScaleFactor.
 */
export function displayScaleFactor (): number {
    try {
        const win = remote.getCurrentWindow()
        const scale = remote.getBuiltin('screen').getDisplayMatching(win.getContentBounds()).scaleFactor
        return scale > 0 ? scale : 1
    } catch {
        return 1
    }
}

/** The screen-rect of the window's content area, in DIP. */
export function contentBoundsDip (): { x: number, y: number } | null {
    try {
        const b = remote.getCurrentWindow().getContentBounds()
        return { x: b.x, y: b.y }
    } catch {
        return null
    }
}
