import { useTwofaccounts } from '@popup/stores/twofaccounts'

export const autoFillService = {
    /**
     * Syncs lightweight account metadata (id, service, account, otp_type, period) to background storage
     * so the background can do domain matching and TOTP badge countdown without storing secrets.
     */
    async syncAccountsMetadata() {
        const store = useTwofaccounts()
        const accounts = store.items.map(({ id, service, account, otp_type, period }) => ({ id, service, account, otp_type, period }))
        await sendMessage('SYNC_ACCOUNTS_METADATA', { accounts }, 'background')
    },
}
