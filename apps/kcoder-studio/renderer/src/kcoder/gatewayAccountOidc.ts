export interface AccountOidcChallenge {
  clientRequestId: string
  authorizationUrl: string
  expiresIn: number
}
export interface AccountOidcStatus {
  status: 'starting' | 'pending' | 'exchanging' | 'authenticated' | 'failed'
  error?: string
}

async function result<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error || 'Organization SSO is unavailable')
  return body
}

export async function startGatewayAccountOidc(
  serverId: string,
  username: string,
  clientRequestId: string,
  locale: string,
  signal: AbortSignal
) {
  return result<AccountOidcChallenge>(
    await fetch(`/api/servers/${encodeURIComponent(serverId)}/account/oidc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        clientRequestId,
        locale: locale.startsWith('en') ? 'en' : 'zh-CN',
      }),
      signal,
    })
  )
}
export async function readGatewayAccountOidc(
  serverId: string,
  clientRequestId: string,
  signal: AbortSignal
) {
  return result<AccountOidcStatus>(
    await fetch(
      `/api/servers/${encodeURIComponent(serverId)}/account/oidc?clientRequestId=${encodeURIComponent(clientRequestId)}`,
      { signal }
    )
  )
}
export async function cancelGatewayAccountOidc(serverId: string, clientRequestId: string) {
  return result<AccountOidcStatus>(
    await fetch(
      `/api/servers/${encodeURIComponent(serverId)}/account/oidc?clientRequestId=${encodeURIComponent(clientRequestId)}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }
    )
  )
}
