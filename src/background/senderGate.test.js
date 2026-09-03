import { describe, expect, it } from 'vitest'
import { isExtensionPageSender, isContentScriptSender } from './senderGate.js'

describe('senderGate', () => {
    describe('isExtensionPageSender', () => {
        it('accepts popup and options contexts without a tab', () => {
            expect(isExtensionPageSender({ context: 'popup' })).toBe(true)
            expect(isExtensionPageSender({ context: 'options' })).toBe(true)
        })

        it('rejects content-script senders even with a popup-ish context', () => {
            expect(isExtensionPageSender({ context: 'content-script', tabId: 12 })).toBe(false)
        })

        it('rejects tab-attached senders regardless of context', () => {
            // A compromised page must not gain trust by spoofing context.
            expect(isExtensionPageSender({ context: 'popup', tabId: 7 })).toBe(false)
            expect(isExtensionPageSender({ context: 'popup', tab: { id: 7 } })).toBe(false)
        })

        it('rejects window, devtools, background and unknown senders', () => {
            expect(isExtensionPageSender({ context: 'window' })).toBe(false)
            expect(isExtensionPageSender({ context: 'devtools' })).toBe(false)
            expect(isExtensionPageSender({ context: 'background' })).toBe(false)
            expect(isExtensionPageSender({})).toBe(false)
            expect(isExtensionPageSender(null)).toBe(false)
            expect(isExtensionPageSender(undefined)).toBe(false)
        })
    })

    describe('isContentScriptSender', () => {
        it('accepts content-script senders with a tab', () => {
            expect(isContentScriptSender({ context: 'content-script', tabId: 3 })).toBe(true)
            expect(isContentScriptSender({ context: 'content-script', tab: { id: 3 } })).toBe(true)
        })

        it('rejects content-script context without a tab', () => {
            expect(isContentScriptSender({ context: 'content-script' })).toBe(false)
        })

        it('rejects non-content-script contexts', () => {
            expect(isContentScriptSender({ context: 'popup' })).toBe(false)
            expect(isContentScriptSender({ context: 'window', tabId: 3 })).toBe(false)
            expect(isContentScriptSender(null)).toBe(false)
        })
    })
})
