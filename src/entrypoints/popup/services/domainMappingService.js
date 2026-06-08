/**
 * domainMappingService — learns and stores user-confirmed domain→account mappings.
 * Uses browser.storage.local so mappings persist across sessions.
 * Format: { [hostname]: accountId }
 */

const STORAGE_KEY = 'domainMappings'

export const domainMappingService = {
    async getAll() {
        const { [STORAGE_KEY]: mappings } = await browser.storage.local.get(STORAGE_KEY)
        return mappings ?? {}
    },

    async saveMapping(hostname, accountId) {
        const mappings = await this.getAll()
        mappings[hostname.replace(/^www\./, '')] = accountId
        await browser.storage.local.set({ [STORAGE_KEY]: mappings })
    },

    async getForHostname(hostname) {
        const mappings = await this.getAll()
        return mappings[hostname.replace(/^www\./, '')] ?? null
    },

    async removeMapping(hostname) {
        const mappings = await this.getAll()
        delete mappings[hostname.replace(/^www\./, '')]
        await browser.storage.local.set({ [STORAGE_KEY]: mappings })
    },
}
