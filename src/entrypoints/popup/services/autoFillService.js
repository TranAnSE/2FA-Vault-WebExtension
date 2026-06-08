import { useTwofaccounts } from '@popup/stores/twofaccounts'

export const autoFillService = {
    /**
     * Syncs lightweight account metadata (id, service, account) to background storage
     * so the background can do domain matching without storing secrets.
     */
    async syncAccountsMetadata() {
        const store = useTwofaccounts()
        const accounts = store.items.map(({ id, service, account }) => ({ id, service, account }))
        await sendMessage('SYNC_ACCOUNTS_METADATA', { accounts }, 'background')
    },
}
