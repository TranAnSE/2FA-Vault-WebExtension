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
