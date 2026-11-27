/** File/Blob snapshots owned views itself; only shared backing needs a copy first. */
export function blobBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return new Uint8Array(bytes)
}
