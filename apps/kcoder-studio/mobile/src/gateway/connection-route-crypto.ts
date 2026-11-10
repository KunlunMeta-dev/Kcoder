/** Small lazy bridge so legacy Node consumers never load Expo's native modules. */
export async function digestGatewayRouteBytes(data: ArrayBuffer): Promise<Uint8Array> {
  const { CryptoDigestAlgorithm, digest } = await import("expo-crypto");
  // Expo Android's JSI bridge requires a typed array with .buffer and .byteOffset.
  return new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(data)));
}

export async function getGatewayRouteRandomBytes(byteCount: number): Promise<Uint8Array> {
  const { getRandomBytes } = await import("expo-crypto");
  return getRandomBytes(byteCount);
}
