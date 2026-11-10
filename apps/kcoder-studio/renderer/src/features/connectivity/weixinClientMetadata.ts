// Public Tencent iLink client metadata shared by QR and manual authorization.
export const WEIXIN_APP_ID = 'bot'
export const WEIXIN_BOT_TYPE = '3'

export function currentWeixinClientVersion(): number | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(
    __KCODER_STUDIO_APP_VERSION__
  )
  if (!match) return undefined
  const parts = match.slice(1, 4).map(Number)
  if (parts.some(value => !Number.isSafeInteger(value) || value > 255)) return undefined
  const value = (parts[0] << 16) | (parts[1] << 8) | parts[2]
  return value > 0 ? value : undefined
}
