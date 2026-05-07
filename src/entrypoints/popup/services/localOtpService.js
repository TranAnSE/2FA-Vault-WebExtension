import { formatOtpResponse, generateHotp, generateTotp } from '@popup/services/e2eeCryptoService'
import twofaccountService from '@popup/services/twofaccountService'

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

        async getOtpByUri() {
            throw new Error('Local OTP generation by URI is not implemented')
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
