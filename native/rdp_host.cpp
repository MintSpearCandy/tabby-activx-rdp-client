// rdp_host.cpp — STA worker thread + ATL OLE container (CAxWindow) hosting
// the system RDP ActiveX control "MsTscAx.MsTscAx" (mstscax.dll).
//
// IMPORTANT (process-lock context): none of our code ever touches the network.
// The RDP socket is opened end-to-end by mstscax.dll itself.

#include "rdp_host.h"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <utility>

#include <atlbase.h>
#include <atlcom.h>
#include <atlwin.h>
#include <atlhost.h>

// Pulls in the full RDP control typelib (IMsTscAx, IMsRdpClient9/10,
// IMsRdpClientAdvancedSettings*, IMsTscAxEvents, ...) as C++ types.
#import "C:\\Windows\\System32\\mstscax.dll" no_namespace

namespace rdphost {
namespace {

// Native-side diagnostics land in a file (stdout is not attached when the
// addon runs inside Tabby's renderer). Path: %TEMP%\tabby-activx-rdp\trace.log
// (the plugin directory itself may be read-only), overridable via the
// ACTIVX_RDP_TRACE env var (set it to "0" to silence: the per-call
// fopen/vfprintf runs on the manager STA thread — the same thread that
// hosts the RDP control — and event storms made it a real stutter source).
// Resolved once per process.
void NativeTrace(const char* fmt, ...) {
  static const bool on = [] {
    wchar_t v[8]{};
    return !(GetEnvironmentVariableW(L"ACTIVX_RDP_TRACE", v, 8) &&
             wcscmp(v, L"0") == 0);
  }();
  if (!on) return;
  static const std::wstring logPath = [] {
    wchar_t dir[MAX_PATH * 2]{};
    const wchar_t* base = nullptr;
    wchar_t env[MAX_PATH * 2]{};
    if (GetEnvironmentVariableW(L"ACTIVX_RDP_TRACE", env, MAX_PATH * 2) && env[0]) {
      return std::wstring(env);
    }
    if (GetTempPathW(MAX_PATH * 2, dir) && dir[0]) {
      std::wstring p = dir;
      p += L"tabby-activx-rdp";
      CreateDirectoryW(p.c_str(), nullptr);  // best effort
      return p + L"\\trace.log";
    }
    return std::wstring(L"tabby-activx-rdp-trace.log");
  }();
  FILE* f = _wfopen(logPath.c_str(), L"a");
  if (!f) return;
  va_list ap;
  va_start(ap, fmt);
  vfprintf(f, fmt, ap);
  fputc('\n', f);
  fclose(f);
}

constexpr UINT WM_CMD = WM_APP + 0x120;

// Manager-thread timer IDs.
constexpr UINT_PTR TIMER_GLUE = 1;      // periodic z-order glue
constexpr UINT_PTR TIMER_DISPLAY = 2;   // debounced live-resize flush
constexpr UINT_PTR TIMER_SIZE_FLUSH = 3;  // throttled size application
// How long the window must stay quiet before we push one live-resize into
// the control. UpdateSessionDisplaySettings walks the RDP connection layer
// (framebuffer realloc + server negotiation); calling it per WM_SIZE tick
// fails with E_UNEXPECTED mid-negotiation and, via the #import high-level
// wrapper, used to surface as an uncaught _com_error.
constexpr UINT DISPLAY_DEBOUNCE_MS = 250;
// Every applied size change makes the control re-stretch its framebuffer
// (WM_SIZE -> in-place resize -> full redraw). At the rAF loop's cadence
// that dominates CPU during window resizes, so position updates apply every
// frame (cheap — pure window moves) while size updates are merged to at
// most one per interval.
constexpr UINT SIZE_THROTTLE_MS = 50;

// Message-only command window procedure: WM_CMD is handled here so delivery
// survives foreign pumps on the manager thread (see Run()). Defined after
// Manager (needs the complete type).
LRESULT CALLBACK MgrWndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp);

// Owner-move tracker (out-of-context WinEvent; dispatched by this thread's
// message loop). Also defined after Manager.
void CALLBACK WinEventProc(HWINEVENTHOOK hook, DWORD event, HWND hwnd,
                           LONG idObject, LONG idChild, DWORD idThread,
                           DWORD dwmsEventTime);

// ATL hosting (CAxWindow) requires a live CAtlModule: CComPolyObject
// constructors call _pAtlModule->Lock(), and ATL's selectany _AtlComModule
// (a) is dead-stripped by /OPT:REF in this addon and (b) derives from the
// raw _ATL_COM_MODULE70 struct, not from CAtlModule — it never sets
// _pAtlModule. Provide a real CAtlModule-derived module instead. A
// function-local static is referenced by code, so the linker keeps it.
class RdpAtlModule : public CAtlModuleT<RdpAtlModule> {};
CAtlModule& AtlModule() {
  static RdpAtlModule module;
  return module;
}

enum Cmd : UINT_PTR {
  CMD_CREATE = 1,
  CMD_CONNECT,
  CMD_DISCONNECT,
  CMD_DESTROY,
  CMD_SETBOUNDS,
  CMD_SETVISIBLE,
  CMD_UPDATE_DISPLAY,
  CMD_SHUTDOWN,
};

int64_t VariantToInt(const VARIANT& v) {
  switch (v.vt) {
    case VT_I2:    return v.iVal;
    case VT_I4:    return v.lVal;
    case VT_UI1:   return v.bVal;
    case VT_UI2:   return v.uiVal;
    case VT_UI4:   return v.ulVal;
    case VT_I8:    return v.llVal;
    case VT_UI8:   return v.ullVal;
    case VT_BOOL:  return v.boolVal ? 1 : 0;
    case VT_ERROR: return v.scode;
    default:       return 0;
  }
}

class EventSink;  // defined below; Session only holds a pointer

// Connected-event replay hook, defined after Manager (needs the complete
// type) — the sink's Invoke is inline and runs before Manager is declared.
void ReplayPendingDisplayOnConnected(SessionId id);

struct Session {
  SessionId id = 0;
  SessionOptions opt;
  HWND owner = nullptr;                 // Electron top-level window (z anchor)
  CAxWindow host;                       // the AtlAxWin32 OLE container window
  CComPtr<IMsTscAx> ctrl;               // the RDP control
  CComPtr<IConnectionPoint> cp;
  DWORD cookie = 0;
  CComObject<EventSink>* sink = nullptr;
  EventCb onEvent;
  bool live = false;  // manager thread: between connected() and disconnected()
  bool shown = true;  // JS visibility intent (tab active / no overlay); owner
                      // state still gates the final SW_SHOW in the glue tick
  RECT viewportRect{};  // last viewport-relative rect pushed by JS (manager thread)
  long lastDispW = 0;  // resolution last pushed into UpdateSessionDisplaySettings
  long lastDispH = 0;  // (initialized from opt; skips no-op negotiations)
  ULONGLONG lastSizeApply = 0;  // GetTickCount64 of the last applied size change
  SIZE throttledSize{};         // deferred target while a resize storm runs
  bool hasThrottledSize = false;
};

// IDispatch sink for the control's source dispinterface IMsTscAxEvents.
class EventSink : public CComObjectRootEx<CComSingleThreadModel>,
                  public IDispatch {
 public:
  BEGIN_COM_MAP(EventSink)
    COM_INTERFACE_ENTRY(IDispatch)
    // The control's connection point QIs the sink for the event interface
    // IID before accepting Advise — answer it with our IDispatch.
    COM_INTERFACE_ENTRY_IID(__uuidof(IMsTscAxEvents), EventSink)
  END_COM_MAP()

  SessionId sid = 0;
  const EventCb* cb = nullptr;  // owned by Session; sink lives on the same thread
  Session* sess = nullptr;      // manager thread: tracks connection state

  STDMETHOD(GetTypeInfoCount)(UINT*) override { return E_NOTIMPL; }
  STDMETHOD(GetTypeInfo)(UINT, LCID, ITypeInfo**) override { return E_NOTIMPL; }
  STDMETHOD(GetIDsOfNames)(REFIID, LPOLESTR*, UINT, LCID, DISPID*) override {
    return E_NOTIMPL;
  }
  STDMETHOD(Invoke)(DISPID dispid, REFIID, LCID, WORD, DISPPARAMS* params,
                    VARIANT*, EXCEPINFO*, UINT*) override {
    int64_t a = 0, b = 0;
    if (params) {
      // DISPPARAMS are in reverse order: last logical arg is rgvarg[0].
      if (params->cArgs >= 1) a = VariantToInt(params->rgvarg[params->cArgs - 1]);
      if (params->cArgs >= 2) b = VariantToInt(params->rgvarg[params->cArgs - 2]);
    }
    // desktopSizeChange(12)/serviceMessageReceived(27) fire in bursts while
    // the user drags the window edge; tracing every one hammers the disk.
    if (dispid == 12 || dispid == 27) {
      if ((++hfTrace & 31) == 1) {
        NativeTrace("[rdphost] event sid=%u dispid=%d (%s) a=%lld b=%lld (1/32 sampled)",
                    (unsigned)sid, dispid, EventName(dispid), (long long)a, (long long)b);
      }
    } else {
      NativeTrace("[rdphost] event sid=%u dispid=%d (%s) a=%lld b=%lld", (unsigned)sid,
                  dispid, EventName(dispid), (long long)a, (long long)b);
    }
    // Connection lifecycle gates live resize: UpdateSessionDisplaySettings is
    // only valid between connected(2) and the first terminal event.
    if (sess) {
      if (dispid == 2) {
        sess->live = true;
        // The session just went live: replay any resolution queued while it
        // was still connecting. FlushPendingDisplay parks non-live pending
        // entries, so without this the desktop keeps its initial size until
        // the next unrelated setBounds change.
        ReplayPendingDisplayOnConnected(sess->id);
      } else if (dispid == 4 || dispid == 10 || dispid == 23) {
        sess->live = false;
      }
    }
    if (cb && *cb) (*cb)(sid, dispid, a, b);
    return S_OK;
  }

  unsigned hfTrace = 0;
};

struct CreateParams {
  SessionId id = 0;
  HWND parent = nullptr;
  RECT rect{};
  SessionOptions opt;
  EventCb onEvent;
  bool ok = false;
  HANDLE done = nullptr;
};

class Manager {
 public:
  static Manager& Inst() {
    static Manager inst;
    return inst;
  }

