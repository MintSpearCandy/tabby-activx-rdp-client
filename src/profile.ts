import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, QuickConnectProfileProvider } from 'tabby-core'

import { parseRdpTarget, RDP_PROFILE_TYPE, RdpProfile } from './api'
import { RdpProfileSettingsComponent } from './profileSettings.component'
import { RdpTabComponent } from './rdpTab.component'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class ActivxRdpProfileProvider extends QuickConnectProfileProvider<RdpProfile> {
    id = RDP_PROFILE_TYPE
    name = 'ActiveX RDP'
    settingsComponent = RdpProfileSettingsComponent
    configDefaults = {
        options: {
            host: '',
            port: 3389,
            username: '',
            password: '',
            domain: '',
            width: 0,
            height: 0,
        },
    }

    async getBuiltinProfiles (): Promise<PartialProfile<RdpProfile>[]> {
        return [
            {
                id: 'activx-rdp',
                type: RDP_PROFILE_TYPE,
                name: 'ActiveX RDP',
                icon: 'fas fa-desktop',
                isBuiltin: true,
                options: {
                    host: '',
                    port: 3389,
                    username: '',
                    password: '',
                    domain: '',
                    width: 0,
                    height: 0,
                },
            } as PartialProfile<RdpProfile>,
        ]
    }

    async getNewTabParameters (profile: RdpProfile): Promise<NewTabParameters<RdpTabComponent>> {
        return { type: RdpTabComponent, inputs: { profile } }
    }

    quickConnect (query: string): PartialProfile<RdpProfile> | null {
        const t = parseRdpTarget(query)
        if (!t) {
            return null
        }
        return {
            id: `activx-rdp:qc:${Date.now().toString(36)}`,
            type: RDP_PROFILE_TYPE,
            name: t.host,
            icon: 'fas fa-desktop',
            options: {
                host: t.host,
                port: t.port,
                username: '',
                password: '',
                domain: '',
                width: 0,
                height: 0,
            },
        } as PartialProfile<RdpProfile>
    }

    intoQuickConnectString (profile: RdpProfile): string | null {
        const o = profile.options
        if (!o?.host) {
            return null
        }
        return o.port && o.port !== 3389 ? `${o.host}:${o.port}` : o.host
    }

    getSuggestedName (profile: PartialProfile<RdpProfile>): string | null {
        return profile.options?.host || 'ActiveX RDP'
    }

    getDescription (profile: PartialProfile<RdpProfile>): string {
        const o = profile.options
        if (!o?.host) {
            return ''
        }
        return o.port && o.port !== 3389 ? `${o.host}:${o.port}` : o.host
    }
}
