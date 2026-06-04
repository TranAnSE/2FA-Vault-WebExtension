/**
 * Height hack by Bitwarden:
 * https://github.com/bitwarden/clients/blob/main/apps/browser/src/platform/popup/layout/popup-size.service.ts
 * 
 * Released under https://www.gnu.org/licenses/gpl-3.0.html
 */


export function getPopupHeight() {
    /**
     * To support both browser default zoom and system default zoom, we need to take into account
     * the full screen height. When system default zoom is >100%, window.innerHeight still outputs
     * a height equivalent to what it would be at 100%, which can cause the extension window to
     * render as too tall. So if the screen height is smaller than the max possible extension height,
     * we should use that to set our extension height. Otherwise, we want to use the window.innerHeight
     * to support browser zoom.
     *
     * This is basically a workaround for what we consider a bug with browsers reporting the wrong
     * available innerHeight when system zoom is turned on. If that gets fixed, we can remove the code
     * checking the screen height.
     */
    const MAX_EXT_HEIGHT = 600
    const extensionInnerHeight = window.innerHeight
    // Use a 100px offset when calculating screen height to account for browser container elements
    const screenAvailHeight = window.screen.availHeight - 100
    const availHeight = screenAvailHeight < MAX_EXT_HEIGHT
        ? screenAvailHeight
        : extensionInnerHeight

	return availHeight
}