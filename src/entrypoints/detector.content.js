/**
 * detector.content.js — lightweight page analysis content script.
 * Runs on every page, detects login/2FA forms, and notifies the background
 * to update the extension badge and pre-compute matching accounts.
 * Must be <10ms to avoid page performance impact.
 */
import { sendMessage } from 'webext-bridge/content-script'

const LOGIN_FIELD_SELECTORS = [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[autocomplete="new-password"]',
]

const OTP_FIELD_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="2fa" i]',
    'input[name*="code" i]',
    'input[type="text"][maxlength="6"]',
    'input[inputmode="numeric"][maxlength="6"]',
]

function hasVisibleField(selectors) {
    for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) return true
        }
    }
    return false
}

function analyze() {
    return {
        hasLoginForm: hasVisibleField(LOGIN_FIELD_SELECTORS),
        has2FAForm:   hasVisibleField(OTP_FIELD_SELECTORS),
        hostname:     window.location.hostname,
        href:         window.location.href,
    }
}

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',

    async main() {
        const result = analyze()
        // Only notify background if there's something interesting
        if (result.hasLoginForm || result.has2FAForm) {
            try {
                await sendMessage('PAGE_ANALYZED', result, 'background')
            } catch {
                // Ignore — background may not be ready
            }
        }

        // Re-analyze on significant DOM changes (for SPAs)
        let lastState = result.hasLoginForm || result.has2FAForm
        const observer = new MutationObserver(() => {
            const current = analyze()
            const newState = current.hasLoginForm || current.has2FAForm
            if (newState !== lastState) {
                lastState = newState
                if (newState) {
                    sendMessage('PAGE_ANALYZED', current, 'background').catch(() => {})
                }
            }
        })
        observer.observe(document.body, { childList: true, subtree: true })
    },
})
