import { Component } from '@angular/core'

import { RdpProfile } from './api'
import { RdpCredentialsService } from './credentials'
import { ArcTranslator } from './i18n'

/** @hidden */
@Component({
    template: require('./profileSettings.component.pug'),
})
export class RdpProfileSettingsComponent {
    // Injected by tabby-settings as a ConfigProxy over the profile
    profile: RdpProfile

    /** The password field: bound to the service, not to options directly. */
    passwordValue = ''
    passwordLoaded = false

    constructor (
        private credentials: RdpCredentialsService,
        public i18n: ArcTranslator,
    ) {}

    /** Template hook; the localeChanged$ subscription keeps the form
     * re-rendering on language switches. */
    t (key: string, params?: Record<string, string>): string {
        return this.i18n.t(key, params)
    }

    ngOnInit (): void {
        this.i18n.localeChanged$.subscribe(() => { /* zone-side effect: re-render */ })
        this.credentials.getPassword(this.profile).then(p => {
            this.passwordValue = p
            this.passwordLoaded = true
        })
    }

    async onPasswordChange (v: string): Promise<void> {
        this.passwordValue = v
        await this.credentials.setPassword(this.profile, v)
    }
}
