import { Injectable } from '@angular/core'
import { Injector } from '@angular/core'
import { NewTabParameters, ProfilesService, RecoveryToken, TabRecoveryProvider } from 'tabby-core'

import { RdpProfile, RDP_PROFILE_TYPE } from './api'
import { RdpTabComponent } from './rdpTab.component'

/** @hidden */
@Injectable()
export class RdpTabRecoveryProvider extends TabRecoveryProvider<RdpTabComponent> {
    static RECOVERY_TYPE = 'activx-rdp-tab'

    constructor (private injector: Injector) {
        super()
    }

    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === RdpTabRecoveryProvider.RECOVERY_TYPE
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<RdpTabComponent>> {
        // The token carries the profile id; resolve the live profile so a
        // deleted profile does not resurrect.
        const profilesService = this.injector.get(ProfilesService)
        const profileId = (recoveryToken as any).profileId
        const profile = (await profilesService.getProfiles())
            .find(p => p.id === profileId) as RdpProfile | undefined
        if (!profile || profile.type !== RDP_PROFILE_TYPE) {
            return null as any as NewTabParameters<RdpTabComponent>
        }
        // autoConnect: false — a restored tab waits for an explicit
        // reconnect instead of auto-firing on launch.
        return { type: RdpTabComponent, inputs: { profile, autoConnect: false } }
    }
}
