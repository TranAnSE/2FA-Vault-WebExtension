import { httpClientFactory } from '@popup/services/httpClientFactory'

function getApiClient() {
    return httpClientFactory('api')
}

export default {
    getAll() {
        return getApiClient().get('features')
    },

    get(featureName, config = {}) {
        return getApiClient().get('/features/' + featureName, { ...config })
    },
}