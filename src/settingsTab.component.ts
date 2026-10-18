import { Component, OnInit } from '@angular/core'

import { ArcTranslator } from './i18n'
import * as native from './nativeBridge'

/** @hidden */
@Component({
    template: require('./settingsTab.component.pug'),
})
export class ActivxRdpSettingsTabComponent implements OnInit {
    diag: native.NativeDiagnostics | null = null
    addonPath = ''

    constructor (public i18n: ArcTranslator) {
        this.diag = native.diagnostics()
        this.addonPath = native.addonPathForDisplay()
    }

    /** Template hook; subscribing to localeChanged$ inside the Zone makes a
     * language switch re-render the tab. */
    t (key: string, params?: Record<string, string>): string {
        return this.i18n.t(key, params)
    }

    ngOnInit (): void {
        this.i18n.localeChanged$.subscribe(() => { /* zone-side effect: re-render */ })
    }
}
