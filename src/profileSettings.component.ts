import { Component } from '@angular/core'

import { RdpProfile } from './api'
import { RdpCredentialsService } from './credentials'

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

    constructor (private credentials: RdpCredentialsService) {}

    ngOnInit (): void {
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
