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
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

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

export async function generateTotp(secret, timestamp = Date.now(), options = {}) {
    const algorithm = normalizeHmacAlgorithm(options.algorithm)
    const digits = Number(options.digits ?? 6)
    const period = Number(options.period ?? 30)
    const counter = Math.floor(Math.floor(timestamp / 1000) / period)

    return generateHotp(secret, counter, { algorithm, digits, period, timestamp })
}

export async function generateHotp(secret, counter, options = {}) {
    const algorithm = normalizeHmacAlgorithm(options.algorithm)
    const digits = Number(options.digits ?? 6)
    const period = Number(options.period ?? 30)
    const timestamp = options.timestamp ?? Date.now()
    const secretBytes = base32ToBytes(secret)
    const counterBytes = counterToBytes(Number(counter ?? 0))
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        secretBytes,
        { name: 'HMAC', hash: algorithm },
        false,
        ['sign']
    )
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBytes))
    const offset = signature[signature.length - 1] & 0x0f
    const binary = (
        ((signature[offset] & 0x7f) << 24) |
        ((signature[offset + 1] & 0xff) << 16) |
        ((signature[offset + 2] & 0xff) << 8) |
        (signature[offset + 3] & 0xff)
    )
    const password = String(binary % (10 ** digits)).padStart(digits, '0')

    return {
        password,
        otp_type: options.otpType ?? 'totp',
        generated_at: Math.floor(timestamp / 1000),
        period,
        counter: Number(counter ?? 0) + 1,
    }
}

function normalizeHmacAlgorithm(algorithm = 'sha1') {
    const normalized = String(algorithm).toLowerCase().replace('-', '')

    if (normalized === 'sha1') {
        return 'SHA-1'
    }
    if (normalized === 'sha256') {
        return 'SHA-256'
    }
    if (normalized === 'sha512') {
        return 'SHA-512'
    }

    return String(algorithm).toUpperCase()
}

function base32ToBytes(encoded) {
    const normalized = encoded.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '')
    let bits = 0
    let value = 0
    const output = []

    for (const char of normalized) {
        const index = BASE32_ALPHABET.indexOf(char)

        if (index === -1) {
            continue
        }

        value = (value << 5) | index
        bits += 5

        if (bits >= 8) {
            output.push((value >>> (bits - 8)) & 0xff)
            bits -= 8
        }
    }

    return new Uint8Array(output)
}

function counterToBytes(counter) {
    const bytes = new Uint8Array(8)
    let value = BigInt(counter)

    for (let index = 7; index >= 0; index -= 1) {
        bytes[index] = Number(value & 0xffn)
        value >>= 8n
    }

    return bytes
}

export function formatOtpResponse(account, otp) {
    return {
        password: otp.password,
        otp_type: account.otp_type,
        generated_at: otp.generated_at,
        period: Number(account.period ?? otp.period ?? 30),
        counter: account.otp_type === 'hotp' ? otp.counter : null,
        next_password: otp.next_password,
        uri: account.uri,
    }
}
