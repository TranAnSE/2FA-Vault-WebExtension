import { describe, expect, it } from 'vitest'
import {
    deriveKey,
    encryptAesGcm,
    decryptAesGcm,
    toUint8Array,
    fromUint8Array,
    KDF_ITERATIONS_LEGACY,
    KDF_ITERATIONS_CURRENT,
} from './crypto.js'

// Node ships a real WebCrypto implementation (globalThis.crypto.subtle), so the
// tests exercise the actual PBKDF2 + AES-GCM code path rather than a stub.
const subtle = globalThis.crypto.subtle
const encoder = new TextEncoder()

describe('deriveKey', () => {
    it('returns a usable AES-GCM CryptoKey', async () => {
        const key = await deriveKey({
            subtle,
            encoder,
            password: 'correct horse battery staple',
            salt: 'somesalt',
            iterations: 1000,
        })

        expect(key).toBeInstanceOf(CryptoKey)
        expect(key.algorithm.name).toBe('AES-GCM')
        expect(key.algorithm.length).toBe(256)
        expect(key.usages).toContain('encrypt')
        expect(key.usages).toContain('decrypt')
    })

    it('derives a key that can encrypt and decrypt a round trip', async () => {
        const key = await deriveKey({
            subtle,
            encoder,
            password: 'pw',
            salt: 'salt',
            iterations: 1000,
        })

        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const plaintext = encoder.encode('pat-SECRET-123456')

        const ciphertext = await subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            plaintext,
        )
        // A wrong key must fail to decrypt (authentication tag mismatch).
        const otherKey = await deriveKey({
            subtle,
            encoder,
            password: 'wrong',
            salt: 'salt',
            iterations: 1000,
        })
        await expect(
            subtle.decrypt({ name: 'AES-GCM', iv }, otherKey, ciphertext),
        ).rejects.toThrow()

        // The right key decrypts back to the original plaintext.
        const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
        expect(new TextDecoder().decode(decrypted)).toBe('pat-SECRET-123456')
    })

    it('derives the same key for identical inputs (deterministic)', async () => {
        const a = await deriveKey({
            subtle, encoder, password: 'pw', salt: 'salt', iterations: 1000,
        })
        const b = await deriveKey({
            subtle, encoder, password: 'pw', salt: 'salt', iterations: 1000,
        })

        // Same inputs -> keys produce identical ciphertext (compare by
        // round-tripping through one of them).
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const plaintext = encoder.encode('x')
        const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, a, plaintext)
        await expect(subtle.decrypt({ name: 'AES-GCM', iv }, b, ct)).resolves.toBeDefined()
    })

    it('derives DIFFERENT keys for different salts', async () => {
        const a = await deriveKey({
            subtle, encoder, password: 'pw', salt: 'salt-a', iterations: 1000,
        })
        const b = await deriveKey({
            subtle, encoder, password: 'pw', salt: 'salt-b', iterations: 1000,
        })

        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, a, encoder.encode('x'))
        await expect(subtle.decrypt({ name: 'AES-GCM', iv }, b, ct)).rejects.toThrow()
    })

    it('exposes the documented legacy and current iteration counts', () => {
        expect(KDF_ITERATIONS_LEGACY).toBe(100000)
        expect(KDF_ITERATIONS_CURRENT).toBe(600000)
        expect(KDF_ITERATIONS_CURRENT).toBeGreaterThan(KDF_ITERATIONS_LEGACY)
    })
})

describe('array converters', () => {
    it('toUint8Array accepts a plain array or a typed array', () => {
        expect(Array.from(toUint8Array([1, 2, 3]))).toEqual([1, 2, 3])
        const u = new Uint8Array([4, 5, 6])
        expect(toUint8Array(u)).toBe(u) // pass-through
    })

    it('toUint8Array tolerates null/undefined', () => {
        expect(Array.from(toUint8Array(null))).toEqual([])
        expect(Array.from(toUint8Array(undefined))).toEqual([])
    })

    it('fromUint8Array produces a JSON-friendly plain array', () => {
        const arr = fromUint8Array(new Uint8Array([7, 8, 9]))
        expect(arr).toEqual([7, 8, 9])
        expect(JSON.stringify({ x: arr })).toBe('{"x":[7,8,9]}')
    })
})

describe('encryptAesGcm / decryptAesGcm', () => {
    it('round-trips a plaintext string', async () => {
        const key = await deriveKey({
            subtle, encoder, password: 'pw', salt: 'salt', iterations: 1000,
        })
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))

        const ct = await encryptAesGcm({
            subtle, encoder, key, plaintext: 'pat-SECRET-xyz', iv,
        })
        expect(ct).toBeInstanceOf(Uint8Array)

        const plaintext = await decryptAesGcm({
            subtle, decoder: new TextDecoder(), key, cipherBytes: ct, iv,
        })
        expect(plaintext).toBe('pat-SECRET-xyz')
    })

    it('accepts a plain array (storage shape) as ciphertext for decryption', async () => {
        // ciphertext is persisted in browser.storage as a plain Array; decrypt
        // must accept that shape via toUint8Array internally.
        const key = await deriveKey({
            subtle, encoder, password: 'pw', salt: 'salt', iterations: 1000,
        })
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const ct = await encryptAesGcm({
            subtle, encoder, key, plaintext: 'pat-PLAIN', iv,
        })
        const plainArray = fromUint8Array(ct) // simulate storage round-trip

        const plaintext = await decryptAesGcm({
            subtle, decoder: new TextDecoder(), key, cipherBytes: plainArray, iv,
        })
        expect(plaintext).toBe('pat-PLAIN')
    })

    it('fails to decrypt with a wrong IV (auth-tag mismatch)', async () => {
        const key = await deriveKey({
            subtle, encoder, password: 'pw', salt: 'salt', iterations: 1000,
        })
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const ct = await encryptAesGcm({
            subtle, encoder, key, plaintext: 'pat-X', iv,
        })
        const wrongIv = globalThis.crypto.getRandomValues(new Uint8Array(12))

        await expect(
            decryptAesGcm({ subtle, decoder: new TextDecoder(), key, cipherBytes: ct, iv: wrongIv }),
        ).rejects.toThrow()
    })
})
