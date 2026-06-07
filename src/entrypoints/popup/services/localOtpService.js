import { formatOtpResponse, generateHotp, generateTotp } from '@popup/services/e2eeCryptoService'
import twofaccountService from '@popup/services/twofaccountService'

function parseOtpAuthUri(uri) {
    const url = new URL(uri)
    const otp_type = url.host // 'totp' or 'hotp'
    const label = decodeURIComponent(url.pathname.slice(1))
    const params = Object.fromEntries(url.searchParams.entries())

    return {
        otp_type,
        service: label.includes(':') ? label.split(':')[0].trim() : label,
        account: label.includes(':') ? label.split(':')[1].trim() : '',
        secret: params.secret ?? '',
        algorithm: params.algorithm ?? 'SHA1',
        digits: Number(params.digits ?? 6),
        period: Number(params.period ?? 30),
        counter: Number(params.counter ?? 0),
    }
}

function getAccounts(accountsSource) {
    return typeof accountsSource === 'function' ? accountsSource() : accountsSource
}

function findAccount(accountsSource, accountId) {
    return getAccounts(accountsSource).find(account => String(account.id) === String(accountId))
}

export function createLocalOtpService(accountsSource) {
    return {
        async get(accountId) {
            const account = findAccount(accountsSource, accountId)

            if (!account) {
                throw new Error(`Account ${accountId} not found in local vault state`)
            }

            return { data: account }
        },

        async getOtpById(accountId) {
            const account = findAccount(accountsSource, accountId)

            if (!account) {
                throw new Error(`Account ${accountId} not found in local vault state`)
            }

            if (account.otp_type?.includes('hotp')) {
                const otp = await generateHotp(account.secret, Number(account.counter ?? 0), {
                    otpType: account.otp_type,
                    algorithm: account.algorithm,
                    digits: account.digits,
                    period: account.period,
                })
                await twofaccountService.updateCounter(account.id, otp.counter, { returnError: true })
                account.counter = otp.counter
                return { data: formatOtpResponse(account, otp) }
            }

            const currentOtp = await generateTotp(account.secret, Date.now(), {
                otpType: account.otp_type,
                algorithm: account.algorithm,
                digits: account.digits,
                period: account.period,
            })
            const nextOtp = await generateTotp(account.secret, Date.now() + (Number(account.period ?? 30) * 1000), {
                otpType: account.otp_type,
                algorithm: account.algorithm,
                digits: account.digits,
                period: account.period,
            })

            return {
                data: {
                    ...formatOtpResponse(account, currentOtp),
                    next_password: nextOtp.password,
                },
            }
        },

        async getOtpByUri(uri) {
            const params = parseOtpAuthUri(uri)

            if (params.otp_type?.includes('hotp')) {
                const otp = await generateHotp(params.secret, Number(params.counter ?? 0), {
                    otpType: params.otp_type,
                    algorithm: params.algorithm,
                    digits: params.digits,
                    period: params.period,
                })
                return { data: formatOtpResponse(params, otp) }
            }

            const currentOtp = await generateTotp(params.secret, Date.now(), {
                otpType: params.otp_type,
                algorithm: params.algorithm,
                digits: params.digits,
                period: params.period,
            })
            const nextOtp = await generateTotp(params.secret, Date.now() + (Number(params.period ?? 30) * 1000), {
                otpType: params.otp_type,
                algorithm: params.algorithm,
                digits: params.digits,
                period: params.period,
            })

            return {
                data: {
                    ...formatOtpResponse(params, currentOtp),
                    next_password: nextOtp.password,
                },
            }
        },

        async getOtpByParams(otpauthParams) {
            if (otpauthParams.otp_type?.includes('hotp')) {
                const otp = await generateHotp(otpauthParams.secret, Number(otpauthParams.counter ?? 0), {
                    otpType: otpauthParams.otp_type,
                    algorithm: otpauthParams.algorithm,
                    digits: otpauthParams.digits,
                    period: otpauthParams.period,
                })

                return { data: formatOtpResponse(otpauthParams, otp) }
            }

            const currentOtp = await generateTotp(otpauthParams.secret, Date.now(), {
                otpType: otpauthParams.otp_type,
                algorithm: otpauthParams.algorithm,
                digits: otpauthParams.digits,
                period: otpauthParams.period,
            })
            const nextOtp = await generateTotp(otpauthParams.secret, Date.now() + (Number(otpauthParams.period ?? 30) * 1000), {
                otpType: otpauthParams.otp_type,
                algorithm: otpauthParams.algorithm,
                digits: otpauthParams.digits,
                period: otpauthParams.period,
            })

            return {
                data: {
                    ...formatOtpResponse(otpauthParams, currentOtp),
                    next_password: nextOtp.password,
                },
            }
        },
    }
}
