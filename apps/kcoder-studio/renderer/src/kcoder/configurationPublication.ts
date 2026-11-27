/** Only known publisher phase codes establish uncertainty; arbitrary outcome metadata does not. */
export function configurationPublicationCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const code = (value as { code?: unknown }).code
  return code === 'CONFIG_FILE_PUBLISH_UNCONFIRMED' ||
    code === 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED'
    ? code
    : null
}

export function isConfigurationPublicationUnconfirmed(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const value = error as Error & { code?: unknown; data?: unknown; uncertain?: boolean }
  return (
    value.uncertain === true &&
    Boolean(configurationPublicationCode(value) || configurationPublicationCode(value.data))
  )
}

export class SshSettingsRequestError extends Error {
  readonly code: string | null
  readonly uncertain: boolean
  readonly status: number
  constructor(status: number, body: unknown) {
    const code = configurationPublicationCode(body)
    super(code ?? `SSH settings request failed (HTTP ${status})`)
    this.name = 'SshSettingsRequestError'
    this.status = status
    this.code = code
    this.uncertain = code !== null
  }
}
