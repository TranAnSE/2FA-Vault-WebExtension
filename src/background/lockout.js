/**
 * Brute-force protection for the extension's password-gated operations.
 *
 * Tracks consecutive failed unlock/check attempts and enforces an exponential
 * backoff. Counters are persisted via the injected `storage` so a
 * service-worker restart cannot reset the throttle. The key-derivation
 * (PBKDF2/Argon2id) remains the primary defence; this raises the cost of
 * online guessing through the popup UI.
 *
 * Extracted from background.js so the state machine can be unit-tested in
 * isolation. The background entrypoint wires it up with the real
 * `browser.storage.local` and `Date.now`.
 */

/** Storage key under which the lockout counters are persisted. */
export const LOCKOUT_STORE = 'lockoutStore'

/** Attempts before the exponential delay kicks in. */
export const MAX_ATTEMPTS_BEFORE_BACKOFF = 5

/** Cap for the backoff delay. */
export const MAX_BACKOFF_MS = 5 * 60 * 1000

/**
 * Create a lockout controller bound to a storage adapter.
 *
 * @param {object} opts
 * @param {object} opts.storage  Object with async `get(defaults)` and `set(obj)`
 *   methods (matches `browser.storage.local` and the test fake).
 * @param {() => number} [opts.now]  Time source; defaults to Date.now.
 * @returns {object} Public lockout API.
 */
export function createLockout({ storage, now = Date.now }) {
    let lockout = { failedAttempts: 0, nextAttemptAt: 0 }

    async function load() {
        try {
            const stores = await storage.get({ [LOCKOUT_STORE]: null })
            const stored = stores[LOCKOUT_STORE]
            if (stored && typeof stored.failedAttempts === 'number') {
                lockout = stored
            }
        } catch {
            // Storage read failure: keep the in-memory value.
        }
        return lockout
    }

    async function save() {
        try {
            await storage.set({ [LOCKOUT_STORE]: lockout })
            return true
        } catch {
            return false
        }
    }

    /**
     * Returns 0 if an attempt is allowed now, otherwise the ms remaining
     * until the next attempt is permitted.
     */
    function getRemainingMs() {
        if (lockout.failedAttempts < MAX_ATTEMPTS_BEFORE_BACKOFF) return 0
        return Math.max(0, lockout.nextAttemptAt - now())
    }

    /** Record a failed attempt and, once past the threshold, schedule backoff. */
    async function recordFailed() {
        lockout.failedAttempts += 1
        if (lockout.failedAttempts >= MAX_ATTEMPTS_BEFORE_BACKOFF) {
            // Exponential backoff: 1s, 2s, 4s, 8s ... capped at MAX_BACKOFF_MS.
            const exponent = lockout.failedAttempts - MAX_ATTEMPTS_BEFORE_BACKOFF
            const delay = Math.min(MAX_BACKOFF_MS, Math.pow(2, exponent) * 1000)
            lockout.nextAttemptAt = now() + delay
        }
        return save()
    }

    /** Clear the counters after a success or an admin reset. */
    async function reset() {
        lockout = { failedAttempts: 0, nextAttemptAt: 0 }
        return save()
    }

    /** Read-only snapshot (for diagnostics/tests). */
    function snapshot() {
        return { ...lockout }
    }

    return { load, getRemainingMs, recordFailed, reset, snapshot }
}
