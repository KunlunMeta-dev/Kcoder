/**
 * Plaintext-endpoint policy mirroring `kcoder_config::is_plaintext_remote_endpoint`:
 * plain HTTP outside loopback exposes prompts and completions to the network,
 * so the settings UI asks for explicit confirmation before saving one.
 */
export function isPlaintextRemoteEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false
  const trimmed = endpoint.trim()
  if (!trimmed.startsWith('http://')) return false
  const authority = trimmed
    .slice('http://'.length)
    .split(/[/?#]/)[0]
    .split('@')
    .pop() as string
  const host = authority.startsWith('[')
    ? authority.slice(1, authority.indexOf(']'))
    : authority.split(':')[0].toLowerCase()
  if (host === 'localhost' || host === '::1') return false
  const octets = host.split('.')
  if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part))) {
    return Number(octets[0]) !== 127
  }
  return true
}
