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
  scale factor). Visibility is derived from that rect alone: parked rects
  (inactive tabs at `left:-1000%`, collapsed/maximized-away panes) hide the
  popup; split panes that merely lose focus keep showing.
- Window moves are tracked by a native `SetWinEventHook`
  (`EVENT_OBJECT_LOCATIONCHANGE`, out-of-context — dispatched by the manager
  thread's message loop): the viewport-relative rect does not change while
  the window moves, so the rAF loop is blind to them by construction and the
  popup re-anchors per move step instead of catching up in 300 ms jumps.
- Tab activation and overlay yielding park the popup via a native visibility
  API (`setVisible` → real `SW_HIDE`/`SW_SHOWNOACTIVATE`). The yield check is
  a per-frame DOM hit-test (`elementFromPoint` on the hole's center and
  corners): a *mouse-opaque* element covering any sample point — a modal
  backdrop, an open menu — hides the popup so those UIs stay clickable.
  Hint layers (`pointer-events`-transparent tooltips/toasts, plus an
  explicit `.tooltip`/toast-container exclusion) never trigger it.
- Size changes apply throttled (~50 ms) while position changes apply every
  frame: each applied size makes the control re-stretch its framebuffer
  (`WM_SIZE` → full redraw), which at rAF cadence dominated the CPU during
  window resizes. A 20 s / 556-resize storm now produces exactly one
  `UpdateSessionDisplaySettings` call (after the storm settles).
- Live resize is debounced in native (250 ms) and only armed when the rect's
  *size* actually changed; `UpdateSessionDisplaySettings` calls are deduped
  against the last pushed resolution, and a resolution queued while the
  session is still connecting is replayed on `connected` instead of being
  dropped. See the PoC's S3 notes for why calling it per resize tick
  fast-fails the process.

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

### Presentation-layer rework (2026-10-13, user-reported symptoms)

Three user-visible defects traced to the sync mechanisms and fixed together
(**verified live on the arc instance**, see `scripts/move-follow-test.ps1`,
`scripts/overlay-yield-test.js`, `scripts/tabs-switch-test.js`):

1. **"Moving the window stalls the desktop"** — window moves don't change
   the hole's viewport-relative rect, so the rAF loop never re-pushed and
   the only tracker was the 300 ms glue tick (stepwise catch-up). Fixed with
   the WinEvent hook above: popup follows within 100 ms per move step
   (measured delta exactly +200,+100).
2. **"The desktop covers functional UI"** — Tabby's overlays (command
   palette, modals, dropdowns, toasts) render in the DOM, physically below
   the Win32 popup; anything overlapping the hole was unclickable. Fixed
   with the overlay yield: palette open → popup `SW_HIDE`, closed → restored
   (verified end-to-end via CDP).
3. **"Fresh sessions don't fit the pane"** — the initial rect was sampled
   mid-layout in `ngAfterViewInit` (became the RDP resolution), and a
   resolution queued while connecting was dropped at flush time, pinning the
   desktop at its initial size forever. Fixed: the rect is sampled after the
   layout settles (rAF retry loop), non-live pending entries are parked
   (replayed on `connected`), and no-op negotiations are deduped.

Also fixed in the same pass: the coordinate park (`-32000` + 640×480) used
to arm the display debounce on every tab switch — the remote desktop was
genuinely re-negotiated to 640×480 and back; `CMD_SETBOUNDS` now moves only
when the on-screen rect differs (no more per-frame intermediate-size
replays), and `NativeTrace` can be silenced with `ACTIVX_RDP_TRACE=0` (it
ran per-call `fopen`/`fclose` on the STA thread).

### Presentation polish round 2 (2026-10-13, follow-up reports)

- **"Resizing the window burns CPU / refreshes frantically"** — two causes
  fixed: `SWP_NOCOPYBITS` on the per-frame `SetWindowPos` forced a full
  client-area repaint at 60 Hz (removed); size changes are now merged to one
  application per ~50 ms while positions still track every frame (`ReanchorSession`
  honors the throttle too, or the WinEvent path would have leaked every
  intermediate size back in). Verified: 20 s storm at 50 Hz → one resolution
  negotiation, session alive, popup aligned.
- **"Any overlay on the page hides the desktop"** — the first yield
  implementation watched for *any* body-level overlay element intersecting
  the hole, which mis-fired on tooltips (tab-bar hover), toasts and stray
  containers. Replaced with the hit-test yield described above: only
  elements that actually take the mouse over the hole's sampled points
  trigger it. Verified: tooltip shown → popup stays visible; palette
  modal → yields and restores.

### Interaction rework round 3 (2026-10-13, user reports)

- **"Activating one split pane hid the other desktop"** — the park was
  driven by `focused$`/`blurred$`, but in a split tab Tabby blurs every
  non-focused pane (`SplitTabComponent.focus`), even panes that remain
  plainly visible side by side. The focus subscriptions are gone: visibility
  is now derived entirely from the hole's rect in the frame loop — inactive
  tabs move to `left:-1000%` and maximized-away panes collapse, both of
  which park the popup (with a real `SW_HIDE`); focused-but-visible split
  siblings keep showing. While parked the loop drops to a 120 ms poll.
  Verified: two connected panes side by side, focus switched both ways —
  both popups stay visible and aligned.
