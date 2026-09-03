import { onMessage, sendMessage } from 'webext-bridge/background'
import { createLockout } from '../background/lockout.js'
import {
    getRegistrableDomain,
    calcAutoFillScore,
    matchAccountsToHostname,
} from '../background/autofillMatch.js'
import { createRuntimeSecrets, resolveRuntimePat } from '../background/sessionSecrets.js'
import { isExtensionPageSender, isContentScriptSender } from '../background/senderGate.js'
import {
    deriveKey as deriveKeyRaw,
    encryptAesGcm,
    decryptAesGcm,
    fromUint8Array,
    KDF_ITERATIONS_LEGACY,
    KDF_ITERATIONS_CURRENT,
} from '../background/crypto.js'
import { remainingSeconds, resolveBadgeAppearance } from '../background/badge.js'

export default defineBackground({

    persistent: false,
    type: 'module', // see https://wxt.dev/guide/essentials/es-modules.html#background

    main() {

        const CRYPTO_STORE = 'cryptoStore'
        const EXTSTATE_STORE = 'extstateStore'
        const PREFERENCE_STORE = 'preferences'

        const encoder = new TextEncoder()
        const cryptoApi = (typeof window === "undefined") ? crypto : window.crypto

        const default_state = {
            isLoaded: false,
            locked: false,
            lastActiveAt: null,
            kickAfter: null,
            pat: '',
            lastViewedAccountId: null
        }

        // --- Brute-force protection for password-gated operations --------
        // The state machine lives in src/background/lockout.js so it can be
        // unit-tested in isolation; the background wires it up against the
        // real browser.storage.local. Thin wrappers below keep the existing
        // call sites (loadLockout/getLockoutRemainingMs/recordFailedAttempt/
        // resetLockout) unchanged.
        const lockoutController = createLockout({ storage: browser.storage.local })

        // MARK: Runtime secrets (D1/D6) — the decrypted PAT lives in
        // service-worker memory, mirrored to browser.storage.session
        // (memory-backed, survives SW suspension, cleared on browser
        // restart) where available. It is NEVER written to storage.local.
        const runtimeSecrets = createRuntimeSecrets({ sessionStorage: browser.storage.session ?? null })

        function loadLockout() {
            return lockoutController.load()
        }

        /**
         * Returns 0 if an attempt is allowed now, otherwise the ms remaining
         * until the next attempt is permitted.
         */
        function getLockoutRemainingMs() {
            return lockoutController.getRemainingMs()
        }

        function recordFailedAttempt() {
            return lockoutController.recordFailed()
        }

        function resetLockout() {
            return lockoutController.reset()
        }

        // Detection of system color scheme 
        if (import.meta.env.MANIFEST_VERSION === 2) {
            // FF & Safari only for now
            const media = window.matchMedia('(prefers-color-scheme: dark)')
            media.addEventListener('change', setPopupIcon)
        }

        browser.runtime.onInstalled.addListener((details) => {
            swlog('Extension installed:', details)
        })

        self.onerror = function (message, source, lineno, colno, error) {
            console.error(
                `Error: ${message}\nSource: ${source}\nLine: ${lineno}\nColumn: ${colno}\nError object: ${error}`
            )
        }

        // PBKDF2 iteration counts (KDF_ITERATIONS_LEGACY / KDF_ITERATIONS_CURRENT)
        // are imported from src/background/crypto.js, where the stateless
        // deriveKey primitive also lives and is unit-tested.
        let encryptionParams = {
            default: true,
            salt: null,
            iv: null,
            iterations: KDF_ITERATIONS_LEGACY,
        }
        let state
        resetStateToDefaults()

        let enable_debug = 'development' == process.env.NODE_ENV
        // let enable_debug = true
        let password = null
        
        // QR code capture state. The buffer is kept in SW memory and mirrored
        // to browser.storage.session (D7) so a service-worker suspension
        // between capture and popup read does not lose the image. Never
        // persisted to storage.local.
        let qrImageBuffer = null
        let qrImageMimeType = null

        const QR_SESSION_KEY = 'qrImage'

        async function persistQrImageToSession() {
            if (!qrImageBuffer || !qrImageMimeType) return
            try {
                await browser.storage.session?.set?.({
                    [QR_SESSION_KEY]: { buffer: Array.from(qrImageBuffer), mimeType: qrImageMimeType },
                })
            } catch {
                // Session storage unavailable — memory-only (acceptable degradation)
            }
        }

        async function clearQrImage() {
            qrImageBuffer = null
            qrImageMimeType = null
            try {
                await browser.storage.session?.remove?.(QR_SESSION_KEY)
            } catch {
                // ignore
            }
        }

        /**
         * Resolve the captured QR image, recovering it from session storage
         * when the SW was suspended. Returns true when a buffer is available.
         * D7: clear the badge when the buffer is lost so the user is not
         * left with a stale "1" indicator pointing at nothing.
         */
        async function loadQrImage() {
            if (qrImageBuffer && qrImageMimeType) return true

            try {
                const stored = await browser.storage.session?.get?.(QR_SESSION_KEY)
                const qr = stored?.[QR_SESSION_KEY]
                if (qr?.buffer && qr?.mimeType) {
                    qrImageBuffer = new Uint8Array(qr.buffer)
                    qrImageMimeType = qr.mimeType
                    return true
                }
            } catch {
                // ignore
            }

            if (!qrImageBuffer) {
                clearBadge()
            }
            return false
        }

        /**
         * D7: MV3 openPopup() requires a user gesture and fails when the QR
         * capture was triggered from a content-script click. Fall back to the
         * MV2-style notification + badge so the user knows to open the popup.
         */
        function notifyQrCaptured() {
            try {
                browser.notifications.create({
                    type: 'basic',
                    iconUrl: 'icon-64.png',
                    title: browser.i18n.getMessage('qrCapturedNotificationTitle') || 'QR Code Captured',
                    message: browser.i18n.getMessage('qrCapturedNotificationMessage') || 'Click the extension icon to view the account',
                })
                getActionApi().setBadgeText({ text: '1' })
                getActionApi().setBadgeBackgroundColor({ color: '#00d1b2' })
            } catch (e) {
                // Notifications/badge API not available
            }
        }

        //  MARK: Listeners
        // Lancé quand une fenêtre est fermée.
        browser.windows.onRemoved.addListener(handleBrowserClosed)

        // Lancé quand un profil ayant cette extension installée démarre une session
        browser.runtime.onStartup.addListener(handleStartup)

        // Lancé lorsque l'extension est installée pour la première fois,
        // lorsque l'extension est mise à jour vers une nouvelle version
        // et lorsque le navigateur est mis à jour vers une nouvelle version.
        browser.runtime.onInstalled.addListener(handleUpdates)

        // Envoyé sur la page de l'événement juste avant son déchargement.
        // Cela donne à l'extension l'opportunité de faire un peu de nettoyage.
        // Notez que, comme la page est en cours de déchargement, les opérations asynchrones
        // démarrées lors de la gestion de cet événement ne sont pas garanties.
        browser.runtime.onSuspend.addListener(handleClose)

        // Cet évènement est déclenché lorsque l'alarme se déclenche.
        browser.alarms.onAlarm.addListener(handleAlarms)

        // MARK: Badge — periodic TOTP countdown badge tick (1 min, MV3 minimum)
        // Re-created on every SW boot; fires handleBadgeUpdate() to refresh the toolbar badge.
        browser.alarms.create('totp-badge-tick', { periodInMinutes: 1 })

        // MARK: Shortcut — global keyboard shortcut to copy the most-recently-viewed OTP
        browser.commands.onCommand.addListener(handleCommand)

        // Lancé lorsque le système change passe à l'état actif, inactif ou vérouillé. L'écouteur d'événement reçoit une chaîne qui a l'une des trois valeurs suivantes :
        //     "vérouillé" si l'écran est vérouillé ou si l'économisateur d'écran s'active
        //     "inactif" si le système est vérouillé ou si l'économisateur n'a généré aucune entrée pendant un nombre de secondes spécifié. Ce nombre est défini par défaut sur 60, mais peut-être défini à l'aide de idle.setDetectionInterval().
        //     "actif" quand l'utilisateur génère une entrée sur un système inactif.
        // browser.idle.onStateChanged.addListener(handleSystemStateChange)

        // Lancé quand une connexion est établie avec un processus d'extension ou un script de contenu.
        browser.runtime.onConnect.addListener(handleOnConnect)


        // MARK: Messages
        onMessage('SET_AUTOLOCK_DELAY', ({ data }) => {
            swlog('📢 SET_AUTOLOCK_DELAY message received')
            return setAutolockDelay(data.kickAfter)
        })
        onMessage('ENCRYPT_PAT', ({ data, sender }) => {
            swlog('📢 ENCRYPT_PAT message received')
            // D5: only the extension's own pages may store a PAT.
            if (!isExtensionPageSender(sender)) {
                swlog('🚫 ENCRYPT_PAT rejected: untrusted sender context', sender?.context)
                return Promise.resolve({ status: false })
            }
            return encryptPat(data.apiToken)
        })
        onMessage('SET_PASSWORD', ({ data, sender }) => {
            swlog('📢 SET_PASSWORD message received')
            if (!isExtensionPageSender(sender)) {
                swlog('🚫 SET_PASSWORD rejected: untrusted sender context', sender?.context)
                return Promise.resolve({ status: false })
            }
            return setPassword(data.password)
        })
        onMessage('CHANGE_PASSWORD', ({ data, sender }) => {
            swlog('📢 CHANGE_PASSWORD message received')
            if (!isExtensionPageSender(sender)) {
                swlog('🚫 CHANGE_PASSWORD rejected: untrusted sender context', sender?.context)
                return Promise.resolve({ status: false })
            }
            return changePassword(data.password)
        })
        onMessage('CHECK_PASSWORD', ({ data }) => {
            swlog('📢 CHECK_PASSWORD message received')
            return checkPassword(data.password)
        })
        onMessage('CHECK_IS_LOCKED', () => {
            swlog('📢 CHECK_IS_LOCKED message received')
            return isLocked()
        })
        onMessage('LOCK_EXTENSION', () => {
            swlog('📢 LOCK_EXTENSION message received')
            return lockNow('popup request')
        })
        onMessage('UNLOCK', ({ sender }) => {
            swlog('📢 UNLOCK message received')
            // D5: unlocking from anything but the extension's own UI is refused.
            if (!isExtensionPageSender(sender)) {
                swlog('🚫 UNLOCK rejected: untrusted sender context', sender?.context)
                return Promise.resolve({ status: false })
            }
            return unlockExt()
        })
        onMessage('GET_PAT', ({ sender }) => {
            swlog('📢 GET_PAT message received')
            // The PAT is the long-lived API bearer token. Only the extension's
            // own trusted UI contexts (popup, options) may retrieve it. A
            // content script or window context must never receive the raw PAT
            // — a compromised page that reaches a content-script context
            // could otherwise exfiltrate the token via this handler.
            if (!isTrustedPatRequester(sender)) {
                swlog('🚫 GET_PAT rejected: untrusted sender context', sender?.context)
                return Promise.resolve({ status: false, pat: null })
            }
            return getPat()
        })
        onMessage('GET_PARTIAL_PAT', ({ sender }) => {
            swlog('📢 GET_PARTIAL_PAT message received')
            // The partial PAT is not a secret on its own, but apply the same
            // sender gate for consistency and to avoid leaking token structure
            // to content-script/window contexts.
            if (!isTrustedPatRequester(sender)) {
                swlog('🚫 GET_PARTIAL_PAT rejected: untrusted sender context', sender?.context)
                return Promise.resolve({ status: false, partialPat: null })
            }
            return getPartialPat()
        })
        onMessage('RESET_EXT', ({ sender }) => {
            swlog('📢 RESET_EXT message received')
            if (!isExtensionPageSender(sender)) {
                swlog('🚫 RESET_EXT rejected: untrusted sender context', sender?.context)
                return Promise.resolve({ status: false })
            }
            return resetExt()
        })
        onMessage('GET_EXT_VERSION', () => {
            swlog('📢 GET_EXT_VERSION message received')
            return browser.runtime.getManifest().version
        })
        onMessage('INJECT_CONTENT_SCRIPT', async ({ data }) => {
            swlog('📢 INJECT_CONTENT_SCRIPT message received')
            try {
                const tabs = await browser.tabs.query({ active: true, currentWindow: true })
                if (tabs.length === 0) {
                    return { success: false, error: 'error.no_active_tab_found' }
                }
                
                const tabId = tabs[0].id
                
                // For Manifest V3 (Chrome/Edge)
                if (import.meta.env.MANIFEST_VERSION === 3) {
                    await browser.scripting.executeScript({
                        target: { tabId },
                        files: ['content-scripts/content.js']
                    })
                } else {
                    // For Manifest V2 (Firefox/Safari)
                    await browser.tabs.executeScript(tabId, {
                        file: '/content-scripts/content.js'
                    })
                }
                
                swlog('✔️ Content script injected successfully')
                console.log(`content-script@${tabId}`)

                // Send message to start scanning
                await sendMessage('START_QR_SCAN', data, `content-script@${tabId}`)
                
                return { success: true }
            } catch (error) {
                swlog('❌ Failed to inject content script:', error)
                return { success: false, error: 'error.failed_to_inject_content_script' }
            }
        })
        onMessage('TEST_OPENPOPUP_CAPABILITY', async () => {
            swlog('📢 TEST_OPENPOPUP_CAPABILITY message received')
            
            // For non-Firefox browsers (MV3), always return true
            if (import.meta.env.MANIFEST_VERSION !== 2) {
                return { canOpenPopup: true }
            }
            
            // For Firefox (MV2), test if openPopup() works
            try {
                await browser.browserAction.openPopup()
                swlog('✔️ openPopup() capability test: SUCCESS')
                return { canOpenPopup: true }
            } catch (error) {
                swlog('⚠️ openPopup() capability test: FAILED -', error.message)
                return { canOpenPopup: false }
            }
        })
        onMessage('QR_IMAGE_SELECTED', async ({ data }) => {
            swlog('📢 QR_IMAGE_SELECTED message received')
            try {
                // Reconstruct ImageData from raw data
                const canvas = new OffscreenCanvas(data.imageData.width, data.imageData.height)
                const ctx = canvas.getContext('2d')
                const imageData = new ImageData(
                    new Uint8ClampedArray(data.imageData.data),
                    data.imageData.width,
                    data.imageData.height
                )
                ctx.putImageData(imageData, 0, 0)
                
                // Convert to blob
                const blob = await canvas.convertToBlob({ type: 'image/png' })
                const arrayBuffer = await blob.arrayBuffer()
                
                // Store the image data
                qrImageBuffer = new Uint8Array(arrayBuffer)
                qrImageMimeType = blob.type
                await persistQrImageToSession()

                swlog('QR image stored, waiting for popup to ask for it')

                if (import.meta.env.MANIFEST_VERSION === 2) {
                    // Firefox
                    try {
                        await browser.browserAction.openPopup()
                    } catch (popupError) {
                        notifyQrCaptured()
                    }
                }
                else {
                    // Chrome MV3: openPopup() only works with a user gesture;
                    // fall back to notification + badge (D7).
                    try {
                        await browser.action.openPopup()
                    } catch (popupError) {
                        swlog('⚠️ openPopup() failed, falling back to notification:', popupError?.message)
                        notifyQrCaptured()
                    }
                }

                return { success: true }
            } catch (error) {
                swlog('❌ Failed to store QR image:', error)
                return { success: false, error: error.message }
            }
        })
        onMessage('IS_THERE_QR', async () => {
            swlog('📢 IS_THERE_QR message received')

                const tabs = await browser.tabs.query({ active: true, currentWindow: true })
                if (tabs.length === 0) {
                    return { success: false, error: 'error.no_active_tab_found' }
                }
                
                const tabId = tabs[0].id

                // D14: the content script may be gone (navigation, frame
                // teardown) — a rejected sendMessage must not break the
                // hasQR answer.
                try {
                    await sendMessage('CLEANUP', {}, `content-script@${tabId}`)
                } catch (e) {
                    swlog('⚠️ CLEANUP could not be delivered:', e?.message ?? e)
                }

            const hasQR = await loadQrImage()
            return { success: true, hasQR: hasQR ? qrImageMimeType : null }
        })
        onMessage('GET_QR_BLOB', async () => {
            swlog('📢 GET_QR_BLOB message received')
            const hasQR = await loadQrImage()
            if (hasQR) {
                const result = {
                    success: true,
                    imageBuffer: Array.from(qrImageBuffer),
                    mimeType: qrImageMimeType
                }

                // Clear the stored data after retrieval
                await clearQrImage()

                // Clear the capture badge on both manifest versions
                try {
                    getActionApi().setBadgeText({ text: '' })
                } catch (e) {
                    // Badge API not available on some platforms
                }

                swlog('QR blob data sent to popup')
                return result
            } else {
                swlog('⚠️ No QR blob data available')
                return { success: false, error: 'error.no_qr_image_data_available' }
            }
        })
        onMessage('CAPTURE_SCREENSHOT', async ({ data, sender }) => {
            swlog('📢 CAPTURE_SCREENSHOT message received')
            // D5: screen capture is only served to the extension's own pages.
            if (!isExtensionPageSender(sender)) {
                swlog('🚫 CAPTURE_SCREENSHOT rejected: untrusted sender context', sender?.context)
                return { success: false, error: 'error.untrusted_sender' }
            }
            try {
                const tabs = await browser.tabs.query({ active: true, currentWindow: true })
                if (tabs.length === 0) {
                    return { success: false, error: 'error.no_active_tab_found' }
                }
                
                // Capture the full visible tab
                const fullDataUrl = await browser.tabs.captureVisibleTab(tabs[0].windowId, {
                    format: 'png'
                })
                
                // Convert data URL to blob then to ImageBitmap
                const response = await fetch(fullDataUrl)
                const blob = await response.blob()
                const imageBitmap = await createImageBitmap(blob)
                
                // Create canvas and crop the screenshot
                const canvas = new OffscreenCanvas(data.rect.width, data.rect.height)
                const ctx = canvas.getContext('2d')
                
                // Crop the image using the rect coordinates
                ctx.drawImage(
                    imageBitmap,
                    data.rect.x, data.rect.y, data.rect.width, data.rect.height,
                    0, 0, data.rect.width, data.rect.height
                )
                
                // Convert canvas to blob then to dataUrl
                const croppedBlob = await canvas.convertToBlob({ type: 'image/png' })
                const reader = new FileReader()
                const dataUrl = await new Promise((resolve, reject) => {
                    reader.onloadend = () => resolve(reader.result)
                    reader.onerror = reject
                    reader.readAsDataURL(croppedBlob)
                })
                
                return { 
                    success: true, 
                    dataUrl: dataUrl
                }
            } catch (error) {
                swlog('❌ Failed to capture screenshot:', error)
                return { success: false, error: error.message }
            }
        })

        // MARK: Form Detection — update badge when a login/2FA page is detected
        onMessage('PAGE_ANALYZED', async ({ data, sender }) => {
            swlog('📢 PAGE_ANALYZED message received', data.hostname, 'has2FA:', data.has2FAForm)

            // D5: only our content scripts report page analysis.
            if (!isContentScriptSender(sender)) {
                swlog('🚫 PAGE_ANALYZED rejected: untrusted sender context', sender?.context)
                return null
            }

            const tabId = sender?.tabId ?? null

            const { autoFillAccounts } = await browser.storage.local.get({ autoFillAccounts: [] })
            const domain  = (data.hostname ?? '').replace(/^www\./, '').toLowerCase()
            // SECURITY: Use the same scoring function as the actual auto-fill
            // selection, so the badge count reflects only safe matches.
            const matches = (autoFillAccounts || [])
                .map(a => ({ account: a, score: calcAutoFillScore(a, domain) }))
                .filter(m => m.score > 0)
                .map(m => m.account)

            if (!data.has2FAForm && !data.hasLoginForm) {
                // D10: stale badges must not survive navigation to a
                // non-login page.
                clearTabBadge(tabId)
                return null
            }

            if (matches.length === 0) {
                // D10: zero matches — clear any previously set badge.
                clearTabBadge(tabId)
                return null
            }

            const badgeText = String(matches.length)

            if (tabId) {
                try {
                    if (import.meta.env.MANIFEST_VERSION === 2) {
                        await browser.browserAction.setBadgeText({ text: badgeText, tabId })
                        await browser.browserAction.setBadgeBackgroundColor({ color: '#00d1b2', tabId })
                    } else {
                        await browser.action.setBadgeText({ text: badgeText, tabId })
                        await browser.action.setBadgeBackgroundColor({ color: '#00d1b2', tabId })
                    }
                } catch {
                    // Badge API not available on some platforms
                }
            }

            // Store page context for popup to read when opened
            await browser.storage.session?.set?.({ pageContext: { hostname: data.hostname, matchCount: matches.length, matchIds: matches.map(a => a.id) } })

            return { matchCount: matches.length }
        })

        // MARK: Auto-Fill
        onMessage('SYNC_ACCOUNTS_METADATA', async ({ data, sender }) => {
            swlog('📢 SYNC_ACCOUNTS_METADATA message received')
            // D5: the account list is pushed by the extension popup — never
            // accept it from a page/content-script context.
            if (!isExtensionPageSender(sender)) {
                swlog('🚫 SYNC_ACCOUNTS_METADATA rejected: untrusted sender context', sender?.context)
                return { status: false }
            }
            await browser.storage.local.set({ autoFillAccounts: data.accounts })
            return { status: true }
        })

        onMessage('REQUEST_AUTO_FILL', async ({ data, sender }) => {
            swlog('📢 REQUEST_AUTO_FILL message received')

            // D5: auto-fill requests only come from our content scripts.
            if (!isContentScriptSender(sender)) {
                swlog('🚫 REQUEST_AUTO_FILL rejected: untrusted sender context', sender?.context)
                return null
            }

            const lockState = await isLocked()
            if (lockState?.locked) return null

            if (!state.pat) return null

            const stored = await browser.storage.local.get('local:settings')
            const hostUrl = stored['local:settings']?.hostUrl
            if (!hostUrl) return null

            const { autoFillAccounts } = await browser.storage.local.get({ autoFillAccounts: [] })
            if (!autoFillAccounts?.length) return null

            const matches = matchAccountsToHostname(autoFillAccounts, data.hostname)
            if (matches.length === 0) return null

            const bestMatch = matches[0].account

            try {
                const response = await fetch(`${hostUrl}/api/v1/twofaccounts/${bestMatch.id}/otp`, {
                    headers: {
                        'Authorization': `Bearer ${state.pat}`,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/json',
                    },
                })

                if (!response.ok) return null

                const otpData = await response.json()
                return {
                    otp: otpData.password,
                    accountId: bestMatch.id,
                    service: bestMatch.service,
                    // D9: when several accounts match the hostname, surface
                    // which one was used so the user can catch a wrong pick.
                    account: bestMatch.account || null,
                    ambiguous: matches.length > 1,
                }
            } catch (e) {
                swlog('❌ Auto-fill OTP fetch failed:', e)
                return null
            }
        })

        // Auto-fill account/domain matching (matchAccountsToHostname,
        // getRegistrableDomain, calcAutoFillScore) lives in
        // src/background/autofillMatch.js so it can be unit-tested; the
        // functions are imported above and used directly by the message
        // handlers.

        // MARK: Badge — refresh-badge + set-last-account message handlers
        onMessage('refresh-badge', () => {
            swlog('📢 refresh-badge message received')
            handleBadgeUpdate()
            return Promise.resolve({ status: true })
        })

        onMessage('set-last-account', ({ data }) => {
            swlog('📢 set-last-account message received')
            state.lastViewedAccountId = data?.id ?? null
            // Persist so the shortcut keeps working after the SW is suspended
            storeState(false).catch(() => {})
            return Promise.resolve({ status: true })
        })

        //  MARK: Loggers
        // /**
        //  * Debug logging
        //  *
        //  * @param logs
        //  */
        async function swlog(...logs) {
            if (enable_debug) {
                console.log('[WORKER]', ...logs)
            }
        }

        /**
         * Write a console log line formated as a title
         * 
         * @param  {...any} logs 
         */
        async function swlogTitle(...logs) {
            swlog('### ' + logs + ' ###')
        }

        //  MARK: Icon
        /**
         * Init the popup icon based on active color scheme
         */
        function setPopupIcon() {
            detectDarkScheme().then((isDark) => {
                const scheme = isDark ? 'dark' : 'light'
                const iconRes = {
                    path: {
                        16: `icon-16-${scheme}.png`,
                        32: `icon-32-${scheme}.png`,
                        64: `icon-64-${scheme}.png`,
                    }
                }

                if (import.meta.env.MANIFEST_VERSION === 2) {
                    browser.browserAction.setIcon(iconRes)
                }
                else {
                    browser.action.setIcon(iconRes)
                }
            }).catch(() => {
                // D18: never let a rejected scheme detection bubble up
            })
        }

        //  MARK: Theme
        /**
         * Tells if dark color scheme is On
         * 
         * @returns {boolean}
         */
        async function detectDarkScheme() {
            if (import.meta.env.MANIFEST_VERSION === 2) {
                // FF & Safari
                return Promise.resolve(window.matchMedia('(prefers-color-scheme: dark)').matches)
            }
            else {
                // Chrome, Edge, Opera
                if (browser.offscreen != null) {
                    await browser.offscreen.createDocument({
                        url: 'offscreen.html',
                        reasons: ['MATCH_MEDIA'],
                        justification: 'get media color scheme',
                    }).catch(() => {})
    
                    const isDark = await browser.runtime.sendMessage('checkDarkTheme').catch(() => null)
                    browser.offscreen.closeDocument().catch(() => {})

                    return isDark
                }
                else {
                    // fallback
                    return Promise.resolve(true)
                }
            }
        }

        /**
         * Tells if the user has set an autolock option
         *
         * @returns {boolean}
         */
        function hasAutoLockEnabled() {
            return state.kickAfter == -1 || state.kickAfter > 0
        }

        // MARK: Badge helpers — TOTP countdown badge on the toolbar icon
        // Counts accounts whose TOTP will rotate within 10s. The pure pieces
        // (remainingSeconds, resolveBadgeAppearance) live in
        // src/background/badge.js so they can be unit-tested; color is derived
        // from the most-urgent account: red (#ef4444) <=5s, amber (#f59e0b)
        // <=10s, green (#22c55e) otherwise.

        /**
         * Resolve the toolbar action API (browser.action on MV3, browser.browserAction on MV2 Firefox)
         *
         * @returns {browser.browserAction|browser.action}
         */
        function getActionApi() {
            return import.meta.env.MANIFEST_VERSION === 2
                ? browser.browserAction
                : browser.action
        }

        /**
         * Set the badge text and background color
         *
         * @param {number} count
         * @param {number} urgency
         */
        function setBadge(count, urgency) {
            const { text, color } = resolveBadgeAppearance(count, urgency)
            try {
                getActionApi().setBadgeText({ text })
                getActionApi().setBadgeBackgroundColor({ color })
            } catch (e) {
                // Badge API not available on some platforms
            }
        }

        /**
         * Clear the badge text (keeps last background color, harmless)
         */
        function clearBadge() {
            try {
                getActionApi().setBadgeText({ text: '' })
            } catch (e) {
                // Badge API not available on some platforms
            }
        }

        /**
         * Clear the per-tab match-count badge (D10). The global clearBadge()
         * does not touch tab-scoped badges on Chrome.
         *
         * @param {number|null} tabId
         */
        function clearTabBadge(tabId) {
            if (tabId == null) return
            try {
                getActionApi().setBadgeText({ text: '', tabId })
            } catch (e) {
                // Badge API not available on some platforms
            }
        }

        /**
         * Clear per-tab badges on every open tab (D10: lock must not leave
         * stale match-count badges behind).
         */
        async function clearAllTabBadges() {
            try {
                const tabs = await browser.tabs.query({})
                for (const tab of tabs) {
                    clearTabBadge(tab.id)
                }
            } catch (e) {
                // Tabs API not available
            }
        }

        // D10: clear the per-tab badge when the tab navigates, so match
        // counts do not leak across pages.
        browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.status === 'loading' || changeInfo.url) {
                clearTabBadge(tabId)
            }
        })

        /**
         * Update the toolbar badge based on cached accounts expiring within 10s
         *
         * @returns {Promise<void>}
         */
        function handleBadgeUpdate() {
            // On a cold SW boot, state may still hold defaults — load it first so the
            // locked flag is accurate before deciding whether to show the badge.
            const ensureState = state.isLoaded ? Promise.resolve() : loadState()

            return ensureState.then(() => {
                if (state.locked) {
                    clearBadge()
                    return
                }

                // Accounts are cached in storage (synced by the popup), not in the SW state object.
                return browser.storage.local.get({ autoFillAccounts: [] }).then(({ autoFillAccounts }) => {
                    const accounts = Array.isArray(autoFillAccounts) ? autoFillAccounts : []
                    if (!accounts.length) {
                        clearBadge()
                        return
                    }

                    const expiring = accounts.filter(a => a.otp_type == null || String(a.otp_type).includes('totp'))
                        .filter(a => remainingSeconds(a) <= 10)

                    if (expiring.length === 0) {
                        clearBadge()
                        return
                    }

                    const urgency = Math.min(...expiring.map(remainingSeconds))
                    setBadge(expiring.length, urgency)
                }).catch(() => clearBadge())
            }).catch(() => clearBadge())
        }

        // MARK: Shortcut helpers — global OTP copy via keyboard shortcut

        /**
         * Build a basic browser notification
         *
         * @param {string} message
         */
        function notifyShortcut(message) {
            try {
                browser.notifications.create({
                    type: 'basic',
                    iconUrl: 'icon-64.png',
                    title: '2FA-Vault',
                    message: message,
                })
            } catch (e) {
                // Notifications API not available
            }
        }

        /**
         * Ensure an offscreen document exists (Chrome MV3 only) for clipboard relay
         *
         * @returns {Promise<void>}
         */
        async function ensureOffscreenDocument() {
            if (import.meta.env.MANIFEST_VERSION === 2) return
            if (!browser.offscreen) return

            const existingContexts = await browser.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [browser.runtime.getURL('offscreen.html')],
            }).catch(() => [])

            if (existingContexts && existingContexts.length > 0) return

            await browser.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['CLIPBOARD'],
                justification: 'Write OTP to clipboard from the keyboard shortcut',
            }).catch(() => {})
        }

        /**
         * Write text to the clipboard — directly on Firefox MV2, via offscreen relay on Chrome MV3
         *
         * @param {string} text
         * @returns {Promise<void>}
         */
        async function writeToClipboard(text) {
            const hasDirectClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard

            if (import.meta.env.MANIFEST_VERSION === 2 || hasDirectClipboard) {
                // Firefox MV2: direct clipboard access is allowed in the background page.
                // Some platforms also expose clipboard in the SW, in which case we use it directly.
                await navigator.clipboard.writeText(text)
                return
            }

            // Chrome MV3: clipboard is blocked in the service worker, relay via offscreen document
            await ensureOffscreenDocument()
            await browser.runtime.sendMessage({ type: 'clipboard-write', text })
        }

        /**
         * Generate the current OTP for an account using the backend (PAT-authenticated)
         *
         * The SW does not hold decrypted secrets, so OTP generation is delegated to the
         * 2FA-Vault backend, exactly like the auto-fill flow.
         *
         * @param {object} account
         * @returns {Promise<{password: string}|null>}
         */
        async function generateShortcutOtp(account) {
            if (!state.pat) return null

            const stored = await browser.storage.local.get('local:settings')
            const hostUrl = stored['local:settings']?.hostUrl
            if (!hostUrl) return null

            const response = await fetch(`${hostUrl}/api/v1/twofaccounts/${account.id}/otp`, {
                headers: {
                    'Authorization': `Bearer ${state.pat}`,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/json',
                },
            })

            if (!response.ok) return null

            const otpData = await response.json()
            return otpData?.password ? { password: otpData.password } : null
        }

        /**
         * Handle the global 'copy-otp' keyboard command
         *
         * @param {string} command
         */
        async function handleCommand(command) {
            if (command !== 'copy-otp') return
            swlog('⌨️ copy-otp command received')

            // Make sure the SW state (locked flag, pat) is loaded before acting
            await loadState()

            if (state.locked) {
                notifyShortcut(browser.i18n.getMessage('notificationVaultLocked'))
                return
            }

            if (!state.lastViewedAccountId) {
                notifyShortcut(browser.i18n.getMessage('notificationNoRecentAccount'))
                return
            }

            const { autoFillAccounts } = await browser.storage.local.get({ autoFillAccounts: [] })
            const accounts = Array.isArray(autoFillAccounts) ? autoFillAccounts : []
            const account = accounts.find(a => String(a.id) === String(state.lastViewedAccountId))

            if (!account) {
                notifyShortcut(browser.i18n.getMessage('notificationNoRecentAccount'))
                return
            }

            try {
                const otp = await generateShortcutOtp(account)
                if (!otp?.password) {
                    notifyShortcut(browser.i18n.getMessage('notificationOtpFailed'))
                    return
                }

                await writeToClipboard(otp.password)
                const label = account.service || account.account || 'account'
                // $1 placeholder in messages.json is substituted with the label.
                notifyShortcut(browser.i18n.getMessage('notificationOtpCopied', label))
            } catch (e) {
                swlog('❌ copy-otp failed:', e)
                notifyShortcut(browser.i18n.getMessage('notificationCopyFailed'))
            }
        }

        //  MARK: Events
        
        /**
         * Detect all browser windows closing and lock extension if required
         * MARK:On browser close
         *
         * TODO: Needs testing without dev-tools windows open to see if it still triggers ( hint: it doesn't seem to :/ )
         */
        function handleBrowserClosed(window_id) {
            browser.windows.getAll().then(window_list => {
                if (window_list.length === 0) {
                    if (hasAutoLockEnabled()) {
                        lockNow('handleBrowserClosed()')
                    } else {
                        storeState()
                    }
                }
            })
        }


        /**
         * Handle the lock timeout alarm
         * MARK: On alarm
         */
        function handleAlarms(alarm) {
            swlog('== ALARM HANDLING ==')
            if (alarm.name === 'lock-extension') {
                swlog('⏰ lock-extension alarm triggered after ' + (Date.now() - state.lastActiveAt) / 1000 + ' seconds')
                if (state.isLoaded) {
                    lockNow('handleAlarms()')
                } else {
                    loadState().then(() => {
                        lockNow('handleAlarms() after state loading')
                    })
                }
            } else if (alarm.name === 'totp-badge-tick') {
                handleBadgeUpdate()
            }
        }

        /**
         * Handle the extension connecting/disconnecting
         * MARK: On connect
         */
        function handleOnConnect(externalPort) {
            swlogTitle('ON CONNECT HANDLING')
            if (state.isLoaded === false) {
                startup()
            }
            else {
                if (state.locked) {
                    lockNow('handleOnConnect()')
                }
                else {
                    storeState().then(() => {
                        browser.alarms.clear('lock-extension').then((cleared) => {
                            if (cleared) swlog('⏰ lock-extension alarm cleared by handleOnConnect()')
                        })
                    })
                }
            }
            externalPort.onDisconnect.addListener(handleClose)
        }

        /**
         * Detect the system state change
         * MARK: On sys change
         */
        // function handleSystemStateChange(new_state) {
        //     swlogTitle('SYSTEM CHANGE HANDLING')

        //     function checkLockState() {
        //         if (hasAutoLockEnabled()) {
        //             lockNow('handleSystemStateChange()')
        //         }
        //     }

        //     swlog('System switched to ' + new_state)
        //     if (new_state === 'locked') {
        //         if (state.isLoaded) {
        //             checkLockState()
        //         } else {
        //             loadState().then(() => {
        //                 checkLockState()
        //             })
        //         }
        //     }
        // }

        /**
         * Handle startup tasks
         * MARK: On startup
         */
        function handleStartup() {
            swlogTitle('STARTUP HANDLING')

            startup(true)
        }

        /**
         * startup
         * MARK: Startup
         */
        function startup(fromHandleStartup = false) {
            swlogTitle('STARTUP')

            setPopupIcon()
            loadState().then(() => {
                if (fromHandleStartup && hasAutoLockEnabled()) {
                    lockNow('fromHandleStartup()')
                }
                if (state.locked) {
                    lockNow('startup()')
                }
                else {
                    // D3: an extension/browser update restarts the SW and must
                    // NOT cancel the autolock. Re-arm the alarm from the
                    // persisted lastActiveAt so the countdown continues (or
                    // locks immediately when already elapsed).
                    startLockTimer()
                }
            })
        }

        /**
         * Handle update tasks
         * MARK: On update
         */
        async function handleUpdates(details) {
            swlogTitle('UPDATES HANDLING')
            // if (details.reason === 'update') {
            // }
            startup()
        }

        /**
         * Handle close events
         * MARK: On close
         */
        function handleClose() {
            swlogTitle('CLOSE HANDLING')
            storeState().then(() => {
                startLockTimer()
            })
        }

        /**
         * Save the workers state in storage
         * MARK: storeState()
         *
         * SECURITY: The decrypted PAT (`state.pat`) is NEVER persisted to
         * `browser.storage.local`. Only the opaque metadata (lock state,
         * activity timestamps, last viewed account) is stored. The PAT
         * remains in service-worker memory only and is rebuilt from the
         * encrypted `cryptoStore.encryptedApiToken` payload during unlock.
         * This prevents anyone with access to the extension storage files
         * from recovering a usable bearer token.
         *
         * @param updateLastActiveAt
         * @returns {Promise<boolean>}
         */
        function storeState(updateLastActiveAt = true) {
            swlog('🖫 Storing state')

            if (updateLastActiveAt) {
                state.lastActiveAt = Date.now()
            }

            // Strip the decrypted PAT before persisting. The PAT lives only
            // in SW memory after a successful unlock(); on next startup the
            // vault is loaded as locked and the user must unlock again.
            const persistable = { ...state, pat: '' }

            return browser.storage.local.set({ [EXTSTATE_STORE]: persistable }).then(() => true, () => false)
        }

        /**
         * Reset worker state to defaults
         */
        function resetStateToDefaults() {
            state = { ...default_state }
        }

        /**
         * Set worker state to locked
         *
         * RT6: EVERY path to this function is a lock transition, so the
         * session-storage PAT copy is cleared here too — otherwise the
         * decrypted PAT would resurrect after the next loadState().
         */
        function setStateToLocked() {
            state.pat = ''
            state.locked = true
            runtimeSecrets.clear()
        }

        /**
         * Remove the vault key from session storage (D6: session-only, the
         * E2EE key is never written to storage.local).
         */
        function clearVaultKey() {
            return (browser.storage.session?.remove?.('vaultKey') ?? Promise.resolve())
                .then(() => true, () => false)
        }

        /**
         * Load the workers state from storage or apply default values
         * MARK: loadState()
         *
         * @returns {Promise<{[p: string]: any} | *>}
         */
        function loadState() {
            // Load lockout counters in parallel so the brute-force gate is
            // ready before any unlock/checkPassword call can run.
            const loadLockoutPromise = loadLockout()

            // D1: capture the live PAT before the wholesale state replacement
            // below — the persisted copy never contains it.
            const memoryPat = state?.pat || ''

            return browser.storage.local.get({ [EXTSTATE_STORE]: null }).then(stores => {
                state = stores[EXTSTATE_STORE]

                if (state !== null) {
                    state.isLoaded = true
                    swlog('State loaded (from store)')

                    // D1: restore the runtime PAT (in-memory tier first, then
                    // the session-storage copy) so a CHECK_IS_LOCKED round
                    // trip cannot wipe a valid, unlocked PAT.
                    return runtimeSecrets.get().then(sessionPat => {
                        state.pat = resolveRuntimePat(state.pat, memoryPat, sessionPat)

                        // We force reload the kickAfter delay from the preferences store
                        return setKickAfterDelayUsingPreferenceStore().then(() => {
                            // We update the state to locked if kickAfter delay is elapsed since last activity
                            if (state.kickAfter > 0 && state.lastActiveAt !== null && ((Date.now() - state.lastActiveAt) / 60000) > state.kickAfter) {
                                // RT6: this lock transition clears the
                                // session-storage PAT copy via setStateToLocked.
                                setStateToLocked()
                            }
                        })
                    })
                } else {
                    return loadDefaultState()
                }
            },
            () => {
                return loadDefaultState()
            }).then(result => loadLockoutPromise.then(() => result))
        }

        /**
         * Populate the workers state with default values and save it to storage
         * MARK: loadDefaultState()
         *
         * @returns {Promise<boolean>}
         */
        function loadDefaultState() {
            resetStateToDefaults()
            swlog('State loaded (from defaults)')

            return setKickAfterDelayUsingPreferenceStore().then(() => {
                return storeState(false).then(() => {
                    return false
                })
            })
        }

        /**
         * 
         */
        function setKickAfterDelayUsingPreferenceStore() {
            return browser.storage.local.get({ [PREFERENCE_STORE]: null }).then(stores => {
                const preferencesStore = stores[PREFERENCE_STORE]

                if (preferencesStore !== null) {
                    let preferences = null
                    try {
                        preferences = JSON.parse(preferencesStore)
                    } catch (e) {
                        // D18: corrupted persisted preferences must not crash
                        // the whole state loading — fall through with defaults.
                        swlog('❌ Cannot parse persisted preferences:', e)
                    }

                    if (preferences !== null) {
                        state.kickAfter = (preferences.kickUserAfter !== null && preferences.kickUserAfter !== 'null') ? parseInt(preferences.kickUserAfter) : null
                        swlog('kickAfter set from preferences to ' + state.kickAfter)
                    }
                    return true
                }
                else {
                    if (state.pat) {
                        state.kickAfter = 15
                        swlog('kickAfter defaulting to 15')
                    }
                    else {
                        swlog('kickAfter unchanged (= ' + state.kickAfter + ')')
                    }
                    return true
                }
            }, () => false)
        }

        /**
         * Lock the extension
         * MARK: lockNow()
         */
        function lockNow(by = 'unknown') {
            swlog('🔒 locked by ' + by)
            setStateToLocked()
            // Badge must never show stale TOTP data when the vault is locked
            clearBadge()
            // D10: per-tab match-count badges are lock-sensitive too
            clearAllTabBadges()
            storeState().then(() => {
                password = null
                clearVaultKey().then(() => {
                    // Clear the alarm so it doesn't fire again
                    browser.alarms.clear('lock-extension').then((cleared) => {
                        if (cleared) swlog('⏰ lock-extension alarm cleared by lockNow()')
                    })
                })
            })
        }

        /**
         * Enable the lock timer
         * MARK: startLockTimer()
         */
        function startLockTimer() {
            if (state.locked) {
                swlog('⏰ No need of lock timer: Extension already locked')
            }
            else if (state.kickAfter !== null && state.kickAfter !== 'null') {
                const kickAfter = parseInt(state.kickAfter)
                if (kickAfter > 0) {
                    // D15: count from the persisted lastActiveAt (last real
                    // user activity), not from popup-close time.
                    const elapsedMinutes = state.lastActiveAt !== null ? (Date.now() - state.lastActiveAt) / 60000 : 0
                    const remainingMinutes = kickAfter - elapsedMinutes

                    if (remainingMinutes <= 0) {
                        swlog('⏰ kickAfter already elapsed since last activity, locking now')
                        lockNow('startLockTimer() elapsed')
                    }
                    else {
                        browser.alarms.create('lock-extension', { delayInMinutes: remainingMinutes })
                        swlog('⏰ lock-extension alarm started for ' + remainingMinutes.toFixed(2) + ' minutes (kickAfter ' + kickAfter + ' from ' + state.lastActiveAt + ')')
                    }
                }
                else swlog('⏰ No need of lock timer (kickAfter = ' + state.kickAfter + ')')
            }
            else swlog('⏰ kickAfter is null, exiting startLockTimer without creating a lock timer')
        }

        /**
         * Whether the message sender may receive the raw PAT.
         *
         * webext-bridge tags every message with a `sender.context` value
         * ('popup' | 'options' | 'content-script' | 'window' | 'devtools' |
         * 'background'). Only the extension's own UI contexts are trusted with
         * the PAT; content scripts share their execution context with the page
         * and must never receive the raw token.
         *
         * MARK: isTrustedPatRequester()
         *
         * @param {object} sender The webext-bridge sender Endpoint.
         * @returns {boolean}
         */
        function isTrustedPatRequester(sender) {
            const context = sender?.context
            return context === 'popup' || context === 'options'
        }

        // /**
        //  * Get the Personal Access Token
        //  *
        //  * @returns {Promise<Awaited<{pat: string, status: boolean}>>}
        //  */
        function getPat() {
            return Promise.resolve({ status: true, pat: state.pat })
        }

        // /**
        //  * Get the Personal Access Token truncated
        //  *
        //  * @returns {Promise<Awaited<{pat: string, status: boolean}>>}
        //  */
        function getPartialPat() {
            return Promise.resolve({ status: true, partialPat: state.pat.substring(0, 16) + ' ... ' + state.pat.slice(-16) })
        }


        /**
         * Check if the extension is currently or should be locked
         * MARK: isLocked()
         *
         * @returns {Promise<{[p: string]: any} | {locked: boolean}>}
         */
        function isLocked() {
            swlogTitle('CHECKING LOCK STATE')
            // This is triggered each time the extension loads, so we will use it as a point to load/generate the salt and iv for encryption
            return loadState().then(() => {
                return browser.storage.local.get({ [CRYPTO_STORE]: null }).then(stores => {
                    if (stores && stores.hasOwnProperty(CRYPTO_STORE) && stores[CRYPTO_STORE]) {
                        encryptionParams.iv = new Uint8Array(stores[CRYPTO_STORE].iv)
                        encryptionParams.salt = new Uint8Array(stores[CRYPTO_STORE].salt)
                        encryptionParams.default = stores[CRYPTO_STORE].default ?? true
                        // Preserve the iteration count used to encrypt the
                        // stored PAT. Older builds wrote nothing here, so fall
                        // back to the legacy count to stay decryptable.
                        encryptionParams.iterations = stores[CRYPTO_STORE].iterations ?? KDF_ITERATIONS_LEGACY
                        swlog('Crypto params loaded from store')
                        return new Promise(resolve => resolve())
                    } else {
                        swlog('No crypto store')
                        return generateNewCryptoParams(true)
                    }
                }, () => new Promise(resolve => resolve()))
            }).then(() => {
                return browser.storage.local.get({ [CRYPTO_STORE]: {} }).then(stores => {
                    let return_value = { locked: false }

                    // The extension can only be locked if there is a PAT in storage and the user has set a password
                    if (stores.hasOwnProperty(CRYPTO_STORE) && stores[CRYPTO_STORE].hasOwnProperty('encryptedApiToken')) {
                        return_value.locked = stores[CRYPTO_STORE]['encryptedApiToken'].length > 0 && state.locked === true
                    }
                    // If the user has not set a password and locked is true, unlock the PAT using a null key
                    if (return_value.locked === true && encryptionParams.default === true) {
                        return unlockExt().then(status => {
                            return_value.locked = false
                            swlog('Extension identified as unlocked 🔓 (with default encryption params)')
                            return return_value
                        })
                    } else {
                        swlog('Extension identified as ' + (return_value.locked ? 'locked 🔒' : 'unlocked 🔓'))
                        return return_value
                    }
                }, () => {
                    return { locked: false }
                })
            })
        }

        /**
         * Reset the extension
         * MARK: resetExt()
         *
         * @returns {Promise<unknown>}
         */
        function resetExt() {
            swlogTitle('RESETTING EXTENSION')

            // RT6: reset is a lock transition — wipe runtime secrets and any
            // session-scoped artifacts (vault key, QR buffer) too.
            runtimeSecrets.clear()
            clearVaultKey()
            clearQrImage()
            clearAllTabBadges()

            return browser.storage.local.clear()
                .then(() => {
                    resetStateToDefaults()
                    password = null
                    encryptionParams = {
                        salt: null,
                        iv: null,
                        default: true
                    }
                    return generateNewCryptoParams(true)
                })
                .then(() => browser.alarms.clear())
                .then(() => swlog('✔️ Extension reset done'))
                .then(() => isLocked())
        }

        /**
         * Attempt to unlock the extension
         * MARK: unlockExt()
         *
         * @returns {Promise<{[p: string]: any} | {status: boolean}>}
         */
        function unlockExt() {
            swlogTitle('UNLOCKING EXTENSION')

            // D4: rehydrate the persisted lockout counters BEFORE reading the
            // gate — on a cold SW the in-memory controller is empty and the
            // backoff would otherwise not apply.
            return loadLockout().then(() => {

            // Brute-force gate: refuse while a backoff window is active.
            const remaining = getLockoutRemainingMs()
            if (remaining > 0) {
                return Promise.resolve({
                    status: false,
                    reason: 'error.too_many_attempts',
                    retryAfterMs: remaining,
                })
            }

            return browser.storage.local.get({ [CRYPTO_STORE]: {} }).then(stores => {
                if (stores && stores.hasOwnProperty(CRYPTO_STORE) && stores[CRYPTO_STORE]) {
                    // encryptionParams should already be fed during the popup opening but
                    // it's not always true, for example under Vivaldi after the first lock.
                    // So we enforce the parameters
                    encryptionParams.iv = new Uint8Array(stores[CRYPTO_STORE].iv)
                    encryptionParams.salt = new Uint8Array(stores[CRYPTO_STORE].salt)
                    encryptionParams.default = stores[CRYPTO_STORE].default ?? true
                    // Preserve the iteration count used to encrypt the stored
                    // PAT (legacy builds wrote nothing → fall back to 100k).
                    encryptionParams.iterations = stores[CRYPTO_STORE].iterations ?? KDF_ITERATIONS_LEGACY
                    swlog('Crypto params loaded from store')
                } else {
                    swlog('❌ Cannot unlock: Failed to retrieve crypto store data')
                    return { status: false, reason: 'error.failed_to_retrieve_encryption_store_data' }
                }
                
                let encryptedApiToken = stores[CRYPTO_STORE]['encryptedApiToken'] || ''

                return getPassword().then(pwd => {
                    return deriveKey(pwd, encryptionParams.salt).then(encryptionKey => {
                        return decryptPat(encryptedApiToken, encryptionKey).then(decipheredPat => {
                            swlog('🔃 ✔️ Decrypted')
                            state.pat = decipheredPat
                            state.locked = false
                            // D1: mirror the PAT into the runtime-secret tiers
                            // (SW memory + storage.session when available).
                            runtimeSecrets.set(state.pat)
                            swlog('🔓 Extension is now unlocked')
                            resetLockout()
                            return storeState().then(() => {
                                return browser.alarms.clear('lock-extension').then((cleared) => {
                                    if (cleared) swlog('⏰ lock-extension alarm cleared by UnlockExt() at ' + state.lastActiveAt)
                                    return { status: true }
                                }, () => {
                                    return { status: true }
                                })
                            })
                        }, (result) => {
                            swlog('🔃 ❌ decryptPat() rejected: ' + result)
                            recordFailedAttempt()
                            return { status: false, reason: 'error.failed_to_decipher_pat' }
                        })
                    }, () => {
                        swlog('🔀 ❌ Cannot unlock: Couldn\'t derive key')
                        recordFailedAttempt()
                        return { status: false, reason: 'error.failed_to_derive_key' }
                    })
                }, () => {
                    swlog('🔑 ❌ Cannot unlock: Couldn\'t get password')
                    return { status: false, reason: 'error.failed_to_get_password' }
                })
            }, () => {
                swlog('♻️ ❌ Cannot unlock: Failed to load crypto params')
                return { status: false, reason: 'error.failed_to_load_settings' }
            })

            })
        }
