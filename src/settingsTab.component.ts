import { Component } from '@angular/core'

import * as native from './nativeBridge'

/** @hidden */
@Component({
    template: require('./settingsTab.component.pug'),
})
export class ActivxRdpSettingsTabComponent {
    diag: native.NativeDiagnostics | null = null
    addonPath = ''

    constructor () {
        this.diag = native.diagnostics()
        this.addonPath = native.addonPathForDisplay()
    }
}
