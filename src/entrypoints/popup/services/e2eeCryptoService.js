import argon2 from 'argon2-browser/dist/argon2-bundled.min.js'

const ARGON2_CONFIG = {
    time: 3,
    mem: 65536,
    hashLen: 32,
    parallelism: 1,
    type: argon2.ArgonType.Argon2id,
}

const AES_CONFIG = {
    name: 'AES-GCM',
    tagLength: 128,
}

const decoder = new TextDecoder()

export async function deriveVaultKey(masterPassword, salt) {
    const result = await argon2.hash({
        pass: masterPassword,
        salt: typeof salt === 'string' ? base64ToBytes(salt) : salt,
        ...ARGON2_CONFIG,
    })

    return crypto.subtle.importKey(
        'raw',
        result.hash,
        { name: AES_CONFIG.name },
        true,
        ['encrypt', 'decrypt']
    )
}

export async function decryptSecret(encryptedData, key) {
    const ciphertext = base64ToBytes(encryptedData.ciphertext)
    const iv = base64ToBytes(encryptedData.iv)
    const authTag = base64ToBytes(encryptedData.authTag)
    const combined = new Uint8Array(ciphertext.length + authTag.length)
    combined.set(ciphertext)
    combined.set(authTag, ciphertext.length)

    const plaintext = await crypto.subtle.decrypt(
        { name: AES_CONFIG.name, iv, tagLength: AES_CONFIG.tagLength },
        key,
        combined
    )

    return decoder.decode(plaintext)
}

export async function verifyVaultKey(encryptedTestValue, key) {
    const encryptedData = typeof encryptedTestValue === 'string'
        ? JSON.parse(encryptedTestValue)
        : encryptedTestValue

    return decryptSecret(encryptedData, key).then(
        () => true,
        () => false
    )
}

export async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key)

    return bytesToBase64(new Uint8Array(raw))
}

export async function importKey(rawKey) {
    return crypto.subtle.importKey(
        'raw',
        base64ToBytes(rawKey),
        { name: AES_CONFIG.name },
        false,
        ['encrypt', 'decrypt']
    )
}

export function decryptAccount(account, key) {
    if (!account.encrypted) {
        return Promise.resolve(account)
    }

    return decryptSecret(JSON.parse(account.secret), key).then(secret => ({
        ...account,
        secret,
    }))
}

export function base64ToBytes(base64) {
    const binString = atob(base64)
    return Uint8Array.from(binString, char => char.charCodeAt(0))
}

export function bytesToBase64(bytes) {
    const binString = Array.from(bytes, byte => String.fromCharCode(byte)).join('')
    return btoa(binString)
}