- **"Connect only after confirmation"** — every new tab opens at a
  connection gate (state `idle`, no session created) instead of firing an
  RDP connection on open. The gate is an **editable connection form**
  (host + port / username + password) prefilled from the profile: an
  empty/builtin "ActiveX RDP" tab starts blank and is fully connectable
  from the form; tabs created from a saved profile arrive with the stored
  values already filled (including the password from the Vault/plain-text
  store). Reconnects after drops and retries after errors reuse the same
  card. The form wins for the connection target; the profile keeps owning
  the advanced knobs (domain, desktop size, NLA/CredSSP). Verified both
  ways: profile tab → prefilled → connected; builtin tab → blank form →
  filled via DOM → connected.
- **Pane UI redesigned** — the barely-visible reconnect link in the status
  strip is gone; the gate card (theme-aware background, border, shadow)
  is the single prominent action surface, and the status strip now shows
  the connection target alongside the state. Enter in any field connects.
- **Disconnect leaves a reachable gate** — after a disconnect the control
  window blanks but stays above the DOM; the popup is now hidden unless
  the session is `connected` (session-active gate in the view host), so
  the Reconnect card is always visible and clickable.

### Logon without NLA (the WSL/xrdp test target)

`ClearTextPassword` auto-submits over two channels. With
`EnableCredSspSupport` **on** and the server unable to negotiate NLA
(Ubuntu's xrdp 0.9.24 package is built without CredSSP — its
`security_layer=hybrid` is not even a recognized value), mstscax downgrades
to TLS but keeps the credentials reserved for the CredSSP layer and never
sends them in the Client Info PDU, so the server shows its own logon screen.
With `EnableCredSspSupport` **off** (profile setting *NLA / CredSSP*,
`enableCredSsp: false`), mstscax takes the legacy path and the stored
username/password ride the Client Info PDU — such servers log in
automatically. Real Windows targets with NLA keep the setting on.

Verified on the test target (2026-10-13): `enableCredSsp: false` +
stored credentials → connected straight into the logged-in XFCE desktop,
no greeter (`scripts/greeter-login.ps1` and its SendKeys automation are no
longer needed for this path).

### i18n and Enter-to-connect (2026-10-17)

- **Translations** — en/zh tables in `src/i18n.ts` covering the settings
  tab, the profile form, the connection gate and the status strip. Same
  approach as BetterConfiger: @ngx-translate/core is not importable from a
  user plugin, so the plugin keeps its own table keyed by tabby-core's
  `LocaleService`; language switches re-render via `localeChanged$`.
  "ActiveX RDP" stays untranslated (brand name). Verified on a zh-CN
  instance: 主机/端口/用户名/密码 placeholders, 连接 button, 空闲/已连接
  states.
- **Enter connects** — a document-level `keydown.enter` host listener fires
  `reconnect()` while the tab is not connected: events from inside the
  component always count, body-targeted events count only when this pane
  is on screen and no modal is open, buttons are skipped (native click).
  The gate card also takes focus when shown (otherwise body-focused Enter
  never bubbles through the host). Verified with focus deliberately left
  on `<body>`: Enter → connected.

Test-environment notes: the arc instance now runs CDP on **9243** (a new
`mux` instance claimed 9242), and the WSL test target needs a keep-alive
process during tests — WSL's `vmIdleTimeout` shuts the whole VM down mid
RDP session otherwise (the disconnect looks like reason 2/516 from the
client side).

### NULL-focus keyboard blackout fix (2026-10-25, user report)

**Symptom**: in some cases Tabby "captured" every hotkey (Ctrl+C etc.) even
with focus outside the remote desktop; only restarting Tabby cleared it.

**Root cause** (reproduced on the arc instance): hiding the popup while the
mstscax input window (`IHWindowClass`) holds focus can leave the thread
with a **NULL focus window** — observed on network-level disconnects
(WSL `wsl --shutdown`: no TCP RST, so the control tears down asynchronously)
but not on immediate disconnects (killing the xrdp connection process).
With NULL focus and Tabby still foreground, every keystroke is routed into
a void: DOM keydown never fires, and clicking the title bar or taskbar does
not recover it — only a click inside the client area does, which is why it
felt like a stuck capture. Forensics: `GetGUIThreadInfo` focus field +
real-input Ctrl+C vs a CDP keydump (focus=0x0 → `[]`; focus=Electron →
keys arrive).

**Fix**: every path where WE initiate hiding the popup now returns focus
explicitly via `webContents.focus()` (idempotent when focus is already in
the DOM): session deactivation (disconnected/fatal/logon error), tab
parking, and tab destruction. Overlay yielding does not (focus is already
in the DOM when an overlay is up). Verified end to end: real-input Ctrl+C
with zero clicks after a VM-kill disconnect reaches the DOM (was `[]`
before the fix).

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
