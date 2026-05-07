import { useTwofaccounts } from '@popup/stores/twofaccounts'

export default async function checkLock({ to, next, nextMiddleware }) {
    console.log('[EXT:MW:checkLock] Entering middleware to reach the ' + to.name + ' view')
    const { locked } = await sendMessage('CHECK_IS_LOCKED', { }, 'background')

    if (locked) {
        console.log('[EXT:MW:checkLock] Extension locked, clearing popup vault state and moving to the Unlock view')
        useTwofaccounts().$reset()
        next({ name: 'unlock' })
    } else {
        nextMiddleware()
    }
}