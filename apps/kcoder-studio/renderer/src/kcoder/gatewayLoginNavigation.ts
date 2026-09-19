import { LOGIN_PATH, OIDC_CALLBACK_PATH, sanitizeRedirectPath } from '@/features/auth/redirect'

export function gatewayLoginUrl(locationLike: Pick<Location, 'pathname' | 'search'> = window.location) {
  const returnTo = sanitizeRedirectPath(`${locationLike.pathname}${locationLike.search}`, [
    LOGIN_PATH,
    OIDC_CALLBACK_PATH,
  ])
  if (!returnTo) return LOGIN_PATH
  return `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`
}

export function navigateGatewayLogin() {
  window.location.assign(gatewayLoginUrl())
}
