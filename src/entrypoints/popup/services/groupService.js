import { httpClientFactory } from '@popup/services/httpClientFactory'

function getApiClient() {
    return httpClientFactory('api')
}

export default {
    /**
     *
     * @returns
     */
    getAll() {
        return getApiClient().get('groups')
    },
}