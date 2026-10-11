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
  bool enableCredSsp = true;  // NLA / CredSSP support (required by modern servers)
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
// Live resize without reconnect (IMsRdpClient9::UpdateSessionDisplaySettings).
bool SessionUpdateDisplay(SessionId id, long width, long height);
bool SessionDestroy(SessionId id);

}  // namespace rdphost
