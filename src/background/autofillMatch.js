/**
 * Auto-fill account/domain matching for the browser extension.
 *
 * Decides which stored 2FA accounts are relevant to the page the user is
 * currently on, ranked by a confidence score. Pure logic — no `browser` API
 * access — so it can be unit-tested in isolation. background.js wires it into
 * the PAGE_ANALYZED / REQUEST_AUTO_FILL message handlers.
 *
 * SECURITY: Matching is based on registrable-domain equality and explicit
 * label containment — never the unsafe bidirectional
 * `domain.includes(service) || service.includes(domain)` test that would let
 * short service names ("it", "o", "go") match nearly any host.
 */

/**
 * Extract the registrable (eTLD+1) domain from a hostname.
 * Falls back to the host itself when extraction fails.
 *
 * SECURITY: We compare accounts against the registrable domain rather
 * than a raw substring test, so a service named "it" can no longer
 * match every `*.it` site, and a service named "google" no longer
 * matches every Google subdomain indiscriminately.
 *
 * @param {string} hostname - e.g. "mail.google.com"
 * @returns {string} e.g. "google.com"
 */
export function getRegistrableDomain(hostname) {
    const host = (hostname || '').replace(/^www\./, '').toLowerCase()
    if (!host) return ''

    // Simple suffix list covering the most common multi-part TLDs.
    // This avoids pulling in the full PSL; for the purpose of OTP
    // auto-fill matching, conservative is safer than exhaustive.
    const multiPartTlds = [
        '.co.uk', '.org.uk', '.gov.uk', '.ac.uk',
        '.co.jp', '.or.jp', '.ne.jp', '.ac.jp',
        '.com.au', '.net.au', '.org.au',
        '.co.nz', '.co.kr', '.co.in', '.org.in', '.net.in',
        '.com.br', '.com.cn', '.com.tw', '.com.hk', '.com.sg',
        '.co.za', '.com.mx', '.com.ar',
    ]
    for (const suffix of multiPartTlds) {
        if (host.endsWith(suffix)) {
            const before = host.slice(0, -suffix.length)
            const parts = before.split('.')
            return parts[parts.length - 1] + suffix
        }
    }
    const parts = host.split('.')
    if (parts.length <= 2) return host
    return parts.slice(-2).join('.')
}

/**
 * Score how strongly an account matches the current page domain.
 *
 * Scoring tiers:
 *   - exact registrable-domain match:      120
 *   - service equals a full host label:    100
 *   - service equals a dot-delimited part:  70
 *   - account name contains domain label:   30
 *
 * @param {{service?: string, account?: string}} account
 * @param {string} domain  The page hostname (www. stripped, lowercased).
 * @returns {number}
 */
export function calcAutoFillScore(account, domain) {
    const service = (account.service || '').toLowerCase().trim()
    const accountName = (account.account || '').toLowerCase().trim()
    const regDomain = getRegistrableDomain(domain)

    // Reject too-short service names entirely — they match too much.
    if (service.length < 3) return 0

    let score = 0

    if (service) {
        if (regDomain && service === regDomain) {
            score += 120
        } else if (domain === service) {
            score += 120
        } else {
            // Compare service against full dot-delimited labels of the
            // host, e.g. for "login.example.com" the labels are
            // ["login", "com", "example.com", "login.example.com"].
            const labels = []
            const parts = domain.split('.')
            for (let i = 0; i < parts.length; i++) {
                labels.push(parts.slice(i).join('.'))
            }
            if (labels.includes(service)) {
                score += 100
            } else if (regDomain && service.endsWith('.' + regDomain)) {
                // service is a deeper subdomain of the page, e.g.
                // service "accounts.google.com" on page "google.com".
                score += 70
            }
        }
    }
    if (accountName && accountName.length >= 3 && domain.split('.').includes(accountName)) {
        score += 30
    }

    return score
}

/**
 * Rank accounts by how strongly they match a page hostname.
 *
 * @param {Array<{service?: string, account?: string}>} accounts
 * @param {string} hostname  The raw page hostname (www. is stripped here).
 * @returns {Array<{account: object, score: number}>}  Matches with score > 0,
 *   sorted highest-confidence first.
 */
export function matchAccountsToHostname(accounts, hostname) {
    const domain = (hostname || '').replace(/^www\./, '').toLowerCase()

    return accounts
        .map(account => ({
            account,
            score: calcAutoFillScore(account, domain),
        }))
        .filter(m => m.score > 0)
        .sort((a, b) => b.score - a.score)
}
