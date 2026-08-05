import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
    createLockout,
    MAX_ATTEMPTS_BEFORE_BACKOFF,
    MAX_BACKOFF_MS,
} from './lockout.js'

/**
 * Minimal fake of `browser.storage.local`. get()/set() are async and store a
 * single object; tests reset it between cases.
 */
function createFakeStorage() {
    let store = {}
    return {
        async get(defaults) {
            const result = { ...defaults }
            for (const key of Object.keys(defaults)) {
                if (key in store) result[key] = store[key]
            }
            return result
        },
        async set(obj) {
            store = { ...store, ...obj }
        },
        _peek() {
            return store
        },
    }
}

describe('lockout', () => {
    let storage
    let currentTime
    let lockout

    beforeEach(() => {
        storage = createFakeStorage()
        // Mutable time source so the closure the controller captures can be
        // advanced without recreating the controller.
        currentTime = 1_000_000
        lockout = createLockout({ storage, now: () => currentTime })
    })

    it('allows attempts immediately before the backoff threshold', async () => {
        await lockout.load()
        for (let i = 0; i < MAX_ATTEMPTS_BEFORE_BACKOFF - 1; i++) {
            await lockout.recordFailed()
        }
        // Still under threshold -> no wait.
        expect(lockout.getRemainingMs()).toBe(0)
    })

    it('enforces an exponential backoff once the threshold is reached', async () => {
        await lockout.load()
        // Reach exactly the threshold (5th failure).
        for (let i = 0; i < MAX_ATTEMPTS_BEFORE_BACKOFF; i++) {
            await lockout.recordFailed()
        }
        // First backoff slot: 2^0 * 1000 = 1s.
        expect(lockout.getRemainingMs()).toBe(1000)

        // Advance the clock 500ms; 500ms remains.
        currentTime = 1_000_000 + 500
        expect(lockout.getRemainingMs()).toBe(500)

        // 6th failure -> next slot: 2^1 * 1000 = 2s from now.
        currentTime = 1_000_000
        await lockout.recordFailed()
        expect(lockout.getRemainingMs()).toBe(2000)

        // 7th failure -> 2^2 * 1000 = 4s.
        await lockout.recordFailed()
        expect(lockout.getRemainingMs()).toBe(4000)
    })

    it('caps the backoff at MAX_BACKOFF_MS', async () => {
        await lockout.load()
        // Drive well past the cap by recording many failures.
        for (let i = 0; i < MAX_ATTEMPTS_BEFORE_BACKOFF + 30; i++) {
            await lockout.recordFailed()
        }
        expect(lockout.getRemainingMs()).toBeLessThanOrEqual(MAX_BACKOFF_MS)
    })

    it('persists counters across a controller recreation (service-worker restart)', async () => {
        await lockout.load()
        for (let i = 0; i < MAX_ATTEMPTS_BEFORE_BACKOFF; i++) {
            await lockout.recordFailed()
        }
        // The persisted nextAttemptAt is now + 1000.
        expect(storage._peek().lockoutStore.nextAttemptAt).toBe(1_000_000 + 1000)

        // Recreate the controller against the SAME storage (simulates a SW
        // restart) — it must rehydrate the counters and keep the lockout.
        const reborn = createLockout({ storage, now: () => 1_000_000 })
        await reborn.load()
        expect(reborn.getRemainingMs()).toBe(1000)
        expect(reborn.snapshot().failedAttempts).toBe(MAX_ATTEMPTS_BEFORE_BACKOFF)
    })

    it('reset() clears the counters and re-allows attempts', async () => {
        await lockout.load()
        for (let i = 0; i < MAX_ATTEMPTS_BEFORE_BACKOFF + 2; i++) {
            await lockout.recordFailed()
        }
        expect(lockout.getRemainingMs()).toBeGreaterThan(0)

        await lockout.reset()
        expect(lockout.getRemainingMs()).toBe(0)
        expect(lockout.snapshot().failedAttempts).toBe(0)
    })

    it('survives a storage read failure without throwing', async () => {
        const brokenStorage = {
            async get() {
                throw new Error('storage unavailable')
            },
            async set() {
                throw new Error('storage unavailable')
            },
        }
        const l = createLockout({ storage: brokenStorage, now: () => currentTime })
        await expect(l.load()).resolves.toBeDefined()
        // recordFailed still increments in memory; only persistence failed.
        await expect(l.recordFailed()).resolves.toBe(false)
        expect(l.snapshot().failedAttempts).toBe(1)
    })
})
