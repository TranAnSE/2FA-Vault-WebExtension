/**
 * Extension biometric service — mirrors the main app's biometric.js
 * but uses WXT's browser.storage.local instead of IndexedDB (offline-db).
 * WebAuthn platform authenticator works in extension popup context.
 *
 * SECURITY MODEL
 * --------------
 * The wrapping key that encrypts the stored password is derived from the
 * authenticator on every unlock via the WebAuthn PRF (Pseudo-Random Function)
 * extension. The key is NEVER persisted: only a random salt is stored, and
 * the authenticator regenerates the same key only after a successful user-
 * verification (Touch ID / Windows Hello / etc.). Without the biometric
 * assertion, the encrypted password blob is unrecoverable even with full
 * access to `browser.storage.local`.
 *
 * Requires a browser with WebAuthn PRF support (Chrome/Edge >= 98, Safari
 * >= 16.5). `isEnrolled()` / `enroll()` fall back gracefully on older
 * browsers by returning a PRF-not-available error so the caller can disable
 * the biometric option in the UI.
 */

const KEY_CREDENTIAL_ID  = '2fauth:biometric:credentialId'
const KEY_PRF_SALT       = '2fauth:biometric:prfSalt'   // random 32-byte salt (NOT secret)
const KEY_ENCRYPTED_PASS = '2fauth:biometric:encryptedPass'

function bufferToBase64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}

function base64ToBuffer(b64) {
    const bin = atob(b64)
    const buf = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
    return buf.buffer
}

async function storageGet(key) {
    const result = await browser.storage.local.get(key)
    return result[key] ?? null
}

async function storageSet(key, value) {
    return browser.storage.local.set({ [key]: value })
}

export const biometricService = {
    async isSupported() {
        if (!window.PublicKeyCredential) return false
        try {
            return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        } catch {
            return false
        }
    },

    async isEnrolled() {
        return !!(await storageGet(KEY_CREDENTIAL_ID))
    },

    async enroll(username) {
        const challenge = crypto.getRandomValues(new Uint8Array(32))
        const credential = await navigator.credentials.create({
            publicKey: {
                challenge,
                rp: { name: '2FA-Vault', id: window.location.hostname },
                user: {
                    id: new TextEncoder().encode(username),
                    name: username,
                    displayName: username,
                },
                pubKeyCredParams: [
                    { alg: -7, type: 'public-key' },
                    { alg: -257, type: 'public-key' },
                ],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    userVerification: 'required',
                },
                // Request the PRF extension so we can derive a stable
                // authenticator-bound key for encrypting the stored password.
                extensions: { prf: true },
                timeout: 60000,
                attestation: 'none',
            },
        })

        // The browser exposes the PRF capability via `getClientExtensionResults()`.
        // If PRF is not available, surface a clear error so the caller can
        // disable the biometric option instead of silently degrading security.
        if (!credential.getClientExtensionResults?.().prf?.enabled) {
            await storageSet(KEY_CREDENTIAL_ID, '') // mark not enrolled
            throw new Error('Biometric PRF extension not supported by this device/browser')
        }

        await storageSet(KEY_CREDENTIAL_ID, bufferToBase64(credential.rawId))
        return true
    },

    async authenticate() {
        const credId = await storageGet(KEY_CREDENTIAL_ID)
        if (!credId) throw new Error('Biometric not enrolled')

        const challenge = crypto.getRandomValues(new Uint8Array(32))
        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{ id: base64ToBuffer(credId), type: 'public-key', transports: ['internal'] }],
                userVerification: 'required',
                timeout: 30000,
            },
        })

        if (!assertion) throw new Error('Biometric authentication failed')
        return assertion
    },

    /**
     * Derive the AES-GCM wrapping key from the authenticator via the PRF
     * extension. The salt is stored (non-secret); the key is recomputed on
     * every call and only lives in memory. Without a successful biometric
     * assertion, no key can be derived and the stored password is unrecoverable.
     *
     * @param {Uint8Array} prfInput - 32-byte salt stored alongside the credential
     * @returns {Promise<CryptoKey>} AES-GCM key bound to the authenticator
     */
    async _deriveWrappingKeyFromAuthenticator(prfInput) {
        const credId = await storageGet(KEY_CREDENTIAL_ID)
        if (!credId) throw new Error('Biometric not enrolled')

        const challenge = crypto.getRandomValues(new Uint8Array(32))
        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{ id: base64ToBuffer(credId), type: 'public-key', transports: ['internal'] }],
                userVerification: 'required',
                // Ask the authenticator to compute the PRF output for our salt.
                extensions: { prf: { eval: { first: prfInput } } },
                timeout: 30000,
            },
        })

        if (!assertion) throw new Error('Biometric authentication failed')

        const prfResult = assertion.getClientExtensionResults?.().prf?.results?.first
        if (!prfResult) throw new Error('Biometric PRF not available on this device/browser')

        // PRF output is 32 bytes by default — exactly AES-256 key material.
        return crypto.subtle.importKey('raw', prfResult, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    },

    async enrollWithPassword(username, password) {
        await this.enroll(username)

        // Store a random salt (not secret) and derive the wrapping key from the
        // authenticator at encrypt AND decrypt time. The key is never persisted.
        const salt = crypto.getRandomValues(new Uint8Array(32))
        await storageSet(KEY_PRF_SALT, bufferToBase64(salt))

        const wrappingKey = await this._deriveWrappingKeyFromAuthenticator(salt)
        const iv          = crypto.getRandomValues(new Uint8Array(12))
        const encrypted   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, new TextEncoder().encode(password))

        await storageSet(KEY_ENCRYPTED_PASS, JSON.stringify({ iv: bufferToBase64(iv), data: bufferToBase64(encrypted) }))
    },

    async retrievePassword() {
        const saltB64 = await storageGet(KEY_PRF_SALT)
        const encJson = await storageGet(KEY_ENCRYPTED_PASS)
        if (!saltB64 || !encJson) throw new Error('No biometric-protected password found')

        // Re-derive the key from the authenticator (requires biometric unlock).
        const wrappingKey = await this._deriveWrappingKeyFromAuthenticator(base64ToBuffer(saltB64))

        const { iv, data } = JSON.parse(encJson)
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuffer(iv) }, wrappingKey, base64ToBuffer(data))
        return new TextDecoder().decode(decrypted)
    },

    async remove() {
        await browser.storage.local.remove([KEY_CREDENTIAL_ID, KEY_PRF_SALT, KEY_ENCRYPTED_PASS])
    },
}
