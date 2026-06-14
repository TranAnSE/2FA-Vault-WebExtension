<script setup>
    import { sendMessage } from 'webext-bridge/popup'
    import { RouterView, useRoute } from 'vue-router'
    import { usePreferenceStore } from '@/stores/preferenceStore'
    import { useSettingStore } from '@/stores/settingStore'
    import { useBusStore } from '@popup/stores/bus'
    import { useTwofaccounts } from '@popup/stores/twofaccounts'
    import { Kicker } from '@2fauth/ui'

    const preferenceStore = usePreferenceStore()
    const settingStore = useSettingStore()
    const bus = useBusStore()
    const twofaccounts = useTwofaccounts()
    const route = useRoute()
    const router = useRouter()
    const kickUser = ref(null)
    const kickUserAfter = ref(null)
    const isProtectedRoute = ref(route.meta.watchedByKicker)

    watch(
        () => route.name,
        () => {
            isProtectedRoute.value = route.meta.watchedByKicker
        }
    )

    onBeforeMount(async () => {
        const { language } = useNavigatorLanguage()
        await preferenceStore.$persistedState.isReady()

        sendMessage('CHECK_IS_LOCKED', { }, 'background').then(({locked}) => {
            if (! locked && settingStore.isConfigured) {
                preferenceStore.syncWithServer()
                settingStore.fetchFeatureFlags()
            }
        })
        
        kickUser.value = preferenceStore.kickUserAfter !== null && preferenceStore.kickUserAfter !== 'null'
        kickUserAfter.value = parseInt(preferenceStore.kickUserAfter)

        watch(
            () => preferenceStore.kickUserAfter,
            () => {
                kickUser.value = preferenceStore.kickUserAfter !== null && preferenceStore.kickUserAfter !== 'null'
                kickUserAfter.value = parseInt(preferenceStore.kickUserAfter)
            }
        )
        watch(language, () => {
            preferenceStore.applyLanguage()
        })

        preferenceStore.applyTheme()
        preferenceStore.applyLanguage()
        preferenceStore.resetGroupFilter()
    })

    onMounted(async () => {
        // Ask the background to refresh the TOTP countdown badge immediately on popup open
        // (the 1-minute alarm alone would otherwise leave it stale).
        sendMessage('refresh-badge', {}, 'background').catch(() => {})

        const result = await sendMessage('IS_THERE_QR', {}, 'background')

        if (result.hasQR) {
            bus.hasQR = true
            router.push({ name: 'createAccount' })
        }
        else bus.hasQR = false
    })

    // Locks the extension
    async function lockExtension() {
        await sendMessage('LOCK_EXTENSION', { }, 'background')
        await twofaccounts.clearVaultSession()

        router.push({ name: 'unlock' })
    }

</script>

<template>
    <notifications
        id="vueNotification"
        role="alert"
        width="100%"
        position="top"
        :duration="4000"
        :speed="0"
        :max="1"
        classes="notification notification-banner is-radiusless" />
    <main class="main-section">
        <RouterView />
    </main>
    <Kicker
        v-if="kickUser && kickUserAfter > 0 && isProtectedRoute"
        :kickAfter="kickUserAfter"
        @kicked="lockExtension"
    />
</template>