  ~Manager() { Stop(); }  // std::thread::~thread on a joinable thread aborts

  bool Start() {
    AtlModule();  // set ATL::_pAtlModule before any control creation
    std::lock_guard<std::mutex> lk(lifeMtx_);
    if (thread_.joinable()) return ready_.load();
    readyEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    stoppedEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    thread_ = std::thread(&Manager::Run, this);
    bool ok = WaitForSingleObject(readyEvent_, 8000) == WAIT_OBJECT_0 && ready_.load();
    if (!ok) printf("[rdphost] manager thread failed to start\n");
    return ok;
  }

  void Stop() {
    std::thread toJoin;
    {
      std::lock_guard<std::mutex> lk(lifeMtx_);
      if (!thread_.joinable()) return;
      if (msgWnd_) PostMessageW(msgWnd_, WM_CMD, CMD_SHUTDOWN, 0);
      toJoin = std::move(thread_);
    }
    if (WaitForSingleObject(stoppedEvent_, 6000) == WAIT_OBJECT_0) {
      if (toJoin.joinable()) toJoin.join();
    } else if (toJoin.joinable()) {
      // Never let a joinable std::thread destruct: that fast-fails the whole
      // process with 0xc0000409. The stuck manager thread leaks, but the
      // process is on its way out anyway.
      NativeTrace("[rdphost] Stop: manager thread stuck >6s, detaching");
      toJoin.detach();
    }
  }

