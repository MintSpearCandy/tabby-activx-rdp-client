import { NgModule, Injector } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { AppService, ConfigProvider, HotkeyProvider, HotkeysService, ProfileProvider, TabRecoveryProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { PLUGIN_ID } from './api'
import { ActivxRdpConfigProvider } from './config'
import { ActivxRdpProfileProvider } from './profile'
import { RdpTabComponent } from './rdpTab.component'
import { RdpProfileSettingsComponent } from './profileSettings.component'
import { RdpTabRecoveryProvider } from './recovery'
import { ActivxRdpSettingsTabComponent } from './settingsTab.component'
import { ActivxRdpSettingsTabProvider } from './settings'
import { ActivxRdpHotkeyProvider } from './hotkeys'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: ProfileProvider, useClass: ActivxRdpProfileProvider, multi: true },
        { provide: ConfigProvider, useClass: ActivxRdpConfigProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: RdpTabRecoveryProvider, multi: true },
        { provide: SettingsTabProvider, useClass: ActivxRdpSettingsTabProvider, multi: true },
        { provide: HotkeyProvider, useClass: ActivxRdpHotkeyProvider, multi: true },
    ],
    declarations: [
        RdpTabComponent,
        RdpProfileSettingsComponent,
        ActivxRdpSettingsTabComponent,
    ],
    entryComponents: [
        // Required: TabsService instantiates tab components through the
        // ComponentFactoryResolver, not through a template reference.
        RdpTabComponent,
        RdpProfileSettingsComponent,
        ActivxRdpSettingsTabComponent,
    ],
})
export default class ActivxRdpClientModule {
    constructor (
        injector: Injector,
        app: AppService,
        hotkeys: HotkeysService,
    ) {
        // Dispatch our hotkeys to the active RDP tab. Core does not route
        // plugin hotkeys automatically, and the bindings themselves come from
        // the ConfigProvider defaults (hotkeys['activx-rdp-client:*']).
        hotkeys.hotkey$.subscribe(id => {
            if (!id.startsWith(`${PLUGIN_ID}:`)) {
                return
            }
            const active = app.activeTab
            if (!(active instanceof RdpTabComponent)) {
                return
            }
            if (id === `${PLUGIN_ID}:disconnect`) {
                active.disconnect()
            } else if (id === `${PLUGIN_ID}:reconnect`) {
                active.reconnect()
            }
        })
        void injector
    }
}
