# tabby-activx-rdp-client

RDP desktops in Tabby tabs, rendered by the **system ActiveX control**
(`mstscax.dll`) through a native N-API addon. The RDP connection — TLS,
CredSSP, the socket — is made **end-to-end by the Microsoft-signed RDP
stack**; the plugin's native code never touches the network. This is the
differentiator versus `tabby-rdp` (IronRDP wasm + canvas): in environments
with per-process network locks, third-party protocol stacks are not an
option.

Architecture and the full feasibility analysis live in the PoC repo:
`D:\Home\Project\PoCElectronActivxRDPBridge\TABBY-INTEGRATION.md`.

## How it works

- A dedicated STA thread in the renderer process hosts the control in an ATL
  `CAxWindow` created as an **owned popup** of the Tabby window (Chromium's
  presentation layer covers child HWNDs; only owned popups survive z-order).
- The tab component renders a "hole" placeholder div; the popup's physical
  screen rect is aligned to it every animation frame (rect in DIP × display
  scale factor).
- Live resize is debounced in native (250 ms) — see the PoC's S3 notes for
  why calling `UpdateSessionDisplaySettings` per resize tick fast-fails the
  process.

## Status

- [x] M1 plugin skeleton (profile provider, tab component, diagnostics)
- [x] M2 native addon migration + build (node-gyp, `scripts/build-native.js`)
- [x] M3 native bridge + hole/popup sync — **verified 2026-10-09**: hotkey opens
      the RDP tab, sessions connect (two concurrent), debounced live resize
      returns S_OK, and the xrdp greeter renders inside the tab area
      (physical screenshot; CDP cannot see native popups)
- [x] M4 polish — profile settings form (host/port/user/domain/password,
      Vault-backed credentials via `credentials.ts`), tab recovery,
      disconnect/reconnect hotkeys (bound in Settings › Hotkeys), settings
      page with diagnostics
- [x] M5 resize-storm regression — **verified 2026-10-09**: 1291 resizes at
      15 ms against the Tabby window → **zero crashes** (Application log
      clean), both sessions stayed alive, debounce collapsed the storm into
      3 `UpdateSessionDisplaySettings` calls (2 × E_UNEXPECTED swallowed by
      the raw_ call, 1 × S_OK after the storm ended)

### Host-specific hardening found in M3 (all fixed in native/rdp_host.cpp)

The PoC ran the addon in Electron's **main** process; Tabby loads it in the
**renderer**, which changes the Win32 environment:

1. **Dynamic require is rewritten by webpack** into `__webpack_require__`
   (even with a `webpackIgnore` comment — ATL drops it) → MODULE_NOT_FOUND
   for a file that exists. Fixed with the `__non_webpack_require__` /
   `eval('require')` escape hatch chain in `src/nativeBridge.ts`.
2. **mstscax's internal STA pump eats posted messages**: during
   `raw_Connect()` the control pumps the calling thread and dispatches our
   `WM_CMD` (posted to a plain "Static" message window) to the default
   wndProc — silently dropped. Any `create()` posted during a `connect()`
   vanished (15 s timeout). Fixed: private window class `rdphostMgrWnd`
   with our own wndProc handling `WM_CMD`.
3. **Cross-process SetWindowPos blocks**: with the addon in the renderer the
   owner HWND belongs to the main process; the glue timer's z-order
   `SetWindowPos(owner)` is a synchronous cross-process call that can hang
   the manager thread. Fixed: `SWP_ASYNCWINDOWPOS` everywhere we re-assert
   z-order.

### Tab-integration fixes (2026-10-09, user-reported "desktop covers the window")

- **Wrong visibility signal**: `BaseTabComponent.visibility$` is *window-level*
  (minimized/hidden), not tab activation — switching tabs left the popup
  covering the window. Parking is now driven by `focused$`/`blurred$`.
- **Park bypassed the bounds-key cache**: hiding pushed the park rect
  directly, so on re-activation the frame loop computed the *same* key as
  before and never re-pushed — the popup stayed parked (or, before the
  DPI fixes, at a stale CSS-sized position). The key is now invalidated on
  every visibility change.
- **DPI virtualization of the popup**: the manager thread's `MoveWindow`
  coordinates were silently rescaled by Windows (the thread had no explicit
  DPI context; ×2/3 at 1.5× was observed). `Run()` now sets
  `SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2)` — coordinates are
  true physical pixels, and an instrumented `want == got` round-trip
  verifies it.
- **Observation-tool trap**: system-DPI-aware PowerShell reads coordinates
  of windows on *other* monitors rescaled (×1.5/1.25 here), which made
  correctly-placed popups look misplaced. All observation scripts
  (`popup-rect.ps1`, `phys-shot.ps1`, `greeter-login.ps1`) now run
  Per-Monitor-V2.
- **Viewport-relative anchoring** (the last piece of "covers the tab bar"):
  Electron's DIP bounds × scale disagree with the window's real physical
  rect by DWM invisible borders (observed 40 px at the top) — every
  DIP-based screen-coordinate computation lifted the popup over the tab
  bar. The JS side now sends only *viewport-relative* physical rects
  (CSS × devicePixelRatio); the native side resolves the owner's true
  client origin via `ClientToScreen` at move time, and the glue tick
  re-anchors every 300 ms so window moves track (they don't change the
  hole's viewport rect, so the rAF loop alone would never re-push).
- **Pane inset**: the hole now carries a 6 px margin and a persistent status
  strip sits below it, so the desktop reads as pane content with a frame
  instead of covering the window.
- **Startup tab-recovery storm**: restored RDP tabs no longer auto-connect
  (a dozen restored sessions fired at once); they park idle with a
  reconnect button, and `create()`'s synchronous wait ceiling dropped from
  15 s to 5 s (it runs on the renderer's main thread).
- Verified on the dual-monitor setup (main 1.5×, secondary 1.25×): popup
  lands exactly on the hole's physical rect, tab bar untouched, switch
  away/back parks and restores, window move follows, and the logged-in
  XFCE desktop renders inside the framed pane.

### Logon on the WSL test target

`ClearTextPassword` only auto-submits over CredSSP/NLA. Ubuntu's xrdp 0.9.24
advertises `[SSL|RDP]` even with `security_layer=negotiate`, so the greeter
is expected there — real Windows targets with NLA log in automatically.
For the test target, `scripts/greeter-login.ps1` auto-fills the greeter via
clipboard sync + SendKeys (the RDP channel forwards the local clipboard).

## Dev

```bash
npm install
npm run build          # webpack → dist/
npm run build:native   # node-gyp → native/rdp_host.node (needs MSVC + ATL)
npm run deploy         # copy into an isolated Tabby instance
```

## Caveats

- Windows-only (the control is a Win32/COM object); other platforms render
  a diagnostics panel instead.
- Passwords go to Tabby's Vault (Settings › Vault, encrypted) when it is
  enabled; otherwise they fall back to plain text in `config.yaml` — the
  profile form tells you which store is in use.
- While the RDP desktop has focus, keys go to the remote session and
  Tabby's DOM hotkeys do not fire (by design; bind the plugin's
  disconnect/reconnect hotkeys, which work through the hotkey service).
