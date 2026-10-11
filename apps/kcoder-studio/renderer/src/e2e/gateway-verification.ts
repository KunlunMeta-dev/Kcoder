export interface GatewayVerificationConfig {
  origin: string
  controlUrl: string
  token: string
  nativeIsolation?: Promise<boolean[]>
}

declare global {
  interface Window {
    __KCODER_AI_VERIFY__?: GatewayVerificationConfig
  }
}

export function gatewayVerificationConfig(): GatewayVerificationConfig | null {
  if (typeof window === 'undefined') return null
  const config = window.__KCODER_AI_VERIFY__
  if (!config) return null
  const isLoopback = (value: string) => {
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value)
    return Boolean(match && Number(match[1]) <= 65535)
  }
  if (
    config.origin !== window.location.origin ||
    !isLoopback(config.origin) ||
    !isLoopback(config.controlUrl) ||
    config.controlUrl === config.origin ||
    !/^[a-zA-Z0-9]{32,}$/.test(config.token)
  )
    return null
  return config
}
