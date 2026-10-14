// addon.cc — Node-API bindings for rdphost (loaded in the Electron main
// process). Renderer never touches this module; it talks over IPC.

#include <napi.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>

#include "rdp_host.h"

namespace {

std::mutex g_tsfnMtx;
Napi::ThreadSafeFunction g_tsfn;
std::atomic_bool g_tsfn_ok{false};
std::atomic_bool g_shutdown_done{false};

struct EvData {
  rdphost::SessionId id;
  int dispid;
  int64_t a;
  int64_t b;
};

void EmitEvent(rdphost::SessionId id, int dispid, int64_t a, int64_t b) {
  auto cb = [](Napi::Env env, Napi::Function js, EvData* d) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("id", Napi::Number::New(env, static_cast<double>(d->id)));
    o.Set("dispid", Napi::Number::New(env, d->dispid));
    o.Set("name", Napi::String::New(env, rdphost::EventName(d->dispid)));
    o.Set("a", Napi::Number::New(env, static_cast<double>(d->a)));
    o.Set("b", Napi::Number::New(env, static_cast<double>(d->b)));
    js.Call({o});
    delete d;
  };

  std::lock_guard<std::mutex> lk(g_tsfnMtx);
  if (!g_tsfn_ok.load()) return;
  g_tsfn.BlockingCall(new EvData{id, dispid, a, b}, cb);
}

void ShutdownNow() {
  bool expected = false;
  if (g_shutdown_done.compare_exchange_strong(expected, true)) {
    {
      std::lock_guard<std::mutex> lk(g_tsfnMtx);
      if (g_tsfn_ok.exchange(false)) g_tsfn.Release();
    }
    rdphost::ShutdownManager();
  }
}

std::wstring ToW(const Napi::Object& o, const char* key) {
  Napi::Value v = o.Get(key);
  if (!v.IsString()) return std::wstring();
  std::u16string u = v.As<Napi::String>().Utf16Value();
  return std::wstring(reinterpret_cast<const wchar_t*>(u.data()), u.size());
}

int32_t Num(const Napi::Object& o, const char* key, int32_t def) {
  Napi::Value v = o.Get(key);
  return v.IsNumber() ? v.As<Napi::Number>().Int32Value() : def;
}

rdphost::SessionId IdArg(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsNumber()) return 0;
  return static_cast<rdphost::SessionId>(info[0].As<Napi::Number>().Uint32Value());
}

Napi::Value Create(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "create(options) expected").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object o = info[0].As<Napi::Object>();

  auto hwndBuf = o.Get("hwnd").As<Napi::Buffer<unsigned char>>();
  if (hwndBuf.IsEmpty() || hwndBuf.Length() < sizeof(void*)) {
    Napi::TypeError::New(env, "options.hwnd must be a native window handle buffer")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  HWND hwnd{};
  memcpy(&hwnd, hwndBuf.Data(), sizeof(hwnd));

  const long x = Num(o, "x", 0);
  const long y = Num(o, "y", 0);
  const long w = Num(o, "w", 640);
  const long h = Num(o, "h", 480);
  if (w < 64 || h < 64 || w > 8192 || h > 8192) {
    Napi::RangeError::New(env, "hole rect out of range").ThrowAsJavaScriptException();
    return env.Null();
  }

  rdphost::SessionOptions opt;
  opt.server = ToW(o, "server");
  opt.port = static_cast<uint16_t>(Num(o, "port", 3389));
  opt.username = ToW(o, "username");
  opt.password = ToW(o, "password");
  opt.domain = ToW(o, "domain");
  opt.width = Num(o, "width", w);
  opt.height = Num(o, "height", h);
  {
    Napi::Value v = o.Get("enableCredSsp");
    if (v.IsBoolean()) opt.enableCredSsp = v.As<Napi::Boolean>().Value();
  }
  if (opt.server.empty()) {
    Napi::TypeError::New(env, "options.server required").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!rdphost::StartManager()) {
    Napi::Error::New(env, "manager thread failed to start").ThrowAsJavaScriptException();
    return env.Null();
  }

  const RECT rect{x, y, x + w, y + h};
  bool ok = false;
  const rdphost::SessionId id =
      rdphost::CreateSession(hwnd, rect, opt,
                             [](rdphost::SessionId sid, int dispid, int64_t a, int64_t b) {
                               EmitEvent(sid, dispid, a, b);
                             },
                             &ok);
  if (!ok) {
    Napi::Error::New(env, "CreateSession failed (see stdout log)").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Number::New(env, static_cast<double>(id));
}

Napi::Value SetEventHandler(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "setEventHandler(fn) expected").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::lock_guard<std::mutex> lk(g_tsfnMtx);
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "rdpEvent", 0, 1);
  g_tsfn_ok = true;
  return env.Undefined();
}

