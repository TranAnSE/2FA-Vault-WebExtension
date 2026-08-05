import { describe, expect, it } from 'vitest'
import {
    getRegistrableDomain,
    calcAutoFillScore,
    matchAccountsToHostname,
} from './autofillMatch.js'

describe('getRegistrableDomain', () => {
    it('strips a leading www.', () => {
        expect(getRegistrableDomain('www.google.com')).toBe('google.com')
    })

    it('lowercases the host', () => {
        expect(getRegistrableDomain('MAIL.GitHub.COM')).toBe('github.com')
    })

    it('returns a two-label host unchanged', () => {
        expect(getRegistrableDomain('example.com')).toBe('example.com')
    })

    it('collapses a subdomain to the registrable domain', () => {
        expect(getRegistrableDomain('mail.google.com')).toBe('google.com')
        expect(getRegistrableDomain('login.accounts.example.co.uk')).toBe('example.co.uk')
    })

    it('returns "" for an empty host', () => {
        expect(getRegistrableDomain('')).toBe('')
        expect(getRegistrableDomain(undefined)).toBe('')
    })
})

describe('calcAutoFillScore', () => {
    it('rejects service names shorter than 3 characters (security)', () => {
        // A service named "it" must not match every *.it site.
        expect(calcAutoFillScore({ service: 'it' }, 'example.it')).toBe(0)
        expect(calcAutoFillScore({ service: 'go' }, 'go.example.com')).toBe(0)
    })

    it('scores 120 for an exact registrable-domain match', () => {
        expect(calcAutoFillScore({ service: 'github.com' }, 'github.com')).toBe(120)
        // Subdomain of the same registrable domain also matches via regDomain.
        expect(calcAutoFillScore({ service: 'github.com' }, 'gist.github.com')).toBe(120)
    })

    it('scores 100 when the service equals a non-regDomain suffix label of the host', () => {
        // The labels generated for a host are dot-delimited SUFFIXES, i.e. for
        // "a.b.example.com" they are ["a.b.example.com", "b.example.com",
        // "example.com", "com"]. regDomain = "example.com".
        //
        // A service that equals one of those suffixes but is NOT the registrable
        // domain scores 100 (the regDomain-equality case is the 120 tier above).
        expect(calcAutoFillScore({ service: 'b.example.com' }, 'a.b.example.com')).toBe(100)
        // When the service equals the host exactly, the 120 tier wins (it is
        // checked before the suffix-label tier).
        expect(calcAutoFillScore({ service: 'a.b.example.com' }, 'a.b.example.com')).toBe(120)
        // service is a deeper subdomain of the page's regDomain but NOT a
        // suffix of the host -> the 70 tier.
        expect(calcAutoFillScore({ service: 'login.example.com' }, 'example.com')).toBe(70)
    })

    it('scores 70 when the service is a deeper subdomain of the page', () => {
        // service "accounts.google.com" on page "google.com": the service is a
        // subdomain of the page's registrable domain.
        const score = calcAutoFillScore({ service: 'accounts.google.com' }, 'google.com')
        expect(score).toBe(70)
    })

    it('adds 30 when the account name matches a domain label', () => {
        // registrable match (120) + account label match (30).
        const score = calcAutoFillScore(
            { service: 'github.com', account: 'github' },
            'github.com',
        )
        expect(score).toBe(150)
    })

    it('returns 0 when nothing matches', () => {
        expect(calcAutoFillScore({ service: 'github.com' }, 'example.org')).toBe(0)
    })

    it('does not match a short service against a domain it is a substring of', () => {
        // "git" must not match "github.com" via substring — only equality/
        // label/regDomain comparisons are allowed.
        expect(calcAutoFillScore({ service: 'git' }, 'github.com')).toBe(0)
    })
})

describe('matchAccountsToHostname', () => {
    const accounts = [
        { id: 1, service: 'github.com', account: 'alice' },
        { id: 2, service: 'gitlab.com', account: 'alice' },
        { id: 3, service: 'AWS', account: 'root' }, // 'aws' matches nothing here
        { id: 4, service: 'it', account: 'x' },     // too short, never matches
    ]

    it('strips www. and ranks matches highest-confidence first', () => {
        // service 'github.com' matches the registrable domain of
        // 'www.github.com' (stripped to 'github.com') -> score 120.
        const matches = matchAccountsToHostname(accounts, 'www.github.com')
        expect(matches.length).toBe(1)
        expect(matches[0].account.id).toBe(1)
        expect(matches[0].score).toBe(120)
    })

    it('drops accounts that do not match', () => {
        const matches = matchAccountsToHostname(accounts, 'example.org')
        expect(matches).toHaveLength(0)
    })

    it('returns an empty list for an empty hostname', () => {
        const matches = matchAccountsToHostname(accounts, '')
        expect(matches).toHaveLength(0)
    })

    it('sorts multiple matches by descending score', () => {
        // Two services matching the same page at different tiers.
        const multi = [
            { id: 10, service: 'example.com', account: 'x' },         // 120
            { id: 11, service: 'login.example.com', account: 'x' },   // 70 (subdomain of page)
        ]
        const matches = matchAccountsToHostname(multi, 'example.com')
        expect(matches.map(m => m.account.id)).toEqual([10, 11])
    })
})
