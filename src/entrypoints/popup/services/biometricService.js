/**
 * Extension biometric service — mirrors the main app's biometric.js
 * but uses WXT's browser.storage.local instead of IndexedDB (offline-db).
 * WebAuthn platform authenticator works in extension popup context.
 */

const KEY_CREDENTIAL_ID  = '2fauth:biometric:credentialId'
const KEY_WRAPPING_KEY   = '2fauth:biometric:wrappingKey'
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
                timeout: 60000,
                attestation: 'none',
            },
        })

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

    async enrollWithPassword(username, password) {
        await this.enroll(username)

        const wrappingKey = crypto.getRandomValues(new Uint8Array(32))
        const iv          = crypto.getRandomValues(new Uint8Array(12))
        const cryptoKey   = await crypto.subtle.importKey('raw', wrappingKey, { name: 'AES-GCM' }, false, ['encrypt'])
        const encrypted   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(password))

        await storageSet(KEY_WRAPPING_KEY, bufferToBase64(wrappingKey))
        await storageSet(KEY_ENCRYPTED_PASS, JSON.stringify({ iv: bufferToBase64(iv), data: bufferToBase64(encrypted) }))
    },

    async retrievePassword() {
        await this.authenticate()

        const wrappingKeyB64 = await storageGet(KEY_WRAPPING_KEY)
        const encJson        = await storageGet(KEY_ENCRYPTED_PASS)
        if (!wrappingKeyB64 || !encJson) throw new Error('No biometric-protected password found')

        const { iv, data } = JSON.parse(encJson)
        const cryptoKey = await crypto.subtle.importKey('raw', base64ToBuffer(wrappingKeyB64), { name: 'AES-GCM' }, false, ['decrypt'])
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuffer(iv) }, cryptoKey, base64ToBuffer(data))
        return new TextDecoder().decode(decrypted)
    },

    async remove() {
        await browser.storage.local.remove([KEY_CREDENTIAL_ID, KEY_WRAPPING_KEY, KEY_ENCRYPTED_PASS])
    },
}
