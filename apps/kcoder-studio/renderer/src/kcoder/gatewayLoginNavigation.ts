import { getRuntimeConfig, joinAppPath } from '@/config/runtime'
import { LOGIN_PATH, sanitizeRedirectPath } from '@/features/auth/redirect'

export function gatewayLoginUrl(
  locationLike: Pick<Location, 'pathname' | 'search'> = window.location
) {
  const basePath = getRuntimeConfig().appBasePath
  const loginPath = joinAppPath(basePath, LOGIN_PATH)
  const returnTo = sanitizeRedirectPath(`${locationLike.pathname}${locationLike.search}`, [
    loginPath,
  ])
  if (!returnTo) return loginPath
  return `${loginPath}?returnTo=${encodeURIComponent(returnTo)}`
}

export function navigateGatewayLogin() {
  window.location.assign(gatewayLoginUrl())
}
