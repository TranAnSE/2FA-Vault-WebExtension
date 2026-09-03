import { sendMessage } from 'webext-bridge/content-script'
import { qualifiesOtpField } from '../background/autofillMatch.js'

const OTP_FIELD_SELECTORS = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="2fa" i]',
    'input[name*="verification_code" i]',
    'input[name*="auth_code" i]',
    'input[name*="authenticator" i]',
    'input[placeholder*="one-time" i]',
    'input[placeholder*="otp" i]',
    'input[placeholder*="6-digit" i]',
    'input[type="text"][maxlength="6"]',
    'input[type="number"][maxlength="6"]',
    'input[inputmode="numeric"][maxlength="6"]',
    'input[type="text"][maxlength="8"]',
    'input[inputmode="numeric"][maxlength="8"]',
]

function scoreField(el, selector) {
    let score = 0
    if (el.getAttribute('autocomplete') === 'one-time-code') score += 100
    else if (selector.includes('name*="otp"') || selector.includes('name*="totp"')) score += 70
    else if (selector.includes('name*="2fa"') || selector.includes('name*="auth_code"')) score += 60
    else if (selector.includes('placeholder')) score += 40
    else if (selector.includes('maxlength')) score += 20
    if (['6', '8'].includes(el.getAttribute('maxlength'))) score += 10
    if (el.getAttribute('inputmode') === 'numeric') score += 10
    return score
}

function detectOtpFields() {
    const seen = new WeakSet()
    const fields = []
    for (const selector of OTP_FIELD_SELECTORS) {
        document.querySelectorAll(selector).forEach(el => {
            if (seen.has(el) || !isVisible(el)) return
            seen.add(el)
            // D8: a candidate only qualifies with autocomplete="one-time-code"
            // or form context + OTP heuristics (numeric inputmode, maxlength
            // 6-8). Free-standing text inputs are never auto-filled.
            if (!qualifiesOtpField(fieldSnapshot(el))) return
            fields.push({ element: el, confidence: scoreField(el, selector) })
        })
    }
    return fields.sort((a, b) => b.confidence - a.confidence)
}

/**
 * Attribute snapshot consumed by the shared qualifiesOtpField() predicate.
 */
function fieldSnapshot(el) {
    return {
        autocomplete: el.getAttribute('autocomplete'),
        inputmode: el.getAttribute('inputmode'),
        maxlength: el.getAttribute('maxlength'),
        type: el.getAttribute('type'),
        inForm: el.closest('form') !== null,
    }
}

function isVisible(el) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const style = window.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0
}

function fillOtpIntoField(element, otp) {
    element.focus()
    // Use native setter to trigger React/Vue/Angular form detection
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (nativeSetter) {
        nativeSetter.call(element, otp)
    } else {
        element.value = otp
    }
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    // Clear from DOM after 30 seconds
    setTimeout(() => { if (element.value === otp) element.value = '' }, 30000)
}

function showFillBadge(service, account) {
    const badge = document.createElement('div')
    badge.style.cssText = [
        'position:fixed',
        'bottom:20px',
        'right:20px',
        'background:#00d1b2',
        'color:#fff',
        'padding:10px 16px',
        'border-radius:8px',
        'font-size:13px',
        'font-family:sans-serif',
        'z-index:2147483647',
        'box-shadow:0 3px 12px rgba(0,0,0,0.25)',
        'pointer-events:none',
    ].join(';')
    // Use the extension i18n catalog so the autofill badge respects the
    // browser locale. Falls back to a generic message when no service matched.
    if (service && account) {
        // D9: several accounts matched this hostname — name the chosen one.
        badge.textContent = browser.i18n.getMessage('autofillBadgeFilledFor', [service, account])
            || browser.i18n.getMessage('autofillBadgeFilled', service)
    }
    else if (service) {
        badge.textContent = browser.i18n.getMessage('autofillBadgeFilled', service)
    }
    else {
        badge.textContent = browser.i18n.getMessage('autofillBadgeFilledGeneric')
    }
    document.body.appendChild(badge)
    setTimeout(() => badge.remove(), 3000)
}

let lastFillTime = 0
let fillInProgress = false
// D8: fields we already filled. Mutation-triggered re-fills only target
// these — untouched page fields are never auto-filled behind the user's back.
const filledFields = new WeakSet()

async function detectAndFill() {
    if (fillInProgress) return
    const now = Date.now()
    if (now - lastFillTime < 30000) return

    const fields = detectOtpFields()
    if (fields.length === 0) return

    // D8: once a fill happened on this page, only re-fill the fields we
    // filled ourselves (e.g. the site cleared them); never pick new ones.
    const candidates = filledFields.size > 0
        ? fields.filter(f => filledFields.has(f.element))
        : fields
    if (candidates.length === 0) return

    fillInProgress = true
    try {
        const response = await sendMessage('REQUEST_AUTO_FILL', {
            hostname: window.location.hostname,
        }, 'background')

        if (response?.otp) {
            fillOtpIntoField(candidates[0].element, response.otp)
            filledFields.add(candidates[0].element)
            showFillBadge(response.service, response.ambiguous ? response.account : null)
            lastFillTime = Date.now()
        }
    } catch {
        // Silent failure — vault locked or no matching account
    } finally {
        fillInProgress = false
    }
}

function debounce(fn, delay) {
    let timer
    return (...args) => {
        clearTimeout(timer)
        timer = setTimeout(() => fn(...args), delay)
    }
}

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',

    async main() {
        const stored = await browser.storage.local.get('local:settings')
        const settings = stored['local:settings']
        if (!settings?.autoFillEnabled) return

        await detectAndFill()

        // Watch for dynamic page changes (SPAs)
        const observer = new MutationObserver(debounce(() => detectAndFill(), 1000))
        observer.observe(document.body, { childList: true, subtree: true })
    },
})
