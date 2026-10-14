// rdp_host.h — shared core for hosting the system RDP ActiveX (MsTscAx)
// Used by both the N-API addon (Electron main process) and the standalone
// diagnostic exe (S1 probe). All COM work happens on a dedicated STA worker
// thread owned by the manager; public API is thread-safe (commands are
// marshalled to that thread via window messages).
#pragma once

#include <cstdint>
#include <functional>
#include <string>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace rdphost {

using SessionId = uint32_t;

// Called on the manager STA thread when the control fires IMsTscAxEvents.
using EventCb = std::function<void(SessionId id, int dispid, int64_t a, int64_t b)>;

struct SessionOptions {
  std::wstring server;
  uint16_t port = 3389;
  std::wstring username;   // optional, leave empty for the control's own logon UI
  std::wstring password;   // optional, PoC probe only (ClearTextPassword)
  std::wstring domain;     // optional
  long width = 1024;       // initial desktop size (physical px)
  long height = 768;
  bool enableCredSsp = true;  // NLA / CredSSP support. Disable for servers
                              // without NLA (xrdp 0.9 packages built without
                              // CredSSP): with CredSSP ON and NLA unavailable,
                              // mstscax downgrades but never sends the
                              // credentials in the Client Info PDU, so those
                              // servers always show their logon screen. With
                              // it OFF the legacy path auto-logs in.
};

// Best-effort name for a known IMsTscAxEvents dispid; "event_<n>" otherwise.
const char* EventName(int dispid);

bool StartManager();
void ShutdownManager();

// Creates the ActiveX host window as a child of `parent` at `rect` (client
// coordinates of `parent`, physical px). Blocks until the manager thread has
// finished creating the control. Returns 0 and *ok=false on failure.
SessionId CreateSession(HWND parent, const RECT& rect, const SessionOptions& opt,
                        EventCb onEvent, bool* ok);

bool SessionConnect(SessionId id);
bool SessionDisconnect(SessionId id);
bool SessionSetBounds(SessionId id, const RECT& rect);
// Visibility intent from JS (tab activation, overlay yielding): a real
// SW_HIDE/SW_SHOWNOACTIVATE on the popup, not a coordinate park — parking by
// coordinates used to arm the display debounce and re-negotiate the remote
// resolution to the sentinel size on every tab switch.
bool SessionSetVisible(SessionId id, bool visible);
// Live resize without reconnect (IMsRdpClient9::UpdateSessionDisplaySettings).
bool SessionUpdateDisplay(SessionId id, long width, long height);
bool SessionDestroy(SessionId id);

}  // namespace rdphost
