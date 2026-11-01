import { defineStore } from 'pinia'
import { usePreferenceStore } from '@/stores/preferenceStore'
import { useNotify } from '@2fauth/ui'
import { useErrorHandler } from '@2fauth/stores'
import twofaccountService from '@popup/services/twofaccountService'
import userService from '@popup/services/userService'
import { asArray } from '@popup/composables/helpers'
import i18n from '@/utils/i18n'
import { decryptAccount, deriveVaultKey, exportKey, importKey, verifyVaultKey } from '@popup/services/e2eeCryptoService'

export const useTwofaccounts = defineStore('twofaccounts', () => {

    const preferenceStore = usePreferenceStore()

    // STATE

    const items = ref([])
    // const selectedIds = ref([])
    const filter = ref('')
    const backendWasNewer = ref(false)
    const fetchedOn = ref(null)
    const isFetching = ref(false)
    const groupLessOnly = ref(false)
    const encryptedVaultUnlocked = ref(false)
    const showFavoritesOnly = ref(false)

    // GETTERS

    const filtered = computed(() => {
        return items.value.filter(
            item => {

                if (groupLessOnly.value == true) {
                    return item.group_id == null
                }
                else if (parseInt(preferenceStore.activeGroup) > 0) {
                    var itemMatch = ((item.service ? item.service.toLowerCase().includes(filter.value.toLowerCase()) : false) ||
                        item.account.toLowerCase().includes(filter.value.toLowerCase())) &&
                        (item.group_id == parseInt(preferenceStore.activeGroup))
                }
                else {
                    var itemMatch = ((item.service ? item.service.toLowerCase().includes(filter.value.toLowerCase()) : false) ||
                        item.account.toLowerCase().includes(filter.value.toLowerCase()))
                }

                if (showFavoritesOnly.value) {
                    itemMatch = itemMatch && item.is_favorite == true
                }

                return itemMatch
            }
        )
    })

    /**
     * Lists unique periods used by twofaccounts in the collection
     * ex: The items collection has 3 accounts with a period of 30s and 5 accounts with a period of 40s
     *     => The method will return [30, 40]
     */
    const periods = computed(() => {
        return items.value.filter(account => account.otp_type == 'totp').map(function(item) {
            return { period: item.period, generated_at: item.otp?.generated_at }
        }).filter((value, index, self) => index === self.findIndex((t) => (
            t.period === value.period
        ))).sort()
    })

    const isEmpty = computed(() => items.value.length == 0)
    const count = computed(() => items.value.length)
    const filteredCount = computed(() => filtered.value.length)
    // const orderedIds = computed(() => items.value.map(a => a.id))
    // const selectedCount = computed(() => selectedIds.value.length)
    // const hasNoneSelected = computed(() => selectedIds.value.length)

    // ACTIONS

    function $reset() {
        items.value = []
        filter.value = ''
        backendWasNewer.value = false
        fetchedOn.value = null
        isFetching.value = false
        encryptedVaultUnlocked.value = false
        showFavoritesOnly.value = false
    }

    async function clearVaultSession() {
        // D6: session-only — the E2EE vault key is never written to
        // storage.local (on disk). storage.session exists on Chrome MV3
        // and Firefox >= 115.
        await browser.storage.session?.remove?.('vaultKey')
        $reset()
    }

    /**
     * Refreshes the accounts collection using the backend
     */
    async function fetch(force = false) {
        isFetching.value = true
        // We do not want to fetch fresh data multiple times in the same 2s timespan
        const age = Math.floor(Date.now() - fetchedOn.value)
        const isOutOfAge = age > 2000

        if (isOutOfAge || force) {
            fetchedOn.value = Date.now()

            await twofaccountService.getAll(! preferenceStore.getOtpOnRequest).then(response => {
                setItems(asArray(response?.data), force)
            })
        }
        else backendWasNewer.value = false

        isFetching.value = false
    }

    async function fetchForCurrentVaultState(force = false) {
        const { vaultKey } = await browser.storage.session?.get?.('vaultKey') ?? {}

        if (vaultKey) {
            encryptedVaultUnlocked.value = true
            return fetchEncrypted(await importKey(vaultKey))
        }

        encryptedVaultUnlocked.value = false
        return fetch(force)
    }

    async function unlockEncryptedVault(masterPassword) {
        const { data: encryptionInfo } = await userService.getEncryptionInfo()

        if (!encryptionInfo?.encryption_enabled) {
            encryptedVaultUnlocked.value = false
            return { status: true, encrypted: false }
        }

        const key = await deriveVaultKey(masterPassword, encryptionInfo.encryption_salt)
        const isValid = await verifyVaultKey(encryptionInfo.encryption_test_value, key)

        if (!isValid) {
            return { status: false, reason: 'error.invalid_encryption_password' }
        }

        await browser.storage.session?.set?.({ vaultKey: await exportKey(key) })
        await fetchEncrypted(key)
        encryptedVaultUnlocked.value = true

        return { status: true, encrypted: true }
    }

    async function fetchEncrypted(key) {
        isFetching.value = true

        try {
            const response = await twofaccountService.getEncrypted()
            const decryptedAccounts = await Promise.all(
                asArray(response?.data).map(account => decryptAccount(account, key))
            )

            setItems(decryptedAccounts, true)
            return decryptedAccounts
        } finally {
            isFetching.value = false
        }
    }

    function setItems(backendItems, force = false) {
        if (force) {
            backendWasNewer.value = backendItems.length !== items.value.length

            items.value.forEach((item) => {
                let matchingBackendItem = backendItems.find(e => e.id === item.id)
                if (matchingBackendItem == undefined) {
                    backendWasNewer.value = true
                    return;
                }
                for (const field in item) {
                    if (field !== 'otp' && item[field] != matchingBackendItem[field]) {
                        backendWasNewer.value = true
                        return;
                    }
                }
            })
        }

        items.value = backendItems
    }

    /**
     * Gets the IDs of all accounts that match the given period
     * @param {*} period 
     * @returns {Array<Number>} IDs of matching accounts
     */
    function accountIdsWithPeriod(period) {
        return items.value.filter(a => a.period == period).map(item => item.id)
    }
    
    /**
     * Toggle the favorite status of an account (optimistic PATCH with
     * revert-on-error handled by the caller-provided error path)
     */
    async function toggleIsFavorite(accountId) {
        const notify = useNotify()
        const errorHandler = useErrorHandler()
        const index = items.value.findIndex(acc => acc.id === parseInt(accountId))

        if (index > -1) {
            const is_favorite = !items.value[index].is_favorite

            await twofaccountService.toggleFavorite(accountId, is_favorite, { returnError: true }).then(() => {
                items.value[index].is_favorite = is_favorite
            })
            .catch(error => {
                if (error.response && error.response.status < 500) {
                    notify.alert({ text: i18n.global.t('error.failed_to_set_favorite_status') })
                }
                else {
                    errorHandler.show(error)
                }
            })
        }
        else {
            notify.alert({ text: i18n.global.t('error.failed_to_set_favorite_status') })
        }
    }

    /**
     * Get a 2FA account by its ID
     */
    function getById(id) {
        return items.value.find(a => a.id == id)
    }

    return {
        // STATE
        items,
        // selectedIds,
        filter,
        backendWasNewer,
        fetchedOn,
        isFetching,
        groupLessOnly,
        encryptedVaultUnlocked,
        showFavoritesOnly,

        // GETTERS
        filtered,
        periods,
        isEmpty,
        count,
        filteredCount,

        // ACTIONS
        $reset,
        fetch,
        fetchForCurrentVaultState,
        unlockEncryptedVault,
        fetchEncrypted,
        clearVaultSession,
        accountIdsWithPeriod,
        toggleIsFavorite,
        getById,
    }
})
