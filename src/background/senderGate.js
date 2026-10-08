/**
 * Sender-verification predicates for sensitive webext-bridge handlers.
 *
 * webext-bridge tags every message with a `sender.context` value
 * ('popup' | 'options' | 'content-script' | 'window' | 'devtools' |
 * 'background') and resolves `sender.tab` lazily from the port link for
 * tab-attached senders. Sensitive handlers must verify the sender context
 * before acting:
 *
 * - extension-page-only handlers (password/PAT mutations, screenshots)
 *   accept only popup/options senders with no tab attached;
 * - content-script-only handlers (auto-fill, page analysis) accept only
 *   our content-script channel with a tab attached.
 *
 * Unknown/unmatched senders are rejected by the callers.
 */

/**
 * Whether the sender is one of the extension's own UI pages (popup/options)
 * and NOT a tab context. Used for handlers that mutate or reveal secrets.
 *
 * E2E harness builds (`wxt build -m e2e`, npm run build:e2e) accept the
 * claimed popup/options context even when a tab is attached: the Playwright
 * harness (2FA-Vault tests/e2e/webextension/) must drive popup.html in a
 * regular tab because Playwright cannot open the toolbar popup, and the
 * lazily-resolved sender.tab then makes every sender look tab-attached.
 * Content scripts claim context 'content-script' and never reach the
 * popup/options branch, so they stay rejected in e2e builds too. Shipped
 * (production/development) builds keep the strict tab check.
 *
 * @param {object} sender The webext-bridge sender Endpoint.
 * @returns {boolean}
 */
export function isExtensionPageSender(sender) {
    if (!sender) return false
    const context = sender.context
    if (context !== 'popup' && context !== 'options') return false
    if (import.meta.env?.MODE === 'e2e') return true
    return sender.tabId == null && sender.tab == null
}

/**
 * Whether the sender is one of our content scripts running in a tab.
 * Used for handlers driven by page content (auto-fill, page analysis).
 *
 * @param {object} sender The webext-bridge sender Endpoint.
 * @returns {boolean}
 */
export function isContentScriptSender(sender) {
    if (!sender) return false
    if (sender.context !== 'content-script') return false
    return sender.tabId != null || sender.tab != null
}
