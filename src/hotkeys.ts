import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'

import { PLUGIN_ID } from './api'

/** @hidden */
@Injectable()
export class ActivxRdpHotkeyProvider extends HotkeyProvider {
    async provide (): Promise<HotkeyDescription[]> {
        return [
            { id: `${PLUGIN_ID}:disconnect`, name: 'RDP: disconnect' },
            { id: `${PLUGIN_ID}:reconnect`, name: 'RDP: reconnect' },
        ]
    }
}
