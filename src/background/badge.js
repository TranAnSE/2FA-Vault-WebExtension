/**
 * Toolbar badge helpers for the browser extension.
 *
 * The stateful parts (reading cached accounts from storage, calling the
 * action API) stay in background.js. The pure pieces — computing remaining
 * TOTP seconds and resolving the badge appearance (text + urgency color) —
 * live here so they can be unit-tested in isolation.
 */

/**
 * Remaining seconds before the account's TOTP rotates.
 *
 * @param {object} account  Account with an optional `period` (seconds).
 * @param {() => number} [nowMs]  Time source for deterministic tests;
 *   defaults to Date.now().
 * @returns {number}  Seconds in [1, period].
 */
export function remainingSeconds(account, nowMs = Date.now) {
    const period = Number(account?.period) > 0 ? Number(account.period) : 30
    return period - (Math.floor(nowMs() / 1000) % period)
}

/**
 * Resolve the badge text and background color from a count of expiring
 * accounts and the most-urgent remaining-seconds value.
 *
 * Color tiers:
 *   - red   (#ef4444) when urgency <= 5s
 *   - amber (#f59e0b) when urgency <= 10s
 *   - green (#22c55e) otherwise
 *
 * @param {number} count     Number of accounts expiring within the window.
 * @param {number} urgency   Smallest remaining-seconds among them.
 * @returns {{text: string, color: string}}  Empty text when count is 0.
 */
export function resolveBadgeAppearance(count, urgency) {
    const text = count > 0 ? String(count) : ''
    const color = urgency <= 5 ? '#ef4444' : urgency <= 10 ? '#f59e0b' : '#22c55e'
    return { text, color }
}
