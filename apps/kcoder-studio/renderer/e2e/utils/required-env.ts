export function requiredE2EUrl(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be injected by the owned E2E runner`)
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error(`${name} must be an owned http://127.0.0.1:<port> URL`)
  }
  return url.origin
}
