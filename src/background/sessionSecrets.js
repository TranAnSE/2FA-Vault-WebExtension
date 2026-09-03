/**
 * Runtime-only secret store for the background service worker.
 *
 * SECURITY MODEL (audit finding D1/D6)
 * ------------------------------------
 * The decrypted PAT (and any other runtime secret) must NEVER be written
 * to `browser.storage.local` (on disk). Two tiers are used instead:
 *
 * 1. `browser.storage.session` where available (Chrome MV3 memory-backed,
 *    Firefox >= 115): survives service-worker suspension, cleared by the
 *    browser on restart.
 * 2. Plain service-worker memory as a fallback: the secret is lost when
 *    the worker suspends, which simply re-locks the vault (safe
 *    degradation, matching autolock semantics).
 *
 * EVERY lock transition must call clear() so the session copy cannot
 * resurrect a PAT after lock (red-team finding RT6).
 */

const PAT_KEY = 'extRuntimePat'

/**
 * Build a runtime-secret controller over an optional session storage area.
 *
 * @param {object} [options]
 * @param {StorageArea|null|undefined} [options.sessionStorage] `browser.storage.session` if available.
 * @returns {{
 *   set: (pat: string) => Promise<boolean>,
 *   get: () => Promise<string>,
 *   clear: () => Promise<boolean>,
 *   hasInMemory: () => boolean,
 * }}
 */
export function createRuntimeSecrets({ sessionStorage } = {}) {
    let memoryPat = ''

    return {
        /**
         * Store the PAT in SW memory and mirror it into session storage
         * (best effort — never touches storage.local).
         */
        async set(pat) {
            memoryPat = pat || ''
            if (!sessionStorage) return false
            try {
                await sessionStorage.set({ [PAT_KEY]: memoryPat })
                return true
            } catch {
                return false
            }
        },

        /**
         * Resolve the live PAT: in-memory value wins (freshest), then the
         * session-storage copy (SW was suspended and resumed).
         */
        async get() {
            if (memoryPat) return memoryPat
            if (!sessionStorage) return ''
            try {
                const result = await sessionStorage.get(PAT_KEY)
                return result?.[PAT_KEY] || ''
            } catch {
                return ''
            }
        },

        /**
         * Clear both tiers. Called on every lock transition (lockNow,
         * kickAfter expiry, startup force-lock, browser close, resetExt).
         */
        async clear() {
            memoryPat = ''
            if (!sessionStorage) return false
            try {
                await sessionStorage.remove(PAT_KEY)
                return true
            } catch {
                return false
            }
        },

        hasInMemory() {
            return !!memoryPat
        },
    }
}

/**
 * Merge rule for loadState(): the persisted EXTSTATE copy never contains
 * the PAT (it is stripped by storeState()), so the live value must be
 * resolved from the in-memory or session-storage tiers. A non-empty value
 * is NEVER overwritten by an empty one.
 *
 * @param {string} persistedPat PAT from the persisted store (always '').
 * @param {string} memoryPat In-memory PAT captured before state replacement.
 * @param {string} sessionPat PAT recovered from storage.session.
 * @returns {string}
 */
export function resolveRuntimePat(persistedPat, memoryPat, sessionPat) {
    return memoryPat || sessionPat || persistedPat || ''
}
