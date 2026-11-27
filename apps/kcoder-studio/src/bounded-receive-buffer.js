/** Owned pending bytes; parser views are valid only until the next mutation. */
export class BoundedReceiveBuffer {
  #buffer = Buffer.alloc(0);
  #length = 0;
  #maximumRetainedBytes;

  constructor(maximumRetainedBytes) {
    if (!Number.isSafeInteger(maximumRetainedBytes) || maximumRetainedBytes < 1)
      throw new TypeError('maximumRetainedBytes must be a positive safe integer');
    this.#maximumRetainedBytes = maximumRetainedBytes;
  }

  get length() { return this.#length; }
  get bytes() { return this.#buffer.subarray(0, this.#length); }

  append(chunk) {
    if (!chunk.length) return;
    const length = this.#length + chunk.length;
    if (length > this.#buffer.length) {
      // A batch may contain several complete frames. Only carry-over is capped.
      const capacity = Math.max(length, Math.min(this.#maximumRetainedBytes, this.#buffer.length * 2));
      const grown = Buffer.allocUnsafe(capacity);
      this.#buffer.copy(grown, 0, 0, this.#length);
      this.#buffer = grown;
    }
    chunk.copy(this.#buffer, this.#length);
    this.#length = length;
  }

  retain(rest) {
    if (rest.length > this.#maximumRetainedBytes) throw new Error('Receive buffer is too large');
    if (!rest.length) { this.clear(); return; }
    if (this.#buffer.length > this.#maximumRetainedBytes) this.#buffer = Buffer.from(rest);
    else if (rest.buffer !== this.#buffer.buffer || rest.byteOffset !== this.#buffer.byteOffset)
      rest.copy(this.#buffer, 0);
    this.#length = rest.length;
  }

  clear() { this.#buffer = Buffer.alloc(0); this.#length = 0; }
}