  SessionId Create(HWND parent, const RECT& rect, const SessionOptions& opt,
                   EventCb onEvent, bool* ok) {
    *ok = false;
    if (!Start()) return 0;

    CreateParams p;
    p.id = nextId_.fetch_add(1) + 1;
    p.parent = parent;
    p.rect = rect;
    p.opt = opt;
    p.onEvent = std::move(onEvent);
    p.done = CreateEventW(nullptr, TRUE, FALSE, nullptr);

    {
      DWORD wndPid = 0;
      const DWORD wndTid = msgWnd_ ? GetWindowThreadProcessId(msgWnd_, &wndPid) : 0;
      NativeTrace("[rdphost] Create: thread=%lu params=%p done=%p msgWnd=%p ownerTid=%lu curPid=%lu wndPid=%lu",
                  (unsigned long)GetCurrentThreadId(), (void*)&p, (void*)p.done, (void*)msgWnd_,
                  (unsigned long)wndTid, (unsigned long)GetCurrentProcessId(), (unsigned long)wndPid);
    }
    if (!PostMessageW(msgWnd_, WM_CMD, CMD_CREATE, reinterpret_cast<LPARAM>(&p))) {
      NativeTrace("[rdphost] Create: PostMessage failed gle=%lu", GetLastError());
      CloseHandle(p.done);
      return 0;
    }
    // Creating a child window whose parent belongs to another thread (the
    // host's window thread) requires this thread to pump messages while it
    // waits (cross-thread sends during CreateWindowEx/OLE in-place
    // activation). Cap the per-round Peek drain: Chromium's renderer thread
    // self-feeds messages (each dispatch posts more), and an uncapped inner
    // loop never returns to MsgWaitForMultipleObjects — the done-event would
    // starve until the deadline even after DoCreate finished.
    DWORD wr = WAIT_TIMEOUT;
    bool quitPosted = false;
    // 5 s ceiling, not 15: this wait runs on the host's JS thread (Tabby's
    // renderer main thread), and every blocked second is UI the whole
    // window cannot pump. A healthy DoCreate finishes in well under a
    // second; anything past 5 s is an environment problem worth failing
    // loudly and early.
    const ULONGLONG deadline = GetTickCount64() + 5000;
    ULONGLONG lastDiag = 0;
    for (;;) {
      const LONGLONG left64 = (LONGLONG)deadline - (LONGLONG)GetTickCount64();
      if (left64 <= 0) break;
      DWORD w = MsgWaitForMultipleObjects(1, &p.done, FALSE, (DWORD)left64, QS_ALLINPUT);
      if (w == WAIT_OBJECT_0) { wr = w; break; }
      if (w == WAIT_FAILED) { wr = w; break; }
      const ULONGLONG now = GetTickCount64();
      if (now - lastDiag > 2000) {
        lastDiag = now;
        NativeTrace("[rdphost] Create wait diag: MsgWait=%lu doneSignaled=%d quitSeen=%d handle=%p",
                    (unsigned long)w,
                    WaitForSingleObject(p.done, 0) == WAIT_OBJECT_0 ? 1 : 0,
                    (int)quitPosted, (void*)p.done);
      }
      MSG m;
      int drained = 0;
      while (drained < 64 && PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) {
        if (m.message == WM_QUIT) { PostQuitMessage((int)m.wParam); quitPosted = true; break; }
        TranslateMessage(&m);
        DispatchMessageW(&m);
        drained++;
      }
      if (quitPosted) break;
    }
    if (wr != WAIT_OBJECT_0) {
      NativeTrace("[rdphost] CreateSession: wait result=%lu (timeout/failed)", (unsigned long)wr);
    }
    CloseHandle(p.done);
    *ok = p.ok;
    return p.ok ? p.id : 0;
  }

  // Entry for MgrWndProc (declared before this class).
  void HandleCmdPublic(UINT_PTR cmd, LPARAM lp) { Handle(cmd, lp); }

  // Entry for WinEventProc (same pattern).
  void ReanchorForOwnerPublic(HWND owner) { ReanchorForOwner(owner); }

  // Entry for ReplayPendingDisplayOnConnected (same pattern).
  void FlushPendingDisplayForPublic(SessionId id) { FlushPendingDisplayFor(id); }

  bool Post(UINT_PTR cmd, SessionId id) {
    HWND w = msgWnd_;
    return w != nullptr && PostMessageW(w, WM_CMD, cmd, static_cast<LPARAM>(id));
  }

  void QueueBounds(SessionId id, const RECT& r) {
    std::lock_guard<std::mutex> lk(pm_);
    pendingBounds_[id] = r;
  }

  void SetVisible(SessionId id, bool v) {
    {
      std::lock_guard<std::mutex> lk(pm_);
      visible_[id] = v;
    }
    Post(CMD_SETVISIBLE, id);
  }

  void QueueDisplay(SessionId id, long w, long h) {
    std::lock_guard<std::mutex> lk(pm_);
    pendingDisp_[id] = {w, h};
  }

