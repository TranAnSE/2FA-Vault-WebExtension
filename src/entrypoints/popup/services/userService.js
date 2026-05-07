import { httpClientFactory } from '@popup/services/httpClientFactory'

function getApiClient() {
    return httpClientFactory('api')
}

export default {
    /**
     * Get current signed-in user
     * 
     * @returns promise
     */
    get(config = {}) {
        return getApiClient().get('/user', { ...config })
    },

    /**
     * Get current signed-in user preferences
     * 
     * @returns promise
     */
    getPreferences(config = {}) {
        return getApiClient().get('/user/preferences', { ...config })
    },

    getEncryptionInfo(config = {}) {
        return getApiClient().get('/encryption/info', { ...config })
    },

}