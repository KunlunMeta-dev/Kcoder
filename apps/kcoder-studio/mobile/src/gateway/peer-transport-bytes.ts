import { fromByteArray, toByteArray } from "base64-js";

/** UTF-8 encoding without relying on TextEncoder, which Hermes may not provide. */
export function encodePeerUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

/** Strict UTF-8 decoding for WebSocket text frames. */
export function decodePeerUtf8(bytes: Uint8Array): string {
  const units: number[] = [];
  const parts: string[] = [];
  const flush = () => {
    if (units.length) parts.push(String.fromCharCode(...units.splice(0)));
  };
  const continuation = (index: number) => {
    const byte = bytes[index];
    if (byte === undefined || (byte & 0xc0) !== 0x80) throw new TypeError("Invalid UTF-8 peer payload");
    return byte & 0x3f;
  };

  for (let index = 0; index < bytes.length; index += 1) {
    const first = bytes[index]!;
    let codePoint: number;
    if (first <= 0x7f) codePoint = first;
    else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = ((first & 0x1f) << 6) | continuation(index + 1);
      index += 1;
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      if (second === undefined || third === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80 ||
          (first === 0xe0 && second < 0xa0) || (first === 0xed && second >= 0xa0)) {
        throw new TypeError("Invalid UTF-8 peer payload");
      }
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      index += 2;
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const fourth = bytes[index + 3];
      if (second === undefined || third === undefined || fourth === undefined ||
          (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80 || (fourth & 0xc0) !== 0x80 ||
          (first === 0xf0 && second < 0x90) || (first === 0xf4 && second >= 0x90)) {
        throw new TypeError("Invalid UTF-8 peer payload");
      }
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      index += 3;
    } else {
      throw new TypeError("Invalid UTF-8 peer payload");
    }

    if (codePoint <= 0xffff) units.push(codePoint);
    else {
      const adjusted = codePoint - 0x10000;
      units.push(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    }
    if (units.length >= 8192) flush();
  }
  flush();
  return parts.join("");
}

export function encodePeerBase64(bytes: Uint8Array): string {
  return fromByteArray(bytes);
}

export function decodePeerBase64(value: string): Uint8Array {
  return toByteArray(value);
}

export function copyPeerBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export function peerBytesToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}
