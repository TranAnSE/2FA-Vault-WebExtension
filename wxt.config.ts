import { fileURLToPath } from 'node:url'
import { defineConfig } from 'wxt'
import { defineViteConfig as define } from './define.config.js'
import vueI18n from '@intlify/unplugin-vue-i18n/vite'
// import vue from '@vitejs/plugin-vue'

const modulePath = (path: string) => fileURLToPath(new URL(`./node_modules/${path}`, import.meta.url))

const resolvePeerImports = {
    name: 'resolve-peer-imports',
    resolveId(source: string) {
        const aliases = new Map([
            ['@2fauth/formcontrols', modulePath('@2fauth/formcontrols/dist/index.mjs')],
            ['@2fauth/stores', modulePath('@2fauth/stores/dist/index.mjs')],
            ['@2fauth/ui', modulePath('@2fauth/ui/dist/index.mjs')],
            ['@vueuse/components', modulePath('@vueuse/components/dist/index.js')],
            ['@vueuse/core', modulePath('@vueuse/core/dist/index.js')],
            ['lucide-vue-next', modulePath('lucide-vue-next/dist/esm/lucide-vue-next.js')],
            ['vue-i18n/dist/vue-i18n.runtime.esm-bundler.js', modulePath('vue-i18n/dist/vue-i18n.runtime.esm-bundler.js')],
        ])

        return aliases.get(source) ?? null
    },
}

// See https://wxt.dev/api/config.html
export default defineConfig({
    srcDir: 'src',
    outDir: 'dist',
    modules: [
        '@wxt-dev/module-vue'
    ],
    manifest: ({ browser, manifestVersion, mode, command }) => {
        const permissions = [
            'storage',
            'unlimitedStorage',
            'clipboardWrite',
            'alarms',
            'idle',
            'activeTab',
            'scripting',
            'tabs',
            'notifications',
        ]

        if (browser === 'chrome' || browser === 'edge' ) {
            permissions.push('offscreen')
        }

        const action = {
            default_popup: 'src/entrypoints/popup/index.html',
            default_title: '2FA-Vault',
            default_icon: {
                16: 'icon-16.png',
                32: 'icon-32.png',
                64: 'icon-64.png',
            },
        }

        const manifest = {
            name: '__MSG_extName__',
            description: '__MSG_extDescription__',
            permissions: permissions,
            default_locale: 'en',
            icons: {
                16: 'icon-16.png',
                32: 'icon-32.png',
                48: 'icon-48.png',
                96: 'icon-96.png',
                128: 'icon-128.png',
            },
            action: action,
        }

        if (manifestVersion === 3) {
            manifest.content_security_policy = {
                extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
            }
        }

        return manifest
    },
    imports: {
        eslintrc: {
            enabled: 9,
        },
        addons: {
            // vueTemplate automatically set to true by @wxt-dev/module-vue
            vueDirectives: true,
        },
        imports: [
            { name: 'useNotification', from: '@kyvg/vue3-notification' },
            { name: 'onMessage', from: 'webext-bridge/background' },
            { name: 'sendMessage', from: 'webext-bridge/popup' },
        ],
        // dirs: [
        // ],
        presets: [
            // vue preset is automatically imported by @wxt-dev/module-vue
            // vue-i18n preset is automatically imported by @wxt-dev/i18n
            'vue-router',
            'pinia',
            '@vueuse/core',
        ],
        
    },
    vite: () => ({
        build: {
            // emptyOutDir: true,
            // sourcemap: 'development' === process.env.NODE_ENV,
            // sourcemap: true
        },
        plugins: [
            resolvePeerImports,
            // vue(),
            vueI18n({
                include: [
                    'resources/lang/bg.json',
                    'resources/lang/zh-CN.json',
                    'resources/lang/da.json',
                    'resources/lang/nl.json',
                    'resources/lang/en.json',
                    'resources/lang/fr.json',
                    'resources/lang/de.json',
                    'resources/lang/hi.json',
                    'resources/lang/it.json',
                    'resources/lang/ja.json',
                    'resources/lang/ko.json',
                    'resources/lang/pt-BR.json',
                    'resources/lang/ru.json',
                    'resources/lang/es-ES.json',
                    'resources/lang/tr.json',
                ]
            }),
        ],
        define,
        resolve: {
            alias: [
                { find: '@2fauth/formcontrols', replacement: fileURLToPath(new URL('./node_modules/@2fauth/formcontrols/dist/index.mjs', import.meta.url)) },
                { find: '@2fauth/stores', replacement: fileURLToPath(new URL('./node_modules/@2fauth/stores/dist/index.mjs', import.meta.url)) },
                { find: '@2fauth/styles', replacement: fileURLToPath(new URL('./node_modules/@2fauth/styles', import.meta.url)) },
                { find: '@2fauth/ui', replacement: fileURLToPath(new URL('./node_modules/@2fauth/ui/dist/index.mjs', import.meta.url)) },
                { find: '@vueuse/components', replacement: fileURLToPath(new URL('./node_modules/@vueuse/components/dist/index.js', import.meta.url)) },
                { find: '@vueuse/core', replacement: fileURLToPath(new URL('./node_modules/@vueuse/core/dist/index.js', import.meta.url)) },
                { find: 'lucide-vue-next', replacement: fileURLToPath(new URL('./node_modules/lucide-vue-next/dist/esm/lucide-vue-next.js', import.meta.url)) },
                { find: 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js', replacement: fileURLToPath(new URL('./node_modules/vue-i18n/dist/vue-i18n.runtime.esm-bundler.js', import.meta.url)) },
            ],
            dedupe: [
                'pinia',
                '@kyvg/vue3-notification',
            ],
        },
    }),
    alias: {
        '@popup': 'src/entrypoints/popup',
        '@public': 'src/public'
    }
})
