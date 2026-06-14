browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Theme detection (Chrome MV3 has no DOM matchMedia in the SW)
    if (msg === 'checkDarkTheme') {
        sendResponse(matchMedia('(prefers-color-scheme: dark)').matches)
        return
    }

    // Clipboard relay — the MV3 service worker cannot write to the clipboard,
    // so the background asks this offscreen document (which has a DOM context) to do it.
    if (msg && typeof msg === 'object' && msg.type === 'clipboard-write') {
        navigator.clipboard.writeText(msg.text).then(
            () => sendResponse({ status: true }),
            (error) => sendResponse({ status: false, error: error?.message || 'clipboard write failed' })
        )
        // Return true to keep sendResponse channel open for the async write
        return true
    }
})
