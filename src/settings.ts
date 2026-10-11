import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { ActivxRdpSettingsTabComponent } from './settingsTab.component'

/** @hidden */
@Injectable()
export class ActivxRdpSettingsTabProvider extends SettingsTabProvider {
    id = 'activx-rdp-client'
    icon = 'desktop'
    // Field, not an accessor: the base class declares `title` as a property
    // and TS forbids the override kind change (the accessor trick needs a
    // hand-written declarations.d.ts — not worth it for a fixed string).
    title = 'ActiveX RDP'

    getComponentType (): any {
        return ActivxRdpSettingsTabComponent
    }
}
