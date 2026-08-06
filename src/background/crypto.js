/**
 * PAT encryption primitives for the browser extension.
 *
 * The full encrypt/decrypt flow is wired into background.js because it
 * mutates shared state (encryptionParams, password, the crypto store).
 * This module extracts the stateless, security-critical primitive —
 * PBKDF2 key derivation — so it can be unit-tested against the real
 * WebCrypto API in Node/jsdom.
 *
 * Constants mirror the PAT-encryption KDF policy in background.js:
 *   - KDF_ITERATIONS_LEGACY: 100,000 (older builds; still readable for
 *     existing ciphertext so upgrades don't lock users out)
 *   - KDF_ITERATIONS_CURRENT: 600,000 (OWASP 2023+ for PBKDF2-HMAC-SHA-256;
 *     used for all NEW encryption)
 */

/** Legacy PBKDF2 iteration count (pre-v1.3.0 builds). */
export const KDF_ITERATIONS_LEGACY = 100000

/** Current PBKDF2 iteration count (OWASP 2023+ recommendation). */
export const KDF_ITERATIONS_CURRENT = 600000

/**
 * Derive an AES-256-GCM CryptoKey from a password via PBKDF2-HMAC-SHA-256.
 *
 * @param {object} opts
 * @param {SubtleCrypto} opts.subtle  The WebCrypto subtle implementation.
 * @param {{encode: (s: string) => Uint8Array}} opts.encoder  A TextEncoder-like.
 * @param {string} opts.password  The user password (extension unlock password).
 * @param {string|Uint8Array} opts.salt  The salt; encoded as UTF-8 if a string.
 * @param {number} [opts.iterations]  PBKDF2 iterations; defaults to LEGACY for
 *   backward compatibility when decrypting old ciphertext.
 * @returns {Promise<CryptoKey>}  An AES-GCM key usable for encrypt/decrypt.
 */
export async function deriveKey({ subtle, encoder, password, salt, iterations }) {
    const iters = iterations ?? KDF_ITERATIONS_LEGACY

    const keyMaterial = await subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits', 'deriveKey'],
    )

    return subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode(salt),
            iterations: iters,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    )
}

/**
 * Convert a plain Array of numbers (as stored in browser.storage) into a
 * Uint8Array for WebCrypto. Pass-through for values that are already typed.
 *
 * @param {Array<number>|Uint8Array|Iterable<number>} value
 * @returns {Uint8Array}
 */
export function toUint8Array(value) {
    if (value instanceof Uint8Array) return value
    return new Uint8Array(Array.from(value ?? []))
}

/**
 * Convert a Uint8Array (or iterable) into a plain Array of numbers, the shape
 * that survives JSON round-tripping through browser.storage.local.
 *
 * @param {Uint8Array|Iterable<number>} value
 * @returns {Array<number>}
 */
export function fromUint8Array(value) {
    return Array.from(value ?? [])
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM under the given key and IV.
 *
 * @param {object} opts
 * @param {SubtleCrypto} opts.subtle
 * @param {{encode: (s: string) => Uint8Array}} opts.encoder
 * @param {CryptoKey} opts.key     AES-GCM key (from deriveKey).
 * @param {string} opts.plaintext  The PAT to encrypt.
 * @param {Uint8Array} opts.iv     12-byte initialization vector.
 * @returns {Promise<Uint8Array>}  The ciphertext + auth tag.
 */
export async function encryptAesGcm({ subtle, encoder, key, plaintext, iv }) {
    const ciphertext = await subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(plaintext),
    )
    return new Uint8Array(ciphertext)
}

/**
 * Decrypt AES-256-GCM ciphertext back to the original UTF-8 string.
 *
 * @param {object} opts
 * @param {SubtleCrypto} opts.subtle
 * @param {{decode: (b: Uint8Array) => string}} opts.decoder
 * @param {CryptoKey} opts.key        AES-GCM key.
 * @param {Uint8Array|Array<number>} opts.cipherBytes  Ciphertext + auth tag.
 * @param {Uint8Array} opts.iv        The IV used at encryption time.
 * @returns {Promise<string>}         The decrypted plaintext.
 */
export async function decryptAesGcm({ subtle, decoder, key, cipherBytes, iv }) {
    const decrypted = await subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        toUint8Array(cipherBytes),
    )
    return decoder.decode(new Uint8Array(decrypted))
}
