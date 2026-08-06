import { describe, expect, it } from 'vitest'
import { remainingSeconds, resolveBadgeAppearance } from './badge.js'

describe('remainingSeconds', () => {
    it('defaults the period to 30 when missing or invalid', () => {
        // At t=0 with period 30 -> 30s remain.
        expect(remainingSeconds({}, () => 0)).toBe(30)
        expect(remainingSeconds({ period: 0 }, () => 0)).toBe(30)
        expect(remainingSeconds({ period: 'abc' }, () => 0)).toBe(30)
        expect(remainingSeconds(null, () => 0)).toBe(30)
    })

    it('honours an explicit period', () => {
        // period 60 at t=0 -> 60s; at t=10 -> 50s; at t=70 -> 50s (wraps).
        expect(remainingSeconds({ period: 60 }, () => 0)).toBe(60)
        expect(remainingSeconds({ period: 60 }, () => 10_000)).toBe(50)
        expect(remainingSeconds({ period: 60 }, () => 70_000)).toBe(50)
    })

    it('computes the seconds remaining in the current window', () => {
        // period 30: at t=0 -> 30; t=5 -> 25; t=29 -> 1; t=30 -> 30 (wrapped).
        expect(remainingSeconds({ period: 30 }, () => 0)).toBe(30)
        expect(remainingSeconds({ period: 30 }, () => 5_000)).toBe(25)
        expect(remainingSeconds({ period: 30 }, () => 29_000)).toBe(1)
        expect(remainingSeconds({ period: 30 }, () => 30_000)).toBe(30)
    })

    it('never returns 0 or a negative value (always >= 1)', () => {
        // Right at a period boundary the result wraps to the full period.
        for (let t = 0; t < 60_000; t += 1000) {
            const r = remainingSeconds({ period: 30 }, () => t)
            expect(r).toBeGreaterThanOrEqual(1)
            expect(r).toBeLessThanOrEqual(30)
        }
    })
})

describe('resolveBadgeAppearance', () => {
    it('returns empty text when count is 0', () => {
        const a = resolveBadgeAppearance(0, 0)
        expect(a.text).toBe('')
    })

    it('uses red when urgency is at most 5 seconds', () => {
        expect(resolveBadgeAppearance(1, 0).color).toBe('#ef4444')
        expect(resolveBadgeAppearance(2, 5).color).toBe('#ef4444')
    })

    it('uses amber when urgency is between 6 and 10 seconds', () => {
        expect(resolveBadgeAppearance(1, 6).color).toBe('#f59e0b')
        expect(resolveBadgeAppearance(1, 10).color).toBe('#f59e0b')
    })

    it('uses green when urgency exceeds 10 seconds', () => {
        expect(resolveBadgeAppearance(1, 11).color).toBe('#22c55e')
        expect(resolveBadgeAppearance(3, 25).color).toBe('#22c55e')
    })

    it('stringifies the count for the badge text', () => {
        expect(resolveBadgeAppearance(7, 8).text).toBe('7')
    })
})
