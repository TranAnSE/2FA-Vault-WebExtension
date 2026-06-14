# Change log

## [1.2.1] - 2026-06-14

### Added

- TOTP Countdown Badge: the extension badge now shows the remaining seconds for the current one-time password of the active account, refreshed via an alarm-based countdown. Pairs with the existing account-count badge.
- Global Copy-OTP Keyboard Shortcut: `Ctrl+Shift+Y` copies the current OTP of the active account to the clipboard from any page, implemented through the commands API with an offscreen document relay (MV3 service-worker safe).

### Known Issues

- `npm run build` fails due to a stale `@2fauth/ui` dist in `2FA-Vault-Components` (missing `StackLayout` export). Pre-existing and unrelated to this release; tracked in the components repo.

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
