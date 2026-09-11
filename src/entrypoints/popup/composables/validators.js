export function isFilled(value) {
	return value?.toString().length > 0
}

export function isHttpUrl(value) {
	return value?.toString().startsWith('http://') || value.startsWith('https://')
}

/**
 * Strip trailing slashes from a host URL (upstream 2FAuth-WebExtension v1.3.1,
 * Bubka/2FAuth#565): `https://host///` must not produce `///api/v1` base URLs.
 * Only trailing slashes are removed — path-internal slashes (subfolder
 * installs like `https://host/2fauth/`) survive intact.
 *
 * @param {string} value
 * @returns {string}
 */
export function removeTrailingSlashes(value) {
	return (value?.toString() ?? '').replace(/\/+$/, '')
}

/**
 * Whether the hostname is a local/private host for which plain HTTP is
 * an acceptable transport (RT8 / audit D17): localhost and *.localhost,
 * loopback (127.0.0.0/8, ::1), RFC1918 (10/8, 172.16/12, 192.168/16)
 * and link-local (169.254/16, fe80::/10) ranges.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHost(hostname) {
	const host = (hostname || '').toLowerCase().replace(/\.$/, '')
	if (!host) return false

	if (host === 'localhost' || host.endsWith('.localhost')) return true
	if (host === '::1' || host === '[::1]') return true
	if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return true
	if (host.startsWith('127.')) return true

	// Dotted-decimal check (first octet must be fully numeric).
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
	const octets = host.split('.').map(Number)
	const [a, b] = octets
	if (a === 10) return true
	if (a === 192 && b === 168) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 169 && b === 254) return true
	return false
}

/**
 * Whether the URL uses plain http:// against a PUBLIC host, which must be
 * rejected (credentials would transit in clear text). Local/private hosts
 * are allowed (self-hosted LAN instances).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isInsecureHttpUrl(value) {
	if (!value?.toString().startsWith('http://')) return false

	let hostname
	try {
		hostname = new URL(value.toString()).hostname
	} catch {
		return true // unparseable http URL — treat as insecure
	}

	return !isPrivateHost(hostname)
}
