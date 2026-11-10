import { isKCoderGatewayPage } from '@/kcoder/gatewayRpc'

const TOKEN_KEY = 'auth_token'
const TOKEN_EXPIRE_KEY = 'auth_token_expire'
const TOKEN_COOKIE_NAME = 'auth_token'

function getJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function setTokenCookie(token: string, expMs: number | null) {
  const expires = expMs ? new Date(expMs).toUTCString() : ''
  document.cookie = `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax${expires ? `; expires=${expires}` : ''}`
}

function removeTokenCookie() {
  document.cookie = `${TOKEN_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
  const exp = getJwtExp(token)
  if (exp) {
    localStorage.setItem(TOKEN_EXPIRE_KEY, String(exp))
  } else {
    localStorage.removeItem(TOKEN_EXPIRE_KEY)
  }
  setTokenCookie(token, exp)
}

export function getToken(): string | null {
  return isKCoderGatewayPage() ? null : localStorage.getItem(TOKEN_KEY)
}
export function removeToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRE_KEY)
  removeTokenCookie()
}
