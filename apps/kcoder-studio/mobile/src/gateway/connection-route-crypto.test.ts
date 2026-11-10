import { createHash, randomFillSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const nativeCrypto = vi.hoisted(() => ({
  digest: vi.fn(),
  getRandomValues: vi.fn(),
  aes: { EncryptionKey: class {}, SealedData: class {} },
}));

vi.mock("expo", () => ({
  NativeModule: class {},
  UnavailabilityError: class extends Error {},
  requireNativeModule: (name: string) => {
    if (name === "ExpoCrypto") return nativeCrypto;
    if (name === "ExpoCryptoAES") return nativeCrypto.aes;
    throw new Error(`unexpected native module: ${name}`);
  },
}));

import { digestGatewayRouteBytes, getGatewayRouteRandomBytes } from "./connection-route-crypto";

beforeEach(() => {
  vi.stubGlobal("__DEV__", false);
  nativeCrypto.digest.mockReset().mockImplementation((algorithm: string, output: Uint8Array, input: Uint8Array) => {
    // Expo Android accesses the typed array's .buffer and .byteOffset through JSI.
    if (!ArrayBuffer.isView(input) || !(input.buffer instanceof ArrayBuffer)) {
      throw new TypeError("no ArrayBuffer attached");
    }
    expect(algorithm).toBe("SHA-256");
    output.set(createHash("sha256").update(input).digest());
  });
  nativeCrypto.getRandomValues.mockReset().mockImplementation((output: Uint8Array) => randomFillSync(output));
});

afterEach(() => vi.unstubAllGlobals());

it("hashes a QR public key through the real Expo JS wrapper with Android-compatible input", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const original = key.slice();

  const digest = await digestGatewayRouteBytes(key.buffer);

  expect(Buffer.from(digest).toString("hex")).toBe(createHash("sha256").update(original).digest("hex"));
  expect(nativeCrypto.digest).toHaveBeenCalledOnce();
  expect(nativeCrypto.digest.mock.calls[0][2]).toBeInstanceOf(Uint8Array);
  expect(key).toEqual(original);
});

it("preserves a native crypto failure for the pairing caller", async () => {
  const failure = new Error("native crypto is unavailable");
  nativeCrypto.digest.mockImplementationOnce(() => { throw failure; });

  await expect(digestGatewayRouteBytes(new ArrayBuffer(32))).rejects.toBe(failure);
});

it("uses native randomness for the public connection-proof nonce", async () => {
  const nonce = await getGatewayRouteRandomBytes(24);

  expect(nonce).toBeInstanceOf(Uint8Array);
  expect(nonce).toHaveLength(24);
  expect(nativeCrypto.getRandomValues).toHaveBeenCalledOnce();
  expect(nativeCrypto.getRandomValues.mock.calls[0][0]).toBe(nonce);
});
