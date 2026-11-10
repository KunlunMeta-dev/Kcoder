import { describe, expect, it } from "vitest";
import {
  decodePeerBase64,
  decodePeerUtf8,
  encodePeerBase64,
  encodePeerUtf8,
} from "./peer-transport-bytes";

describe("Mobile peer byte helpers", () => {
  it("round trips Unicode without relying on TextEncoder or TextDecoder", () => {
    const text = "设备连接 🌱 café";
    const encoded = encodePeerUtf8(text);
    expect(decodePeerUtf8(encoded)).toBe(text);
  });

  it("round trips empty, binary, and sliced byte arrays through base64", () => {
    expect(encodePeerBase64(new Uint8Array())).toBe("");
    expect(decodePeerBase64("")).toEqual(new Uint8Array());
    const source = Uint8Array.from([0, 1, 127, 128, 255]);
    const slice = source.subarray(1, 4);
    expect(decodePeerBase64(encodePeerBase64(slice))).toEqual(slice);
  });

  it("rejects malformed UTF-8 instead of silently changing WebSocket text", () => {
    expect(() => decodePeerUtf8(Uint8Array.from([0xc0, 0xaf]))).toThrow("Invalid UTF-8");
  });
});
