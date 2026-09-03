import { describe, expect, it, beforeEach } from 'vitest'
import { createRuntimeSecrets, resolveRuntimePat } from './sessionSecrets.js'

/**
 * Minimal fake of `browser.storage.session`.
 */
function createFakeSessionStorage() {
    let store = {}
    const failures = { get: false, set: false, remove: false }
    return {
        async get(key) {
            if (failures.get) throw new Error('get failed')
            return key in store ? { [key]: store[key] } : {}
        },
        async set(obj) {
            if (failures.set) throw new Error('set failed')
            store = { ...store, ...obj }
        },
        async remove(key) {
            if (failures.remove) throw new Error('remove failed')
            delete store[key]
        },
        _peek() {
            return store
        },
        _fail(op, on = true) {
            failures[op] = on
        },
    }
}

describe('runtimeSecrets', () => {
    let sessionStorage

    beforeEach(() => {
        sessionStorage = createFakeSessionStorage()
    })

    it('keeps the PAT in memory and mirrors it to session storage', async () => {
        const secrets = createRuntimeSecrets({ sessionStorage })
        await secrets.set('pat-123')
        expect(secrets.hasInMemory()).toBe(true)
        expect(sessionStorage._peek()).toEqual({ extRuntimePat: 'pat-123' })
        expect(await secrets.get()).toBe('pat-123')
    })

    it('recovers the PAT from session storage after SW memory loss', async () => {
        const secrets = createRuntimeSecrets({ sessionStorage })
        await secrets.set('pat-123')
        // Simulate SW suspension: fresh controller, same session storage.
        const resurrected = createRuntimeSecrets({ sessionStorage })
        expect(resurrected.hasInMemory()).toBe(false)
        expect(await resurrected.get()).toBe('pat-123')
    })

    it('clear() empties both tiers (RT6: no PAT resurrection after lock)', async () => {
        const secrets = createRuntimeSecrets({ sessionStorage })
        await secrets.set('pat-123')
        await secrets.clear()
        expect(secrets.hasInMemory()).toBe(false)
        expect(await secrets.get()).toBe('')
        expect(sessionStorage._peek()).toEqual({})
        // A fresh controller (post-lock SW restart) must not see it either.
        expect(await createRuntimeSecrets({ sessionStorage }).get()).toBe('')
    })

    it('degrades to memory-only when storage.session is unavailable', async () => {
        const secrets = createRuntimeSecrets({ sessionStorage: null })
        expect(await secrets.set('pat-123')).toBe(false)
        expect(await secrets.get()).toBe('pat-123')
        await secrets.clear()
        expect(await secrets.get()).toBe('')
    })

    it('never throws when session storage operations fail', async () => {
        const secrets = createRuntimeSecrets({ sessionStorage })
        sessionStorage._fail('set')
        await expect(secrets.set('pat-123')).resolves.toBe(false)
        // Memory tier still holds the value.
        expect(await secrets.get()).toBe('pat-123')
        sessionStorage._fail('get')
        expect(await secrets.get()).toBe('pat-123')
        sessionStorage._fail('remove')
        await expect(secrets.clear()).resolves.toBe(false)
        expect(secrets.hasInMemory()).toBe(false)
    })
})

describe('resolveRuntimePat', () => {
    it('never overwrites a non-empty in-memory PAT with the empty persisted copy', () => {
        // storeState() persists {...state, pat: ''} — loadState() must not
        // wipe the live PAT with that stripped copy (D1 regression).
        expect(resolveRuntimePat('', 'live-pat', 'session-pat')).toBe('live-pat')
    })

    it('falls back to the session-storage copy when memory is empty', () => {
        expect(resolveRuntimePat('', '', 'session-pat')).toBe('session-pat')
    })

    it('returns empty when every tier is empty', () => {
        expect(resolveRuntimePat('', '', '')).toBe('')
    })
})
