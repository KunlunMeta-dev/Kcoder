import { getRuntimeConfig, joinAppPath } from '@/config/runtime'

export interface BrowserAccessInfo {
  token: string
  localBaseUrl: string
  publicBaseUrl: string | null
}

export async function fetchBrowserAccessInfo(): Promise<BrowserAccessInfo> {
  const apiUrl = joinAppPath(getRuntimeConfig().appBasePath, '/api/gateway/browser-access')
  const response = await fetch(apiUrl, { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error(`获取浏览器访问链接失败（HTTP ${response.status}）`)
  return response.json() as Promise<BrowserAccessInfo>
}

export function createBrowserLoginUrl(baseAddress: string, token: string): string {
  const url = new URL(baseAddress.trim())
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('请输入有效的 Gateway 地址')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/login`
  url.search = new URLSearchParams({
    token,
    returnTo: `${url.pathname.replace(/\/login$/, '') || ''}/`,
  }).toString()
  return url.toString()
}
