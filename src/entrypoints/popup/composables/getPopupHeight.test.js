import { describe, expect, it, vi } from 'vitest'
import { getPopupHeight } from './getPopupHeight'

describe('getPopupHeight', () => {
    function stubWindow({ innerHeight, availHeight }) {
        vi.stubGlobal('window', {
            innerHeight,
            screen: { availHeight },
        })
    }

    it('uses the screen height (minus the browser-chrome offset) when it is the binding constraint', () => {
        // small screen: 700 - 100 = 600 -> exactly MAX_EXT_HEIGHT, so the
        // screen branch wins (not < MAX) — use a smaller one
        stubWindow({ innerHeight: 900, availHeight: 650 })
        expect(getPopupHeight()).toBe(550)
    })

    it('uses window.innerHeight to support browser zoom on tall screens', () => {
        stubWindow({ innerHeight: 480, availHeight: 2000 })
        expect(getPopupHeight()).toBe(480)
    })

    it('caps at MAX_EXT_HEIGHT through the screen branch on short screens', () => {
        // zoom > 100% can report an innerHeight taller than the real estate:
        // the screen height (with its 100px offset) clamps it
        stubWindow({ innerHeight: 900, availHeight: 600 })
        expect(getPopupHeight()).toBe(500)
    })

    it('prefers the screen branch when it sits exactly at the 600px ceiling minus offset', () => {
        stubWindow({ innerHeight: 900, availHeight: 700 })
        // 700 - 100 = 600, NOT < 600 -> innerHeight branch
        expect(getPopupHeight()).toBe(900)
    })

    it('restores the global window after each test', () => {
        vi.unstubAllGlobals()
        expect(typeof getPopupHeight).toBe('function')
    })
})
