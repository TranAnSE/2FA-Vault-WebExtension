# Security notes — 2FA-Vault WebExtension

This document records the extension-specific security model and the
hardening applied in the v1.3.0 sweep. For the overall product threat
model, see the main app's `docs/development/security-guidelines.md`.

## PAT storage

The Personal Access Token (PAT) is the long-lived bearer token the
extension uses to call `/api/v1`. It is **never stored in plaintext**:

- Encrypted at rest with AES-256-GCM.
- Key derived from the user-chosen extension password via PBKDF2-HMAC-SHA-256.
- A random 16-byte salt and per-encryption 12-byte IV are persisted
  alongside the ciphertext in `browser.storage.local` under the crypto store.
- When the user has **not** set a password, a default key is used and the
  extension auto-unlocks. This is a convenience trade-off, not a secret.

## KDF iteration count

The extension uses PBKDF2-HMAC-SHA-256 (not Argon2id, which the main app
uses — Argon2id WASM in an MV3 service worker is impractical due to
service-worker memory constraints).

- **New encryption (v1.3.0+):** 600,000 iterations (OWASP 2023+
  recommendation for PBKDF2-SHA-256).
- **Legacy ciphertext (pre-v1.3.0):** 100,000 iterations. The count is
  persisted alongside the ciphertext, so existing installs keep decrypting
  correctly. Re-encrypting (via "change password" or re-setup) upgrades the
  count to 600,000.

This means upgrading the extension never locks users out, and every fresh
encryption gets the stronger parameter set.

## Brute-force protection

The extension enforces its own brute-force lockout on the unlock screen:

- After 5 failed unlock attempts, exponential backoff kicks in.
- The delay is capped at 5 minutes.
- The lockout counter persists across service-worker restarts
  (`browser.storage.local`), so closing/reopening the popup does not reset it.

## `GET_PAT` / `GET_PARTIAL_PAT` sender verification

The `GET_PAT` and `GET_PARTIAL_PAT` webext-bridge handlers gate on the
message `sender.context`. Only the extension's own UI contexts
(`'popup'`, `'options'`) may retrieve the PAT. Content-script, window, and
devtools contexts are rejected with a `{ status: false }` response and
no token is returned.

This prevents a page that reaches a content-script execution context
(e.g. via an XSS on a page where a content script is injected) from
exfiltrating the raw PAT through the message bus.

## Deep-link / URI-scheme posture (CVE-2026-26123 lesson)

The Microsoft Authenticator deep-link hijack (CVE-2026-26123) exploited a
custom URI scheme (`ms-msa://`) that any app on the device could register,
allowing interception of OTP codes passed via OS-level dispatch.

2FA-Vault's extension is **not vulnerable to this class**:

- The extension registers **no custom URI scheme** (no `protocol_handlers`
  in the manifest).
- The extension declares **no `externally_connectable`** hosts, so websites
  cannot message the service worker directly.
- There are **no `webNavigation`/`webRequest` auto-action listeners** that
  would act on navigation to `otpauth://`.
- The only `otpauth://` ingestion paths are **user-initiated**: the QR
  capture feature (the user explicitly triggers a screenshot scan) and
  manual entry. Secrets are never dispatched through an OS-level ambiguous
  URI handler.

The QR capture flow validates the originating tab via the webext-bridge
`sender.tabId` and only processes decoded data after the user confirms.

## Reporting

Report extension security issues privately (do not open a public issue).
See the main app's `docs/development/security-guidelines.md` for the
responsible-disclosure process.
