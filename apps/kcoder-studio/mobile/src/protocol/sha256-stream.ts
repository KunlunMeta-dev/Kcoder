/** Incremental SHA-256. Memory stays constant regardless of source length. */
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate = (value: number, bits: number) => value >>> bits | value << (32 - bits);
export class Sha256Stream {
  private readonly state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private buffered = 0;
  private length = 0;
  private finished = false;
  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 is already finalized");
    if (!Number.isSafeInteger(this.length + bytes.byteLength) || this.length + bytes.byteLength > Number.MAX_SAFE_INTEGER / 8) throw new Error("SHA-256 input is too large");
    this.length += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(64 - this.buffered, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.buffered);
      this.buffered += take; offset += take;
      if (this.buffered === 64) { this.compress(); this.buffered = 0; }
    }
    return this;
  }
  digestHex(): string {
    if (this.finished) throw new Error("SHA-256 is already finalized");
    this.finished = true;
    this.block[this.buffered++] = 0x80;
    if (this.buffered > 56) { this.block.fill(0, this.buffered); this.compress(); this.buffered = 0; }
    this.block.fill(0, this.buffered, 56);
    const bits = this.length * 8;
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(bits / 0x100000000)); view.setUint32(60, bits >>> 0);
    this.compress();
    return [...this.state].map(value => value.toString(16).padStart(8, "0")).join("");
  }
  private compress(): void {
    const w = this.words; const view = new DataView(this.block.buffer);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) w[i] = w[i - 16]! + (rotate(w[i - 15]!, 7) ^ rotate(w[i - 15]!, 18) ^ w[i - 15]! >>> 3) + w[i - 7]! + (rotate(w[i - 2]!, 17) ^ rotate(w[i - 2]!, 19) ^ w[i - 2]! >>> 10);
    let a = this.state[0]!, b = this.state[1]!, c = this.state[2]!, d = this.state[3]!;
    let e = this.state[4]!, f = this.state[5]!, g = this.state[6]!, h = this.state[7]!;
    for (let i = 0; i < 64; i++) {
      const t = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const u = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t) | 0; d = c; c = b; b = a; a = (t + u) | 0;
    }
    this.state[0] = this.state[0]! + a; this.state[1] = this.state[1]! + b;
    this.state[2] = this.state[2]! + c; this.state[3] = this.state[3]! + d;
    this.state[4] = this.state[4]! + e; this.state[5] = this.state[5]! + f;
    this.state[6] = this.state[6]! + g; this.state[7] = this.state[7]! + h;
  }
}

export interface BoundedByteReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
/** Local-operation macrotask channel. No global worker, queue or connection pool. */
export function createAttachmentMacrotaskYield(): { yield(): Promise<void>; close(): void } {
  if (typeof MessageChannel === "function") {
    const channel = new MessageChannel();
    let pending: (() => void) | undefined;
    channel.port1.onmessage = () => { const resolve = pending; pending = undefined; resolve?.(); };
    return {
      yield: () => new Promise<void>(resolve => { if (pending) throw new Error("Concurrent hash yield"); pending = resolve; channel.port2.postMessage(0); }),
      close: () => { channel.port1.close(); channel.port2.close(); },
    };
  }
  return { yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)), close() {} };
}
/** Check cancellation/owner around every read/yield; return only an exact source hash. */
export async function hashBoundedSource(source: BoundedByteReader, isCurrent: () => boolean, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > 50 * 1024 * 1024) throw new Error("Invalid staged source size");
  const size = source.size;
  const assertCurrent = () => { if (signal?.aborted || !isCurrent()) throw new Error("附件读取已取消或归属已变化"); };
  const clock = () => typeof performance === "object" ? performance.now() : Date.now();
  const scheduler = createAttachmentMacrotaskYield(); const hash = new Sha256Stream();
  let sliceStarted = clock(); let blocks = 0;
  try {
    assertCurrent();
    for (let offset = 0; offset < size; offset += 64 * 1024) {
      assertCurrent();
      const length = Math.min(64 * 1024, size - offset);
      const bytes = await source.read(offset, length);
      assertCurrent();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error("附件原始文件缺失或长度已变化");
      // Bound each synchronous hashing step; fast devices still yield after at most 512 KiB.
      for (let start = 0; start < bytes.byteLength; start += 16 * 1024) {
        hash.update(bytes.subarray(start, Math.min(start + 16 * 1024, bytes.byteLength)));
        if (++blocks >= 32 || clock() - sliceStarted >= 8) {
          await scheduler.yield(); assertCurrent(); blocks = 0; sliceStarted = clock();
        }
      }
    }
    assertCurrent(); return hash.digestHex();
  } finally { scheduler.close(); }
}
