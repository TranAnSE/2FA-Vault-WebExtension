/**
 * Sender-verification predicates for sensitive webext-bridge handlers.
 *
 * webext-bridge tags every message with a `sender.context` value
 * ('popup' | 'options' | 'content-script' | 'window' | 'devtools' |
 * 'background') and sets `sender.tabId` when the message originates from
 * a tab's content script. Sensitive handlers must verify the sender
 * context before acting:
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
 * @param {object} sender The webext-bridge sender Endpoint.
 * @returns {boolean}
 */
export function isExtensionPageSender(sender) {
    if (!sender) return false
    // Any tab-attached sender is a page context, even if it claims otherwise.
    if (sender.tabId != null || sender.tab != null) return false
    const context = sender.context
    return context === 'popup' || context === 'options'
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
