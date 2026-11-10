/** LAN HTTP has no SubtleCrypto; content integrity remains mandatory there. */
export async function widgetContentSha256(bytes: Uint8Array): Promise<string> {
  let digest: Uint8Array
  if (globalThis.crypto?.subtle) {
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
  } else {
    const { sha256 } = await import('@noble/hashes/sha2.js')
    digest = sha256(bytes)
  }
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}
