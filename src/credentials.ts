/**
 * @hidden
 * Password storage for RDP profiles. When Tabby's Vault is enabled the
 * password lives there (encrypted, like Tabby's SSH passwords); otherwise it
 * falls back to plain text in config.yaml (PoC-grade, flagged in the UI).
 */
import { Injectable, Injector } from '@angular/core'
import { VaultService } from 'tabby-core'

import { RdpProfile } from './api'

export const VAULT_SECRET_TYPE = 'activx-rdp:password'

@Injectable({ providedIn: 'root' })
export class RdpCredentialsService {
    private vault: VaultService | null = null

    constructor (injector: Injector) {
        try {
            this.vault = injector.get(VaultService)
        } catch {
            this.vault = null
        }
    }

    vaultEnabled (): boolean {
        try {
            return !!this.vault?.isEnabled()
        } catch {
            return false
        }
    }

    /** Where the password for this profile lives right now. */
    storageName (): string {
        return this.vaultEnabled() ? "Tabby's Vault" : 'config.yaml (plain text)'
    }

    async getPassword (profile: RdpProfile): Promise<string> {
        if (this.vaultEnabled() && this.vault) {
            try {
                const secret = await this.vault.getSecret(VAULT_SECRET_TYPE, {
                    profileId: profile.id,
                } as any)
                if (secret) {
                    return secret.value
                }
            } catch {
                // fall through to the plain-text option
            }
        }
        return profile.options?.password || ''
    }

    /**
     * Store the password: in the Vault when enabled, otherwise in the
     * profile options (plain text). Empty string clears both storages.
     */
    async setPassword (profile: RdpProfile, password: string): Promise<void> {
        if (this.vaultEnabled() && this.vault) {
            try {
                const existing = await this.vault.getSecret(VAULT_SECRET_TYPE, {
                    profileId: profile.id,
                } as any)
                if (!password) {
                    if (existing) {
                        await this.vault.removeSecret(VAULT_SECRET_TYPE, {
                            profileId: profile.id,
                        } as any)
                    }
                } else if (existing) {
                    await this.vault.updateSecret(
                        { type: VAULT_SECRET_TYPE, key: { profileId: profile.id } as any, value: password } as any,
                        { type: VAULT_SECRET_TYPE, key: { profileId: profile.id } as any, value: password } as any)
                } else {
                    await this.vault.addSecret(
                        { type: VAULT_SECRET_TYPE, key: { profileId: profile.id } as any, value: password } as any)
                }
                // Never keep a second copy in plain text once the Vault took it.
                if (profile.options) {
                    profile.options.password = ''
                }
                return
            } catch {
                // Vault write failed — keep the plain-text fallback below.
            }
        }
        if (profile.options) {
            profile.options.password = password
        }
    }
}
