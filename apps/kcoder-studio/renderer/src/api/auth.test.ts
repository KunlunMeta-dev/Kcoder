import { beforeEach, describe, expect, test } from 'vitest'
import { getToken, removeToken, setToken } from './auth'

function createJwt(expSeconds: number) {
  const payload = btoa(JSON.stringify({ exp: expSeconds }))
  return `header.${payload}.signature`
}

describe('auth token lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  })


  test('stores token, expiration, and cookie using Wegent keys', () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600
    const token = createJwt(expSeconds)

    setToken(token)

    expect(getToken()).toBe(token)
    expect(localStorage.getItem('auth_token_expire')).toBe(String(expSeconds * 1000))
    expect(document.cookie).toContain(`auth_token=${encodeURIComponent(token)}`)
  })


  test('removes token and cookie', () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) + 3600))

    removeToken()

    expect(getToken()).toBeNull()
    expect(localStorage.getItem('auth_token_expire')).toBeNull()
    expect(document.cookie).not.toContain('auth_token=')
  })
})
