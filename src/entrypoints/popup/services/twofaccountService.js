import { httpClientFactory } from '@popup/services/httpClientFactory'

function getApiClient() {
    return httpClientFactory('api')
}

export default {
    getAll(withOtp = false, config = {}) {
        return getApiClient().get('/twofaccounts' + (withOtp ? '?withOtp=1' : ''), { ...config })
    },

    getEncrypted(config = {}) {
        return getApiClient().get('/twofaccounts/encrypted', { ...config })
    },

    getByIds(ids, withOtp = false, config = {}) {
        return getApiClient().get('/twofaccounts?ids=' + ids + (withOtp ? '&withOtp=1' : ''), { ...config })
    },

    get(id, config = {}) {
        return getApiClient().get('/twofaccounts/' + id, { ...config })
    },

    preview(uri, config = {}) {
        return getApiClient().post('/twofaccounts/preview', { uri: uri }, { ...config })
    },

    storeFromUri(uri, config = {}) {
        return getApiClient().post('/twofaccounts', { uri: uri }, { ...config })
    },

    getLogo(service, config = {}) {
        return getApiClient().post('/icons/default', { service: service }, { ...config })
    },

    deleteIcon(icon, config = {}) {
        return getApiClient().delete('/icons/' + icon, { ...config })
    },

    getOtpById(id, config = {}) {
        return getApiClient().get('/twofaccounts/' + id + '/otp', { ...config })
    },

    updateCounter(id, counter, config = {}) {
        return getApiClient().patch('/twofaccounts/' + id + '/counter', { counter }, { ...config })
    },

    getOtpByUri(uri, config = {}) {
        return getApiClient().post('/twofaccounts/otp', { uri: uri }, { ...config })
    },

    getOtpByParams(params, config = {}) {
        return getApiClient().post('/twofaccounts/otp', params, { ...config })
    },

    withdraw(ids, config = {}) {
        return getApiClient().patch('/twofaccounts/withdraw?ids=' + ids.join(), { ...config })
    },

    saveOrder(orderedIds, config = {}) {
        return getApiClient().post('/twofaccounts/reorder', { orderedIds: orderedIds }, { ...config })
    },

    batchDelete(ids, config = {}) {
        return getApiClient().delete('/twofaccounts?ids=' + ids, { ...config })
    },

    export(ids, otpauthFormat, config = {}) {
        return getApiClient().get('/twofaccounts/export?ids=' + ids + (otpauthFormat ? '&otpauth=1' : ''), { ...config })
    },

    getQrcode(id, config = {}) {
        return getApiClient().get('/twofaccounts/' + id + '/qrcode', { ...config })
    },

    migrate(payload, config = {}) {
        return getApiClient().post('/twofaccounts/migration', { payload: payload, withSecret: true }, { ...config })
    },

    count(config = {}) {
        return getApiClient().get('/twofaccounts/count', { ...config })
    },
    
}