/**
         * Check the given password is the current password by trying to decrypt the stored PAT
         * MARK: checkEncKey()
         *
         * @param pwd
         * @returns {Promise<{[p: string]: any} | {status: boolean}>}
         */
        function checkPassword(pwd) {
            swlogTitle('CHECKING PASSWORD')

            // D4: rehydrate the persisted lockout counters BEFORE reading the
            // gate so the backoff applies on a cold SW.
            return loadLockout().then(() => {

            // Brute-force gate: refuse while a backoff window is active.
            const remaining = getLockoutRemainingMs()
            if (remaining > 0) {
                return Promise.resolve({
                    status: false,
                    reason: 'error.too_many_attempts',
                    retryAfterMs: remaining,
                })
            }

            return browser.storage.local.get({ [CRYPTO_STORE]: {} }).then(stores => {
                if (!stores || stores.hasOwnProperty(CRYPTO_STORE) === false) {
                    swlog('❌ Cannot validate password: Failed to retrieve crypto store data')
                    return { status: false, reason: 'error.failed_to_retrieve_encryption_store_data' }
                }

                const _pat = stores[CRYPTO_STORE]['encryptedApiToken'] || ''

                // D16: feed the encryption params from the store before
                // deriving — the in-memory salt may be null on a cold SW.
                encryptionParams.iv = new Uint8Array(stores[CRYPTO_STORE].iv)
                encryptionParams.salt = new Uint8Array(stores[CRYPTO_STORE].salt)
                encryptionParams.default = stores[CRYPTO_STORE].default ?? true
                encryptionParams.iterations = stores[CRYPTO_STORE].iterations ?? KDF_ITERATIONS_LEGACY

                return deriveKey(pwd, encryptionParams.salt).then(encryptionKey => {
                    return decryptPat(_pat, encryptionKey).then(() => {
                        resetLockout()
                        return { status: true }
                    }, () => {
                        recordFailedAttempt()
                        return { status: false }
                    })
                }, () => {
                    recordFailedAttempt()
                    return { status: false }
                })
            }, () => {
                recordFailedAttempt()
                return { status: false }
            })

            })
        }

        /**
         * Set the password to be used to unlock the extension and encrypt/decrypt the PAT
         * MARK: setPassword()
         *
         * @param pwd
         * @returns {Promise<{status: boolean}>}
         */
        function setPassword(pwd) {
            swlogTitle('SETTING PASSWORD')
            password = pwd
            swlog('🔑 ✔️ Password set')

            return Promise.resolve({ status: true })
        }

        /**
         * Get the current password
         * MARK: getPassword()
         *
         * @returns {Promise<{[p: string]: any}>}
         */
        function getPassword() {
            return Promise.resolve(password)
        }

        /**
         * Generate new encryption iv + salt
         * MARK: generateNewCryptoParams()
         *
         * @param set_default
         * @returns {Promise<void>}
         */
        function generateNewCryptoParams(set_default = false) {
            swlog('♻️ Generating new crypto params...')

            let _iv = cryptoApi.getRandomValues(new Uint8Array(12))
            let _salt = cryptoApi.getRandomValues(new Uint8Array(16))

            // Store the generated salt + iv (the iv is re-generated every time the pat is encrypted)
            return browser.storage.local.set({
                [CRYPTO_STORE]: {
                    iv: Array(...new Uint8Array(_iv)),
                    salt: Array(...new Uint8Array(_salt)),
                    default: set_default,
                    iterations: KDF_ITERATIONS_CURRENT,
                    encryptedApiToken: '',
                }
            }).then(data => {
                encryptionParams.iv = _iv
                encryptionParams.salt = _salt
                encryptionParams.default = set_default
                encryptionParams.iterations = KDF_ITERATIONS_CURRENT

                swlog('♻️ ✔️ Crypto params set and stored (default = ' + set_default + ')')
                return data
            }, data => {
                swlog('♻️ ❌ Cannot store crypto params')
                return data
            })
        }

        /**
         * Set a new password and re-encrypt PAT using the new password-derived key
         * MARK: changePassword()
         *
         * @param pwd
         * @returns {Promise<* | {encryptedApiToken: null, status: boolean}>}
         */
        function changePassword(pwd) {
            swlogTitle('CHANGING PASSWORD')

            // D2: re-encryption needs the decrypted PAT in memory. When the
            // extension is locked the PAT is empty — abort with an explicit,
            // i18n'd error instead of encrypting an empty token and locking
            // the user out.
            if (!state.pat) {
                swlog('❌ Cannot change password: extension is locked (empty PAT)')
                return Promise.resolve({ status: false, reason: 'error.unlock_extension_before_changing_password' })
            }

            return generateNewCryptoParams().then(
                () => setPassword(pwd)
            ).then(
                () => {
                    swlog('🔑 ✔️ Password changed')
                    return encryptPat(state.pat)
                },
                () => {
                    swlog('🔑 ❌ Failed to set password')
                    return { status: false, encryptedApiToken: null, reason: 'error.failed_to_set_enc_key' }
                }
            )
        }

        /**
         * Decrypt a text using a given encryption key
         * MARK: decryptPat()
         *
         * @param cipherText
         * @param encryptionKey
         * @returns {Promise<Awaited<string>>|Promise<T | string>}
         */
        function decryptPat(cipherText, encryptionKey) {
            swlog('🔃 Decrypting PAT...')

            if (encryptionKey && cipherText) {
                return decryptAesGcm({
                    subtle: cryptoApi.subtle,
                    decoder: new TextDecoder(),
                    key: encryptionKey,
                    cipherBytes: cipherText,
                    iv: encryptionParams.iv,
                }).catch((ex) => Promise.reject('Error during decrypt: ' + (ex?.message ?? ex)))
            }

            return Promise.reject('Cannot decrypt: missing password or cipherText')
        }

        /**
         * Derive the encryption key from the user password
         * MARK: deriveKey()
         *
         * Thin wrapper over the stateless deriveKey primitive in
         * src/background/crypto.js, injecting the shared cryptoApi/encoder and
         * resolving the iteration count from the active encryption params
         * (loaded from the crypto store for existing ciphertext, or set to
         * KDF_ITERATIONS_CURRENT for fresh encryption).
         *
         * @param key
         * @param salt
         * @param {number} [iterations] Override; defaults to the active params.
         * @returns {Promise<CryptoKey>}
         */
        function deriveKey(key, salt, iterations) {
            swlog('🔀 Deriving encryption key...')

            const iters = iterations ?? encryptionParams.iterations ?? KDF_ITERATIONS_LEGACY

            return deriveKeyRaw({
                subtle: cryptoApi.subtle,
                encoder,
                password: key,
                salt,
                iterations: iters,
            }).then(data => {
                swlog('🔀 ✔️ Derived')

                return data
            }, data => {
                swlog('🔀 ❌ Failure')

                return data
            })
        }

        /**
         * Encrypt the PAT using the current password-derived key and store it in the extension storage
         * MARK: encryptPat()
         *
         * @returns {Promise<{[p: string]: any}>}
         */
        function encryptPat(apiToken) {
            let reason = 'error.unknown_error_during_pat_encryption'
            swlogTitle('ENCRYPTING PAT')

            try {
                // Fresh encryption always uses the current (stronger) KDF
                // count. Decryption of pre-existing ciphertext still uses the
                // count persisted alongside it (see loadState/unlockExt), so
                // this only affects new/re-encrypted PATs.
                encryptionParams.iterations = KDF_ITERATIONS_CURRENT
                return deriveKey(password, encryptionParams.salt).then(encryptionKey => {
                    swlog('🔃 Regenerating encryption iv...')

                    encryptionParams.iv = cryptoApi.getRandomValues(new Uint8Array(12))
                    encryptionParams.default = encryptionKey === null
                    const ivArray = fromUint8Array(encryptionParams.iv)
                    const saltArray = fromUint8Array(encryptionParams.salt)

                    // Persist the iteration count actually used to derive the
                    // key so unlock can reproduce it. generateNewCryptoParams
                    // already set encryptionParams.iterations = CURRENT; we
                    // mirror it into the stored blob so the value survives
                    // reloads (and so this write does not silently drop it).
                    let _cryptoParams = {
                        iv: ivArray,
                        salt: saltArray,
                        default: encryptionParams.default,
                        iterations: encryptionParams.iterations ?? KDF_ITERATIONS_CURRENT,
                        encryptedApiToken: ''
                    }

                    return browser.storage.local.set({
                        [CRYPTO_STORE]: _cryptoParams
                    }).then(() => {
                        swlog('🔃 ✔️ iv regenerated')
                        swlog('🔃 Encrypting PAT...')

                        return encryptAesGcm({
                            subtle: cryptoApi.subtle,
                            encoder,
                            key: encryptionKey,
                            plaintext: apiToken,
                            iv: encryptionParams.iv,
                        }).then(ciphertext => {
                            swlog('🔃 ✔️ PAT encrypted')

                            _cryptoParams.encryptedApiToken = fromUint8Array(ciphertext)

                            return browser.storage.local.set({
                                [CRYPTO_STORE]: _cryptoParams
                            }).then(() => {
                                return { status: true, encryptedApiToken: _cryptoParams.encryptedApiToken }
                            }, () => {
                                swlog('🔃 ❌ Saving encrypted PAT failed)')
                                return { status: false, encryptedApiToken: null, reason: 'error.failed_to_store_encrypted_pat' }
                            })
                        }, () => {
                            swlog('🔃 ❌ Encrypting failed')
                            return { status: false, encryptedApiToken: null, reason: 'error.failed_to_encrypt_pat' }
                        })
                    }, () => {
                        swlog('  failed (encrypting)')
                        return { status: false, encryptedApiToken: null, reason: 'error.failed_to_set_encryption_parameters' }
                    })
                })
            } catch (e) {
                swlog('🔃 ❌ Regenerating encryption iv failed', e)
                reason = 'error.failed_to_regenerate_iv'
            }

            return Promise.resolve({ status: false, encryptedApiToken: null, reason: reason })
        }

        /**
         * Set the lock delay
         * MARK: Set kickAfter
         */
        function setAutolockDelay(delay) {
            swlogTitle('SETTING NEW AUTOLOCK DELAY')
            state.kickAfter = (delay !== null && delay !== 'null') ? parseInt(delay) : null
            swlog('✔️ New autolock delay successfully applied')

            return Promise.resolve({ status: true })
        }
    },
})