Napi::Value Connect(const Napi::CallbackInfo& info) {
  const rdphost::SessionId id = IdArg(info);
  return Napi::Boolean::New(info.Env(), id != 0 && rdphost::SessionConnect(id));
}

Napi::Value Disconnect(const Napi::CallbackInfo& info) {
  const rdphost::SessionId id = IdArg(info);
  return Napi::Boolean::New(info.Env(), id != 0 && rdphost::SessionDisconnect(id));
}

Napi::Value Destroy(const Napi::CallbackInfo& info) {
  const rdphost::SessionId id = IdArg(info);
  return Napi::Boolean::New(info.Env(), id == 0 || rdphost::SessionDestroy(id));
}

Napi::Value SetBounds(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5) {
    Napi::TypeError::New(env, "setBounds(id,x,y,w,h) expected").ThrowAsJavaScriptException();
    return env.Null();
  }
  const rdphost::SessionId id = IdArg(info);
  const long x = info[1].As<Napi::Number>().Int32Value();
  const long y = info[2].As<Napi::Number>().Int32Value();
  const long w = info[3].As<Napi::Number>().Int32Value();
  const long h = info[4].As<Napi::Number>().Int32Value();
  const RECT r{x, y, x + w, y + h};
  return Napi::Boolean::New(env, id != 0 && rdphost::SessionSetBounds(id, r));
}

Napi::Value UpdateDisplay(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "updateDisplay(id,w,h) expected").ThrowAsJavaScriptException();
    return env.Null();
  }
  const rdphost::SessionId id = IdArg(info);
  const long w = info[1].As<Napi::Number>().Int32Value();
  const long h = info[2].As<Napi::Number>().Int32Value();
  return Napi::Boolean::New(env, id != 0 && rdphost::SessionUpdateDisplay(id, w, h));
}

Napi::Value SetVisible(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[1].IsBoolean()) {
    Napi::TypeError::New(env, "setVisible(id,boolean) expected").ThrowAsJavaScriptException();
    return env.Null();
  }
  const rdphost::SessionId id = IdArg(info);
  return Napi::Boolean::New(env, id != 0 && rdphost::SessionSetVisible(id, info[1].As<Napi::Boolean>().Value()));
}

Napi::Value Shutdown(const Napi::CallbackInfo& info) {
  ShutdownNow();
  return info.Env().Undefined();
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  env.AddCleanupHook([] { ShutdownNow(); });
  exports.Set("create", Napi::Function::New(env, Create));
  exports.Set("setEventHandler", Napi::Function::New(env, SetEventHandler));
  exports.Set("connect", Napi::Function::New(env, Connect));
  exports.Set("disconnect", Napi::Function::New(env, Disconnect));
  exports.Set("destroy", Napi::Function::New(env, Destroy));
  exports.Set("setBounds", Napi::Function::New(env, SetBounds));
  exports.Set("setVisible", Napi::Function::New(env, SetVisible));
  exports.Set("updateDisplay", Napi::Function::New(env, UpdateDisplay));
  exports.Set("shutdown", Napi::Function::New(env, Shutdown));
  return exports;
}

NODE_API_MODULE(rdp_host, InitAll)

}  // namespace
