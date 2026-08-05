import { defineConfig } from 'vitest/config'

// Vitest config for the browser extension.
//
// The extension's source uses the WXT-injected `browser` global and the
// `webext-bridge` module, which only exist in an extension runtime. Pure-logic
// modules extracted under src/background/ are written to accept their
// dependencies (storage, timers) so they can be exercised here without an
// extension host.
export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['src/**/*.test.js', 'src/**/*.test.ts'],
    },
})
