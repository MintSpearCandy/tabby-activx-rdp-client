/**
 * @hidden
 * Plugin translations. Same approach as BetterConfiger (proven in this
 * Tabby line): @ngx-translate/core is NOT importable from a user plugin
 * (only builtin plugins resolve it — importing it takes the whole plugin,
 * and every user plugin after it, down), so we keep our own table keyed by
 * the locale from tabby-core's LocaleService. Components expose t() and the
 * template calls it; language switches re-render via Zone-triggered change
 * detection from the localeChanged$ subscription.
 */
import { Injectable } from '@angular/core'
import { LocaleService } from 'tabby-core'

const TRANSLATIONS: Record<string, Record<string, string>> = {
    en: {
        // Settings tab
        'arc.settings.about.title': 'About',
        'arc.settings.about.desc': 'RDP desktops rendered by the system ActiveX control (mstscax.dll). The connection — TLS, CredSSP, the socket — is made end-to-end by the Microsoft-signed RDP stack; the plugin\'s native code never touches the network.',
        'arc.settings.bridge.ok': 'Loaded and operational.',
        'arc.settings.bridge.bad': 'Native bridge problem',
        'arc.settings.addon.title': 'Addon binary',
        'arc.settings.addon.desc': '{path} — rebuild with `npm run build:native` in the plugin checkout.',
        'arc.settings.passwords.title': 'Passwords',
        'arc.settings.passwords.desc': 'Enable Tabby\'s Vault (Settings › Vault) to keep RDP passwords encrypted; without it they are stored in plain text in config.yaml.',
        'arc.settings.keyboard.title': 'Keyboard',
        'arc.settings.keyboard.desc': 'While the RDP desktop has focus, all keys go to the remote session and Tabby\'s own hotkeys do not fire. Bind and use "RDP: disconnect" / "RDP: reconnect" in Settings › Hotkeys — global shortcuts keep working regardless of focus.',

        // Profile settings form
        'arc.profile.host.title': 'Host',
        'arc.profile.host.desc': 'Remote host (Windows RDP server, or an xrdp host on Linux)',
        'arc.profile.port.title': 'Port',
        'arc.profile.port.desc': 'RDP port (3389 unless redirected)',
        'arc.profile.username.title': 'Username',
        'arc.profile.username.desc': 'Leave empty to use the control\'s own logon UI',
        'arc.profile.domain.title': 'Domain',
        'arc.profile.domain.desc': 'Optional (Windows accounts only)',
        'arc.profile.password.title': 'Password',
        'arc.profile.password.storage': 'Stored in {store}',
        'arc.profile.password.placeholder': '(not set)',
        'arc.profile.size.title': 'Initial desktop size',
        'arc.profile.size.desc': '0 × 0 = follow the pane size at connect time',
        'arc.profile.size.width': 'width',
        'arc.profile.size.height': 'height',
        'arc.profile.credssp.title': 'NLA / CredSSP',
        'arc.profile.credssp.desc': 'Turn off for servers without NLA (e.g. xrdp) — the stored username and password then log in automatically instead of the server showing its own logon screen',

        // Connection gate
        'arc.gate.host': 'Host',
        'arc.gate.port': 'Port',
        'arc.gate.username': 'Username',
        'arc.gate.password': 'Password',
        'arc.gate.connect': 'Connect',
        'arc.gate.connecting': 'Connecting…',
        'arc.gate.retry': 'Retry',
        'arc.gate.reconnect': 'Reconnect',
        'arc.gate.enterHost': 'enter a host to connect',
        'arc.gate.noHost': 'no host configured — open the profile settings and set one',

        // States / diagnostics
        'arc.state.idle': 'idle',
        'arc.state.connecting': 'connecting',
        'arc.state.connected': 'connected',
        'arc.state.disconnected': 'disconnected',
        'arc.state.error': 'error',
        'arc.diag.title': 'ActiveX RDP bridge unavailable',
        'arc.diag.stay': 'The tab stays open; nothing will crash.',
    },
    zh: {
        // 设置页
        'arc.settings.about.title': '关于',
        'arc.settings.about.desc': '由系统 ActiveX 控件（mstscax.dll）渲染的 RDP 桌面。连接——TLS、CredSSP、套接字——全部由微软签名的 RDP 协议栈端到端完成；插件的原生代码不经手任何网络流量。',
        'arc.settings.bridge.ok': '已加载并正常工作。',
        'arc.settings.bridge.bad': '原生桥接异常',
        'arc.settings.addon.title': '插件二进制',
        'arc.settings.addon.desc': '{path} —— 在插件源码目录运行 `npm run build:native` 重新构建。',
        'arc.settings.passwords.title': '密码',
        'arc.settings.passwords.desc': '启用 Tabby 的保险库（设置 › 保险库）可加密保存 RDP 密码；否则将以明文存储在 config.yaml 中。',
        'arc.settings.keyboard.title': '键盘',
        'arc.settings.keyboard.desc': 'RDP 桌面获得焦点时，所有按键发往远程会话，Tabby 自身热键不生效。请在 设置 › 热键 绑定并使用「RDP: disconnect」/「RDP: reconnect」——全局快捷键不受焦点影响。',

        // 连接配置表单
        'arc.profile.host.title': '主机',
        'arc.profile.host.desc': '远程主机（Windows RDP 服务器，或 Linux 上的 xrdp 主机）',
        'arc.profile.port.title': '端口',
        'arc.profile.port.desc': 'RDP 端口（未重定向时为 3389）',
        'arc.profile.username.title': '用户名',
        'arc.profile.username.desc': '留空则使用控件自身的登录界面',
        'arc.profile.domain.title': '域',
        'arc.profile.domain.desc': '可选（仅 Windows 账户）',
        'arc.profile.password.title': '密码',
        'arc.profile.password.storage': '保存于 {store}',
        'arc.profile.password.placeholder': '（未设置）',
        'arc.profile.size.title': '初始桌面分辨率',
        'arc.profile.size.desc': '0 × 0 = 连接时跟随窗格尺寸',
        'arc.profile.size.width': '宽',
        'arc.profile.size.height': '高',
        'arc.profile.credssp.title': 'NLA / CredSSP',
        'arc.profile.credssp.desc': '对不支持 NLA 的服务器（如 xrdp）请关闭——已保存的用户名和密码将自动登录，而不会弹出服务器自己的登录界面',

        // 连接门
        'arc.gate.host': '主机',
        'arc.gate.port': '端口',
        'arc.gate.username': '用户名',
        'arc.gate.password': '密码',
        'arc.gate.connect': '连接',
        'arc.gate.connecting': '连接中…',
        'arc.gate.retry': '重试',
        'arc.gate.reconnect': '重新连接',
        'arc.gate.enterHost': '请输入主机地址',
        'arc.gate.noHost': '未配置主机——请打开连接配置进行设置',

        // 状态 / 诊断
        'arc.state.idle': '空闲',
        'arc.state.connecting': '连接中',
        'arc.state.connected': '已连接',
        'arc.state.disconnected': '已断开',
        'arc.state.error': '错误',
        'arc.diag.title': 'ActiveX RDP 桥接不可用',
        'arc.diag.stay': '标签页保持打开，不会崩溃。',
    },
}

/** Locale normalization: zh-CN/zh-TW/zh-Hans → zh; anything unknown → en. */
function tableFor (locale: string | null | undefined): Record<string, string> {
    if (locale && locale.toLowerCase().startsWith('zh')) {
        return TRANSLATIONS['zh']
    }
    return TRANSLATIONS['en']
}

/** Standalone lookup for non-DI contexts. */
export function translateText (locale: string | null | undefined, key: string): string {
    return tableFor(locale)[key] ?? TRANSLATIONS['en'][key] ?? key
}

@Injectable({ providedIn: 'root' })
export class ArcTranslator {
    constructor (private localeService: LocaleService) { }

    /** Translate a key; `{param}` placeholders expand from `params`. */
    t (key: string, params?: Record<string, string>): string {
        let s = translateText(this.localeService.getLocale(), key)
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                s = s.split(`{${k}}`).join(v)
            }
        }
        return s
    }

    get localeChanged$ () {
        return this.localeService.localeChanged$
    }
}
