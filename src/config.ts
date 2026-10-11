import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'

import { PLUGIN_ID } from './api'

/** @hidden */
@Injectable()
export class ActivxRdpConfigProvider extends ConfigProvider {
    defaults = {
        options: {
            host: '',
            port: 3389,
            username: '',
            password: '',
            domain: '',
            width: 0,
            height: 0,
        },
        // Hotkey defaults MUST be declared here (even as empty arrays):
        // a hotkeys.<plugin>.* subtree absent from defaults is dropped by
        // Tabby's ConfigProxy on save/load, silently losing user bindings.
        hotkeys: {
            [`${PLUGIN_ID}:toggle-focus`]: [],
            [`${PLUGIN_ID}:disconnect`]: [],
        },
    }
}
