/** Secure WebCrypto adapter used only by the direct-esbuild transport smoke. */
export async function digestGatewayRouteBytes(data: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
}

export async function getGatewayRouteRandomBytes(byteCount: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > 1024) {
    throw new TypeError("Invalid WebCrypto random byte count");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(byteCount));
}