 private:
  void Run() {
    // This thread creates and moves the RDP popup. Without an explicit
    // per-monitor-aware context Windows treats its MoveWindow coordinates
    // as DPI-virtualized logical units and silently rescales them (an
    // owned-popup process context at 1.5x turned our physical coords into
    // ×2/3), so every setBounds landed in the wrong place.
    {
      HMODULE u32 = GetModuleHandleW(L"user32.dll");
      if (u32) {
        typedef DPI_AWARENESS_CONTEXT(WINAPI* FnSetCtx)(DPI_AWARENESS_CONTEXT);
        FnSetCtx set = (FnSetCtx)GetProcAddress(u32, "SetThreadDpiAwarenessContext");
        if (set) {
          set(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
      }
    }
    const HRESULT hrOle = OleInitialize(nullptr);
    AtlAxWinInit();
    // Private window class with our own wndProc: mstscax runs an internal STA
    // pump on this thread during Connect(), and that pump dispatches posted
    // messages to their window's default procedure — a "Static" window drops
    // our WM_CMD on the floor (create calls posted during a connect used to
    // vanish). Handling WM_CMD in the wndProc makes delivery independent of
    // who pumps.
    WNDCLASSW wc{};
    wc.lpfnWndProc = &MgrWndProc;
    wc.lpszClassName = L"rdphostMgrWnd";
    wc.hInstance = GetModuleHandleW(nullptr);
    RegisterClassW(&wc);
    msgWnd_ = CreateWindowExW(0, wc.lpszClassName, L"rdphost-mgr", WS_POPUP, 0, 0, 0, 0,
                              HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    NativeTrace("[rdphost] Run: manager thread=%lu msgWnd=%p", (unsigned long)GetCurrentThreadId(), (void*)msgWnd_);
    // Chromium keeps re-raising its content windows above our sibling AtlAxWin
    // host; re-assert our z-order periodically.
    if (msgWnd_) SetTimer(msgWnd_, TIMER_GLUE, 300, nullptr);
    ready_.store(msgWnd_ != nullptr);
    SetEvent(readyEvent_);

    MSG msg;
    while (msgWnd_ && GetMessageW(&msg, nullptr, 0, 0) > 0) {
      // An escaping C++ exception on this thread (e.g. a _com_error from an
      // #import wrapper) crosses the std::thread entry and aborts the whole
      // process with 0xc0000409. Never let one get past the pump.
      try {
        // WM_CMD is handled inside MgrWndProc (reached via DispatchMessage
        // below) — that way it is delivered exactly once regardless of
        // whether this loop or a foreign pump (mstscax's internal STA pump
        // during Connect) dispatches it.
        if (msg.hwnd == msgWnd_ && msg.message == WM_TIMER &&
                   msg.wParam == TIMER_GLUE) {
          static DWORD s_tick = 0;
          if ((++s_tick % 20) == 1) NativeTrace("[rdphost] glue tick alive (#%u)", (unsigned)s_tick);
          for (auto& kv : sessions_) {
            Session* s = kv.second.get();
            if (!s->host.m_hWnd) continue;
            // Stay glued directly above the Electron window in z-order, and
            // mirror both the owner's minimized/hidden state and the JS
            // visibility intent (tab active / overlay yielding).
            const bool ownerVisible = s->owner && !IsIconic(s->owner) && IsWindowVisible(s->owner);
            if (!ownerVisible || !s->shown) {
              if (IsWindowVisible(s->host.m_hWnd)) ShowWindow(s->host.m_hWnd, SW_HIDE);
              continue;
            }
            // Re-anchor (fallback path): window moves are tracked primarily
            // by the WinEvent hook below; the tick catches anything it misses.
            ReanchorSession(s);
            if (!IsWindowVisible(s->host.m_hWnd)) ShowWindow(s->host.m_hWnd, SW_SHOWNOACTIVATE);
            BOOL okz = s->host.SetWindowPos(s->owner, 0, 0, 0, 0,
                                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
            static DWORD s_zlog = 0;
            if (!okz && (++s_zlog % 10) == 1) {
              NativeTrace("[rdphost] glue SetWindowPos FAILED gle=%lu", GetLastError());
            }
          }
        } else if (msg.hwnd == msgWnd_ && msg.message == WM_TIMER &&
                   msg.wParam == TIMER_DISPLAY) {
          KillTimer(msgWnd_, TIMER_DISPLAY);
          FlushPendingDisplay();
        } else if (msg.hwnd == msgWnd_ && msg.message == WM_TIMER &&
                   msg.wParam == TIMER_SIZE_FLUSH) {
          KillTimer(msgWnd_, TIMER_SIZE_FLUSH);
          FlushThrottledSizes();
        } else {
          TranslateMessage(&msg);
          DispatchMessageW(&msg);
        }
      } catch (...) {
        NativeTrace("[rdphost] caught unexpected native exception while handling msg=0x%x wp=%llu lp=%llu — recovering",
                    (unsigned)msg.message, (unsigned long long)msg.wParam,
                    (unsigned long long)msg.lParam);
      }
    }
    if (msgWnd_) KillTimer(msgWnd_, TIMER_GLUE);
    if (msgWnd_) KillTimer(msgWnd_, TIMER_DISPLAY);
    if (msgWnd_) KillTimer(msgWnd_, TIMER_SIZE_FLUSH);
    if (winEventHook_) {
      UnhookWinEvent(winEventHook_);
      winEventHook_ = nullptr;
    }

    for (auto& kv : sessions_) Teardown(kv.second.get());
    sessions_.clear();
    msgWnd_ = nullptr;
    if (SUCCEEDED(hrOle)) OleUninitialize();
    SetEvent(stoppedEvent_);
  }

  Session* Get(SessionId id) {
    auto it = sessions_.find(id);
    return it == sessions_.end() ? nullptr : it->second.get();
  }

  // Move the popup to viewportRect + the owner's current client origin, with
  // a GetWindowRect compare so repeated calls (WinEvent storm + glue tick)
  // only issue the move when the on-screen rect actually differs. While a
  // size is being throttled, the window keeps its current size (the deferred
  // size is applied by TIMER_SIZE_FLUSH) — otherwise this path would apply
  // every intermediate size and defeat the throttle.
  void ReanchorSession(Session* s) {
    if (!s->host.m_hWnd || !s->shown) return;
    POINT org{0, 0};
    if (!s->owner || !ClientToScreen(s->owner, &org)) return;
    LONG w = s->viewportRect.right - s->viewportRect.left;
    LONG h = s->viewportRect.bottom - s->viewportRect.top;
    if (w <= 0 || h <= 0) return;
    if (s->hasThrottledSize) {
      RECT cur{};
      if (GetWindowRect(s->host.m_hWnd, &cur)) {
        w = cur.right - cur.left;
        h = cur.bottom - cur.top;
      }
    }
    const LONG wantX = s->viewportRect.left + org.x;
    const LONG wantY = s->viewportRect.top + org.y;
    RECT cur{};
    if (GetWindowRect(s->host.m_hWnd, &cur) &&
        (cur.left != wantX || cur.top != wantY ||
         cur.right - cur.left != w || cur.bottom - cur.top != h)) {
      s->host.MoveWindow(wantX, wantY, w, h, FALSE);
    }
  }

  // Apply a size change (position from viewportRect + the owner's current
  // client origin) and arm the debounced resolution sync.
  void ApplySessionSize(Session* s, long w, long h) {
    s->lastSizeApply = GetTickCount64();
    POINT org{0, 0};
    const bool haveOrg = s->owner && ClientToScreen(s->owner, &org);
    const int px = haveOrg ? s->viewportRect.left + org.x : s->viewportRect.left;
    const int py = haveOrg ? s->viewportRect.top + org.y : s->viewportRect.top;
    s->host.SetWindowPos(nullptr, px, py, w, h, SWP_NOACTIVATE | SWP_NOZORDER);
    {
      std::lock_guard<std::mutex> lk(pm_);
      pendingDisp_[s->id] = {w, h};
    }
    SetTimer(msgWnd_, TIMER_DISPLAY, DISPLAY_DEBOUNCE_MS, nullptr);
  }

  // TIMER_SIZE_FLUSH: apply the deferred size of every session whose resize
  // was merged during a storm.
  void FlushThrottledSizes() {
    for (auto& kv : sessions_) {
      Session* s = kv.second.get();
      if (!s->hasThrottledSize || !s->host.m_hWnd) continue;
      s->hasThrottledSize = false;
      ApplySessionSize(s, s->throttledSize.cx, s->throttledSize.cy);
    }
  }

  // WinEvent callback path: the owner moved/resized — re-anchor every
  // session attached to that owner immediately, instead of waiting for the
  // 300 ms glue tick (the drag looked like the desktop "stalling" and
  // catching up in steps).
  void ReanchorForOwner(HWND owner) {
    for (auto& kv : sessions_) {
      Session* s = kv.second.get();
      if (s->owner == owner) ReanchorSession(s);
    }
  }

  // Called from DoCreate (manager thread). Hooks all processes except our
  // own (the renderer's internal Chromium windows fire constant location
  // events); the callback filters by owner HWND. Not PID-scoped so multiple
  // Tabby windows (one owner per renderer) all track.
  void TryInstallWinEventHook() {
    if (winEventHook_) return;
    winEventHook_ = SetWinEventHook(
        EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, nullptr,
        &WinEventProc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    NativeTrace("[rdphost] SetWinEventHook(LOCATIONCHANGE) = %p gle=%lu",
                (void*)winEventHook_, GetLastError());
  }

  void Handle(UINT_PTR cmd, LPARAM lp) {
    const SessionId id = static_cast<SessionId>(lp);
    switch (cmd) {
      case CMD_CREATE:
        DoCreate(reinterpret_cast<CreateParams*>(lp));
        break;
      case CMD_CONNECT: {
        Session* s = Get(id);
        if (s && s->ctrl) {
          // raw_: the #import high-level wrapper throws _com_error on failure.
          HRESULT hr = s->ctrl->raw_Connect();
          if (FAILED(hr)) NativeTrace("[rdphost] raw_Connect hr=0x%08lx", (unsigned long)hr);
        }
        break;
      }
      case CMD_DISCONNECT: {
        Session* s = Get(id);
        if (s && s->ctrl) s->ctrl->raw_Disconnect();
        break;
      }
      case CMD_SETBOUNDS: {
        RECT r{};
        bool has = false;
        {
          std::lock_guard<std::mutex> lk(pm_);
          auto it = pendingBounds_.find(id);
          if (it != pendingBounds_.end()) {
            r = it->second;
            pendingBounds_.erase(it);
            has = true;
          }
        }
        Session* s = Get(id);
        if (s && has && s->host.m_hWnd) {
          // The incoming rect is viewport-relative physical px. Resolve the
          // owner's real client origin with ClientToScreen: Electron's DIP
          // bounds × scale disagree with the window's physical rect by DWM
          // invisible borders (observed 40 px at the top), which used to
          // lift the popup over the tab bar. ClientToScreen also tracks
          // window moves and mixed-DPI monitors for free. The raw
          // viewport-relative rect is remembered for the glue-tick re-anchor.
          const long newW = r.right - r.left, newH = r.bottom - r.top;
          const bool sizeChanged =
              newW != (s->viewportRect.right - s->viewportRect.left) ||
              newH != (s->viewportRect.bottom - s->viewportRect.top);
          s->viewportRect = r;  // position intent is always the latest
          if (sizeChanged) {
            const ULONGLONG now = GetTickCount64();
            if (now - s->lastSizeApply < SIZE_THROTTLE_MS) {
              // Resize storm mid-flight: keep the position tracking (pure
              // window moves are cheap) but defer the size — every applied
              // size change makes the control re-stretch its framebuffer
              // (WM_SIZE -> full redraw), which at rAF cadence dominated
              // the CPU during window resizes.
              RECT cur{};
              long curW = newW, curH = newH;
              if (GetWindowRect(s->host.m_hWnd, &cur)) {
                curW = cur.right - cur.left;
                curH = cur.bottom - cur.top;
              }
              s->throttledSize = {newW, newH};
              s->hasThrottledSize = true;
              SetTimer(msgWnd_, TIMER_SIZE_FLUSH,
                       SIZE_THROTTLE_MS - (UINT)(now - s->lastSizeApply) + 1, nullptr);
              POINT org{0, 0};
              const bool haveOrg = s->owner && ClientToScreen(s->owner, &org);
              const int px = haveOrg ? r.left + org.x : r.left;
              const int py = haveOrg ? r.top + org.y : r.top;
              if (!(cur.left == px && cur.top == py)) {
                s->host.SetWindowPos(nullptr, px, py, curW, curH,
                                     SWP_NOACTIVATE | SWP_NOZORDER);
              }
              break;
            }
            ApplySessionSize(s, newW, newH);
          } else {
            // Pure move: dedup and track.
            POINT org{0, 0};
            const bool haveOrg = s->owner && ClientToScreen(s->owner, &org);
            const int px = haveOrg ? r.left + org.x : r.left;
            const int py = haveOrg ? r.top + org.y : r.top;
            RECT cur{};
            if (!(GetWindowRect(s->host.m_hWnd, &cur) && cur.left == px && cur.top == py &&
                  cur.right - cur.left == newW && cur.bottom - cur.top == newH)) {
              s->host.SetWindowPos(nullptr, px, py, newW, newH,
                                   SWP_NOACTIVATE | SWP_NOZORDER);
            }
          }
          if (s->owner) {
            s->host.SetWindowPos(s->owner, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
          }
        }
        break;
      }
      case CMD_SETVISIBLE: {
        bool v = false;
        bool has = false;
        {
          std::lock_guard<std::mutex> lk(pm_);
          auto it = visible_.find(id);
          if (it != visible_.end()) {
            v = it->second;
            visible_.erase(it);
            has = true;
          }
        }
        Session* s = Get(id);
        if (s && has && s->host.m_hWnd) {
          s->shown = v;
          ShowWindow(s->host.m_hWnd, v ? SW_SHOWNOACTIVATE : SW_HIDE);
        }
        break;
      }
      case CMD_UPDATE_DISPLAY: {
        // Debounce: resizing storms would otherwise push one resolution
        // negotiation per WM_SIZE into the control; it returns E_UNEXPECTED
        // while a previous one is still in flight.
        SetTimer(msgWnd_, TIMER_DISPLAY, DISPLAY_DEBOUNCE_MS, nullptr);
        break;
      }
      case CMD_DESTROY: {
        auto it = sessions_.find(id);
        if (it != sessions_.end()) {
          Teardown(it->second.get());
          sessions_.erase(it);
        }
        break;
      }
      case CMD_SHUTDOWN:
        PostQuitMessage(0);
        break;
    }
  }

  // Runs on the manager thread when the display debounce expires: push the
  // last queued resolution into every live session.
  void FlushPendingDisplay() {
    std::unordered_map<SessionId, std::pair<long, long>> disp;
    {
      std::lock_guard<std::mutex> lk(pm_);
      disp.swap(pendingDisp_);
    }
    for (const auto& kv : disp) {
      Session* s = Get(kv.first);
      if (!s || !s->ctrl) continue;
      if (!s->live) {
        // Not connected yet: UpdateSessionDisplaySettings is only valid for a
        // live session (the initial size went in via put_DesktopWidth/Height).
        // Put it back — the connected(2) event replays it instead of letting
        // the entry vanish (that used to pin the desktop at its initial size
        // until the next unrelated setBounds change).
        std::lock_guard<std::mutex> lk(pm_);
        pendingDisp_[kv.first] = kv.second;
        continue;
      }
      UpdateDisplayFor(s, kv.second.first, kv.second.second);
    }
  }

  // Single choke point for resolution pushes: skips no-op negotiations
  // (same size as the last successful push) so debounces from park/restore
  // or 1px layout jitter never reach the connection layer.
  void UpdateDisplayFor(Session* s, long w, long h) {
    if (!s->ctrl || w <= 0 || h <= 0) return;
    if (w == s->lastDispW && h == s->lastDispH) return;
    CComPtr<IMsRdpClient9> c9;
    if (SUCCEEDED(s->ctrl->QueryInterface(__uuidof(IMsRdpClient9), (void**)&c9)) && c9) {
      HRESULT hr = c9->raw_UpdateSessionDisplaySettings(
          (unsigned long)w, (unsigned long)h, (unsigned long)w, (unsigned long)h,
          0, 100, 100);
      if (SUCCEEDED(hr)) {
        s->lastDispW = w;
        s->lastDispH = h;
      }
      NativeTrace("[rdphost] UpdateSessionDisplaySettings(%ldx%ld) hr=0x%08lx%s",
                  w, h, (unsigned long)hr, SUCCEEDED(hr) ? "" : " (ignored)");
    }
  }

  // Replays a queued resolution for one session on its connected(2) event
  // (called from the event sink, which fires on this manager thread).
  void FlushPendingDisplayFor(SessionId id) {
    std::pair<long, long> d{};
    bool has = false;
    {
      std::lock_guard<std::mutex> lk(pm_);
      auto it = pendingDisp_.find(id);
      if (it != pendingDisp_.end()) {
        d = it->second;
        has = true;
      }
    }
    Session* s = Get(id);
    if (s && s->live && has) {
      UpdateDisplayFor(s, d.first, d.second);
    }
  }

  void DoCreate(CreateParams* p) {
    NativeTrace("[rdphost] DoCreate: enter (id=%u parent=%p params=%p done=%p thread=%lu)",
                (unsigned)p->id, (void*)p->parent, (void*)p, (void*)p->done,
                (unsigned long)GetCurrentThreadId());
    {
      // Pre-probe: which control coclass instantiates in this host?
      const struct { const wchar_t* name; CLSID clsid; } kCandidates[] = {
          { L"MsRdpClient12NotSafeForScripting", {0x3f859aa3, 0xc2d4, 0x4faa, {0xb0, 0xe4, 0xfd, 0x0c, 0x9c, 0x4e, 0x5e, 0x3a}} },
          { L"MsRdpClient12", {0x945ee98e, 0xb376, 0x4ec2, {0xb2, 0xe5, 0x64, 0xc9, 0x41, 0x0f, 0x93, 0xb7}} },
          { L"MsTscAx-v5(legacy)", {0x6ae29350, 0x321b, 0x42be, {0xbb, 0xe5, 0x12, 0xfb, 0x52, 0x70, 0xc0, 0xde}} },
      };
      for (const auto& c : kCandidates) {
        CComPtr<IDispatch> probe;
        HRESULT hr = CoCreateInstance(c.clsid, nullptr, CLSCTX_INPROC_SERVER,
                                      __uuidof(IDispatch), (void**)&probe);
        NativeTrace("[rdphost] probe %-36ls CoCreate=0x%08lx", c.name, (unsigned long)hr);
      }
    }
    auto s = std::make_unique<Session>();
    s->id = p->id;
    s->opt = p->opt;
    s->onEvent = std::move(p->onEvent);
    s->lastDispW = s->opt.width;   // the initial negotiation is put_DesktopWidth/
    s->lastDispH = s->opt.height;  // Height at create; UpdateDisplayFor skips
                                   // pushes that would repeat it

    // Chromium's presentation stack covers both sibling and child HWNDs, so
    // the RDP host lives as a top-level WS_POPUP that tracks the hole's screen
    // rect and stays glued directly above the Electron window in z-order.
    // The incoming rect is VIEWPORT-RELATIVE physical px: shift it by the
    // owner's real ClientToScreen origin (see CMD_SETBOUNDS for why Electron
    // DIP bounds cannot be trusted here).
    s->owner = p->parent;
    s->viewportRect = p->rect;  // viewport-relative, for glue-tick re-anchoring
    {
      POINT org{0, 0};
      if (s->owner && ClientToScreen(s->owner, &org)) {
        OffsetRect(&p->rect, org.x, org.y);
      }
    }
    NativeTrace("[rdphost] popup mode: owner=%p rect=(%ld,%ld %ldx%ld)",
                (void*)p->parent, p->rect.left, p->rect.top,
                p->rect.right - p->rect.left, p->rect.bottom - p->rect.top);

    // Use the versioned ProgID: the versionless "MsTscAx.MsTscAx" resolves to
    // the legacy RDP 5.x control (no IMsRdpClientAdvancedSettings2+, no
    // TLS/CredSSP in X.224). ".13" (MsRdpClient12*) fails machine-wide with
    // CLASS_E_CLASSNOTAVAILABLE on this build; ".12" works and still exposes
    // adv6+/IMsRdpClient9 (CredSSP, TLS, live resize).
    // WS_POPUP + hWndParent == owned popup: Windows keeps owned windows above
    // their owner (the non-activate z-raise rules would otherwise pin us
    // below the foreground window), hides them with the owner's minimize, and
    // coordinates stay screen-relative.
    HWND h = s->host.Create(p->parent, &p->rect, L"MsTscAx.MsTscAx.12",
                            WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN,
                            WS_EX_TOOLWINDOW, 0U, nullptr);
    if (!h) {
      NativeTrace("[rdphost] AtlAxWin container create failed (parent=%p gle=%lu)",
                  (void*)p->parent, GetLastError());
      SetEvent(p->done);
      return;
    }
    NativeTrace("[rdphost] AtlAxWin container created hwnd=%p", (void*)h);
    s->lastSizeApply = GetTickCount64();  // the create rect's size is applied
    HRESULT qhr = s->host.QueryControl(__uuidof(IMsTscAx), (void**)&s->ctrl);
    if (FAILED(qhr) || !s->ctrl) {
      NativeTrace("[rdphost] QueryControl(IMsTscAx) failed hr=0x%08lx", (unsigned long)qhr);
      s->host.DestroyWindow();
      SetEvent(p->done);
      return;
    }
    {
      // Interface ladder: which control generation did we actually get?
      const struct { const wchar_t* n; IID iid; } kLadder[] = {
          { L"IMsRdpClient", __uuidof(IMsRdpClient) },
          { L"IMsRdpClient2", __uuidof(IMsRdpClient2) },
          { L"IMsRdpClient9", __uuidof(IMsRdpClient9) },
          { L"IMsRdpClient10", __uuidof(IMsRdpClient10) },
          { L"IMsRdpClientAdvancedSettings6", __uuidof(IMsRdpClientAdvancedSettings6) },
      };
      for (const auto& e : kLadder) {
        void* pv = nullptr;
        HRESULT hr = s->ctrl->QueryInterface(e.iid, &pv);
        if (pv) ((IUnknown*)pv)->Release();
        NativeTrace("[rdphost] QI %-32ls = 0x%08lx", e.n, (unsigned long)hr);
      }
      CLSID clsid{};
      HRESULT hrp = CLSIDFromProgID(L"MsTscAx.MsTscAx.12", &clsid);
      NativeTrace("[rdphost] CLSIDFromProgID(.12) = 0x%08lx", (unsigned long)hrp);
    }

    // Basic connection settings. Property accessors (put_*) are raw vtable
    // methods that return HRESULT; only #import method wrappers (Connect,
    // Disconnect, UpdateSessionDisplaySettings) throw _com_error on failure,
    // and those are called via their raw_ variants elsewhere.
    HRESULT hrSrv = s->ctrl->put_Server(CComBSTR(s->opt.server.c_str()));
    if (!s->opt.username.empty())
      s->ctrl->put_UserName(CComBSTR(s->opt.username.c_str()));
    if (!s->opt.domain.empty())
      s->ctrl->put_Domain(CComBSTR(s->opt.domain.c_str()));
    if (!s->opt.password.empty()) {
      // PoC probe only — auto-login to verify the full session path.
      CComPtr<IMsTscNonScriptable> ns;
      HRESULT hrn = s->ctrl->QueryInterface(__uuidof(IMsTscNonScriptable), (void**)&ns);
      HRESULT hrp = E_NOINTERFACE;
      if (SUCCEEDED(hrn) && ns) {
        hrp = ns->put_ClearTextPassword(CComBSTR(s->opt.password.c_str()));
      }
      NativeTrace("[rdphost] password: QI=0x%08lx put=0x%08lx len=%zu",
                  (unsigned long)hrn, (unsigned long)hrp, s->opt.password.size());
    }
    s->ctrl->put_DesktopWidth(s->opt.width);
    s->ctrl->put_DesktopHeight(s->opt.height);
    if (FAILED(hrSrv)) {
      NativeTrace("[rdphost] raw_put_Server hr=0x%08lx", (unsigned long)hrSrv);
    }

    // Advanced settings: the AdvancedSettings* sub-objects are not reachable
    // from the control via QI, and the raw getter chain in the typelib stops
    // below the interface versions that own RDPPort/EnableCredSspSupport. The
    // IDispatch property path works (verified from PowerShell): fetch the
    // "AdvancedSettings7" sub-object, then QI its dual interfaces and call the
    // raw vtable methods.
    {
      CComPtr<IDispatch> disp;
      HRESULT hrD = s->ctrl->QueryInterface(IID_IDispatch, (void**)&disp);
      HRESULT hrN = E_FAIL, hrPort = E_FAIL, hrP = E_FAIL;
      if (SUCCEEDED(hrD) && disp) {
        DISPID did = DISPID_UNKNOWN;
        {
          LPOLESTR names[] = {const_cast<LPOLESTR>(L"AdvancedSettings7")};
          hrN = disp->GetIDsOfNames(IID_NULL, names, 1, LOCALE_USER_DEFAULT, &did);
        }
        if (SUCCEEDED(hrN)) {
          DISPPARAMS dpNo{nullptr, nullptr, 0, 0};
          CComVariant vAdv;
          if (SUCCEEDED(disp->Invoke(did, IID_NULL, LOCALE_USER_DEFAULT,
                                     DISPATCH_PROPERTYGET, &dpNo, &vAdv, nullptr, nullptr)) &&
              vAdv.vt == VT_DISPATCH && vAdv.pdispVal) {
            // The sub-object (unlike the control itself) exposes its dual
            // interfaces via QI — call the raw vtable methods directly.
            if (s->opt.port != 3389) {
              CComPtr<IMsRdpClientAdvancedSettings2> adv2;
              if (SUCCEEDED(vAdv.pdispVal->QueryInterface(__uuidof(IMsRdpClientAdvancedSettings2), (void**)&adv2)) && adv2) {
                hrPort = adv2->put_RDPPort(static_cast<long>(s->opt.port));
              }
            } else {
              hrPort = S_OK;  // default port, nothing to set
            }
            // EnableCredSspSupport is always set (not just when true): with it
            // ON and the server unable to negotiate NLA, mstscax downgrades
            // to TLS but keeps the credentials reserved for the CredSSP
            // layer — they are never sent in the Client Info PDU, so non-NLA
            // servers (xrdp 0.9 packages built without CredSSP) always show
            // their logon screen. With it OFF, mstscax takes the legacy path
            // and the credentials ride the Client Info PDU — which those
            // servers honor with a direct login.
            {
              CComPtr<IMsRdpClientAdvancedSettings6> adv6;
              HRESULT hrQ = vAdv.pdispVal->QueryInterface(__uuidof(IMsRdpClientAdvancedSettings6), (void**)&adv6);
              if (SUCCEEDED(hrQ) && adv6) {
                hrP = adv6->put_EnableCredSspSupport(
                    s->opt.enableCredSsp ? VARIANT_TRUE : VARIANT_FALSE);
              } else {
                hrP = hrQ;
              }
            }
            // SmartSizing: scale the remote desktop to fit the popup's client
            // area whenever the negotiated size disagrees with it. Targets
            // that ignore dynamic resolution changes (xrdp's Xvnc backend)
            // otherwise leave a smaller desktop glued to the top-left corner
            // with empty desktop background around it, and never show
            // scrollbars. When the sizes match — full live-resize targets —
            // the scaling is 1:1 and quality is unaffected.
            CComPtr<IMsRdpClientAdvancedSettings> adv1;
            if (SUCCEEDED(vAdv.pdispVal->QueryInterface(__uuidof(IMsRdpClientAdvancedSettings), (void**)&adv1)) && adv1) {
              HRESULT hrSs = adv1->put_SmartSizing(VARIANT_TRUE);
              NativeTrace("[rdphost] SmartSizing hr=0x%08lx", (unsigned long)hrSs);
            }
          }
        }
      }
      NativeTrace("[rdphost] advSettings(dispatch): QI=0x%08lx name=0x%08lx port=0x%08lx credSsp=0x%08lx credSspVal=%d userLen=%zu",
                  (unsigned long)hrD, (unsigned long)hrN, (unsigned long)hrPort, (unsigned long)hrP,
                  (int)s->opt.enableCredSsp, s->opt.username.size());
    }

    // Advise the event sink.
    CComPtr<IConnectionPointContainer> cpc;
    HRESULT hrCpc = s->ctrl->QueryInterface(__uuidof(IConnectionPointContainer), (void**)&cpc);
    HRESULT hrFcp = cpc ? cpc->FindConnectionPoint(__uuidof(IMsTscAxEvents), &s->cp) : E_NOINTERFACE;
    NativeTrace("[rdphost] connection point: QI(cpc)=0x%08lx FindCP=0x%08lx cp=%p",
                (unsigned long)hrCpc, (unsigned long)hrFcp, (void*)s->cp.p);
    bool advised = false;
    if (SUCCEEDED(hrFcp) && s->cp) {
      if (SUCCEEDED(CComObject<EventSink>::CreateInstance(&s->sink)) && s->sink) {
        s->sink->AddRef();
        s->sink->sid = s->id;
        s->sink->cb = &s->onEvent;
        s->sink->sess = s.get();
        HRESULT hrAdv = s->cp->Advise(s->sink, &s->cookie);
        NativeTrace("[rdphost] Advise hr=0x%08lx cookie=%lu", (unsigned long)hrAdv, (unsigned long)s->cookie);
        if (SUCCEEDED(hrAdv)) {
          advised = true;
        } else {
          s->sink->Release();
          s->sink = nullptr;
          s->cp = nullptr;
        }
      }
    }
    if (!advised) NativeTrace("[rdphost] WARNING: event sink not advised");

    // Sit directly above the Electron window from the start.
    if (s->owner) {
      s->host.SetWindowPos(s->owner, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    }
    // Owner tracking: WinEvents give us every owner move/resize step (the
    // JS viewport-relative rect is blind to window moves by construction).
    TryInstallWinEventHook();
    NativeTrace("[rdphost] DoCreate: settings+sink done, storing session");
    sessions_[s->id] = std::move(s);
    p->ok = true;
    const BOOL setOk = SetEvent(p->done);
    NativeTrace("[rdphost] DoCreate: complete (SetEvent(%p)=%d gle=%lu)",
                (void*)p->done, (int)setOk, GetLastError());
    if (!setOk) {
      // The waiter will time out; also signal via the message queue so it can
      // wake immediately when the event object misbehaves in this host.
      if (msgWnd_) PostMessageW(msgWnd_, WM_APP + 0x131, 0, 0);
    }
  }

  void Teardown(Session* s) {
    if (!s) return;
    s->live = false;
    if (s->cp && s->cookie && s->sink) {
      s->cp->Unadvise(s->cookie);
      s->sink->Release();
      s->sink = nullptr;
      s->cookie = 0;
    }
    if (s->ctrl) s->ctrl->raw_Disconnect();
    s->ctrl = nullptr;
    s->cp = nullptr;
    if (s->host.m_hWnd) s->host.DestroyWindow();
  }

  std::mutex lifeMtx_;
  std::thread thread_;
  HANDLE readyEvent_ = nullptr;
  HANDLE stoppedEvent_ = nullptr;
  std::atomic_bool ready_{false};
  HWND msgWnd_ = nullptr;
  std::atomic<SessionId> nextId_{0};
  std::unordered_map<SessionId, std::unique_ptr<Session>> sessions_;  // manager thread only
  std::mutex pm_;
  std::unordered_map<SessionId, RECT> pendingBounds_;
  std::unordered_map<SessionId, std::pair<long, long>> pendingDisp_;
  std::unordered_map<SessionId, bool> visible_;
  // Tracks owner-window moves for immediate re-anchoring (installed on first
  // create; WINEVENT_OUTOFCONTEXT callbacks are dispatched by this thread's
  // message loop, so sessions_ access stays single-threaded).
  HWINEVENTHOOK winEventHook_ = nullptr;
};

void ReplayPendingDisplayOnConnected(SessionId id) {
  Manager::Inst().FlushPendingDisplayForPublic(id);
}

LRESULT CALLBACK MgrWndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_CMD) {
    Manager::Inst().HandleCmdPublic(static_cast<UINT_PTR>(wp), lp);
    return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

void CALLBACK WinEventProc(HWINEVENTHOOK, DWORD event, HWND hwnd, LONG idObject,
                           LONG, DWORD, DWORD) {
  // idChild==0 + OBJID_WINDOW: the top-level window itself moved/resized,
  // not one of its internal child objects.
  if (event == EVENT_OBJECT_LOCATIONCHANGE && idObject == OBJID_WINDOW &&
      hwnd != nullptr) {
    Manager::Inst().ReanchorForOwnerPublic(hwnd);
  }
}

}  // namespace

const char* EventName(int dispid) {
  // 1-based ordinal mapping of IMsTscAxEvents, verified against the
  // generated mstscax.tlh and runtime observations (4=disconnect reason,
  // 12=desktop size change).
  switch (dispid) {
    case 1:  return "connecting";
    case 2:  return "connected";
    case 3:  return "loginComplete";
    case 4:  return "disconnected";
    case 5:  return "enterFullScreen";
    case 6:  return "leaveFullScreen";
    case 7:  return "channelReceivedData";
    case 8:  return "requestGoFullScreen";
    case 9:  return "requestLeaveFullScreen";
    case 10: return "fatalError";
    case 11: return "warning";
    case 12: return "desktopSizeChange";
    case 13: return "idleTimeout";
    case 14: return "requestContainerMinimize";
    case 16: return "receivedTSPublicKey";
    case 17: return "autoReconnecting";
    case 18: return "authWarningDisplayed";
    case 19: return "authWarningDismissed";
    case 20: return "remoteProgramResult";
    case 21: return "remoteProgramDisplayed";
    case 22: return "remoteWindowDisplayed";
    case 23: return "logonError";
    case 24: return "focusReleased";
    case 25: return "userNameAcquired";
    case 26: return "mouseInputModeChanged";
    case 27: return "serviceMessageReceived";
    case 28: return "connectionBarPullDown";
    case 29: return "networkStatusChanged";
    case 30: return "devicesButtonPressed";
    case 31: return "autoReconnected";
    case 32: return "autoReconnecting2";
    default: {
      static thread_local char buf[32];
      snprintf(buf, sizeof(buf), "event_%d", dispid);
      return buf;
    }
  }
}

bool StartManager() { return Manager::Inst().Start(); }
void ShutdownManager() { Manager::Inst().Stop(); }

SessionId CreateSession(HWND parent, const RECT& rect, const SessionOptions& opt,
                        EventCb onEvent, bool* ok) {
  return Manager::Inst().Create(parent, rect, opt, std::move(onEvent), ok);
}
bool SessionConnect(SessionId id) { return Manager::Inst().Post(CMD_CONNECT, id); }
bool SessionDisconnect(SessionId id) { return Manager::Inst().Post(CMD_DISCONNECT, id); }
bool SessionSetBounds(SessionId id, const RECT& r) {
  Manager::Inst().QueueBounds(id, r);
  return Manager::Inst().Post(CMD_SETBOUNDS, id);
}
bool SessionSetVisible(SessionId id, bool visible) {
  Manager::Inst().SetVisible(id, visible);
  return true;
}
bool SessionUpdateDisplay(SessionId id, long w, long h) {
  Manager::Inst().QueueDisplay(id, w, h);
  return Manager::Inst().Post(CMD_UPDATE_DISPLAY, id);
}
bool SessionDestroy(SessionId id) { return Manager::Inst().Post(CMD_DESTROY, id); }

}  // namespace rdphost
