# Change log

## [1.3.2] - 2026-09-12

### Fixed

- Setup now strips trailing slashes from the 2FA-Vault server URL before validation and persistence (upstream 2FAuth-WebExtension v1.3.1 pattern, Bubka/2FAuth#565): entering `https://vault.example.com///` no longer produces broken `///api/v1` API base URLs. Subfolder installs (e.g. `https://host/2fauth/`) keep their path-internal slashes.

## [1.3.1] - 2026-09-03

### Security

- **Regression fix (from 1.3.0)**: runtime secrets (PAT, derived key) live in `browser.storage.session` / memory only, and `loadState()` no longer wipes the in-memory PAT on every lock-state check — the 1.3.0 "stop persisting plaintext secrets" change made a password-protected extension unusable (unlock -> 401 -> Unauthorized loop, dead copy-OTP shortcut and auto-fill). Every lock transition (kickAfter expiry, `onStartup`, popup close, reset) clears the session copy.
- All sensitive webext-bridge handlers now verify the sender: `UNLOCK`, `SET_PASSWORD`, `CHANGE_PASSWORD`, `RESET_EXT`, `ENCRYPT_PAT`, `CAPTURE_SCREENSHOT`, `GET_PAT*`, `SYNC_ACCOUNTS_METADATA` accept extension-page senders only; `REQUEST_AUTO_FILL` and `PAGE_ANALYZED` accept content-script senders only.
- The brute-force lockout counters are rehydrated from storage before the gates in `unlockExt()`/`checkPassword()`, so a suspended service worker no longer resets the backoff.
- "Change password" aborts when the in-memory PAT is empty instead of overwriting the stored token with the encryption of an empty string.
- Auto-fill only fills fields that look like OTP inputs (`autocomplete="one-time-code"` or inside a `<form>` with OTP-ish attributes), tracks the fields it filled, and re-fills only those — a page can no longer harvest a continuous OTP stream from arbitrary 6/8-char inputs.
- The E2EE vault key is never written to durable storage (session/memory only; the `storage.local` fallback is gone).
- `http://` server URLs are rejected for public hosts (localhost and private/link-local ranges stay allowed).

### Changed

- Auto-lock survives extension/browser updates (the alarm is re-armed from the persisted `lastActiveAt` instead of being cleared).
- MV3 QR capture falls back to the MV2-style notification+badge when programmatic `openPopup()` fails, and the captured image survives service-worker suspension via session storage.
- Ambiguous auto-fill matches name the account used in the toast; per-tab badges are cleared on navigation, zero-matches and lock.
- QR-scan feedback works from the Start view; `IS_THERE_QR` tolerates tabs without a content script; the dead biometric enrollment path is removed.

### Fixed

- `checkPassword()` loads the crypto params before deriving (cold service worker no longer fails every password).
- Double-scan races no longer permanently pollute page styles; the detector observer is debounced; icon/dark-scheme promise chains gained `.catch` handlers.

### Tests

- 43 -> 70 unit tests (`sessionSecrets`, `senderGate`, `validators`, `autofillMatch` qualification, lockout cold-SW rehydration).

## [1.3.0] - 2026-08-08

### Security

- `GET_PAT` / `GET_PARTIAL_PAT` webext-bridge handlers now reject any sender whose context is not `popup`/`options`, closing a path by which a compromised page reaching a content-script context could exfiltrate the raw PAT.
- PAT-at-rest key derivation raised from PBKDF2/100k to PBKDF2/600k iterations (OWASP 2023+). Backward-compatible: existing ciphertext stays decryptable via the persisted iteration count; re-encrypting upgrades to 600k. Argon2id was ruled out for the MV3 service worker due to WASM memory constraints (see SECURITY.md).
- Localized the service-worker copy-OTP notifications and the auto-fill badge via `browser.i18n.getMessage` (7 new message keys).

### Changed

- Refactored four security-sensitive modules out of the 1661-line `background.js` into testable factories under `src/background/`: `lockout.js`, `autofillMatch.js`, `badge.js`, `crypto.js`. The stateful wrappers stay inline.
- Added Vitest + jsdom (no test runner existed before); 42 unit tests now cover the extracted modules.

### Fixed

- `package.json` version now matches the changelog (was 1.2.0; the 1.2.1 features shipped without the version bump).
- The previous "stale `@2fauth/ui` dist (missing `StackLayout`)" known issue is resolved.

## [1.2.1] - 2026-06-14

### Added

- TOTP Countdown Badge: the extension badge now shows the remaining seconds for the current one-time password of the active account, refreshed via an alarm-based countdown. Pairs with the existing account-count badge.
- Global Copy-OTP Keyboard Shortcut: `Ctrl+Shift+Y` copies the current OTP of the active account to the clipboard from any page, implemented through the commands API with an offscreen document relay (MV3 service-worker safe).

### Fixed

- `package.json` version now matches the changelog (was 1.2.0; the 1.2.1 features shipped without the version bump).
- The previous "stale `@2fauth/ui` dist (missing `StackLayout`)" known issue is resolved — the components repo now builds the dist on demand and the export is present.

## [1.2.0] - 2026-02-27

### Added

- QR Code Capture: The extension can now detect and read QR codes on the active web page to ease 2FA registration. Once decoded, the underlying 2FA data is automatically added to your 2FA-Vault account. ([#410](https://github.com/TranAnSE/2FA-Vault/issues/410))
- Translations for all supported languages in 2FA-Vault.
- The Group-less filter.

### Changed

- The Chrome/Edge extension no longer runs in the background after the browser has been closed.

### Fixed

- [issue #461](https://github.com/TranAnSE/2FA-Vault/issues/461) l.forEach is not a function
- [issue #491](https://github.com/TranAnSE/2FA-Vault/issues/491) e.value.filter & t.value.find is not a function
- [issue #512](https://github.com/TranAnSE/2FA-Vault/issues/512) Unauthorized Data cannot be refreshed from server

## [1.1.2] - 2025-07-04

### Changed

- The extension is now built using the brand new [2FA-Vault component libraries](https://github.com/TranAnSE/2FA-Vault-Components). These libraries contain the common front-end components used by the web extension and web app.
- Requests receiving a 401 unauthorized response from the server now push the user to a dedicated view (instead of displaying a notification) with the ability to reset the extension from this view. This should eliminate the need to uninstall and reinstall the extension when locked out due to an invalid token.
- The error view now displays the reason why an error has occured (when available)

### Fixed

- The 'All' group label does not update dynamically when browser language changes
- Blank popup right after extension reset

## [1.1.1] - 2025-04-09

### Fixed

- Possible lock-out if something goes wrong when the setup form is submitted
- The banner informing about preferences being managed by the administrator is no longer visible if locked preferences are not used in the extension.

## [1.1.0] - 2025-04-07

### Added

- A user preference to enable precalculation and display of the next OTP code. __Requires 2FA-Vault `v5.5.0`__  
  Don't be surprised if you don't see the next code right after enabling this option, the code fades in slowly in order to maintain good readability of the current code.
- The extension now starts searching as soon as the user starts typing, without having to explicitly give focus to the search field

### Changed

- The user preferences enforced by the server administrator are now applied. __Requires 2FA-Vault `v5.5.0`__

### Fixed

- [issue #453](https://github.com/TranAnSE/2FA-Vault/issues/453), [issue #459](https://github.com/TranAnSE/2FA-Vault/issues/459) Various errors that caused the extension to remain locked

## [1.0.2] - 2025-02-14

### Changed

- The `tabs` extension permission in no longer requested

## [1.0.1] - 2025-02-13

### Fixed

- Popup icon not matching the system color scheme

## [1.0.0] - 2025-02-04

First release
