export class BoundedJsonlDecoder {
  #buffer = Buffer.alloc(0);
  #maximumLineBytes;
  #previewBytes;
  #oversized = null;

  constructor(maximumLineBytes, previewBytes = 4096) {
    if (!Number.isInteger(maximumLineBytes) || maximumLineBytes < 1) {
      throw new TypeError("maximumLineBytes must be a positive integer");
    }
    this.#maximumLineBytes = maximumLineBytes;
    this.#previewBytes = previewBytes;
  }

  /**
   * Push a chunk. Oversized lines never throw: they are reported as dropped
   * (with a head preview so the broker can attribute the failure to a request
   * id) and the decoder resynchronizes at the next newline.
   */
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const lines = [];
    const dropped = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      const segment = bytes.subarray(start, index);
      if (this.#oversized) {
        this.#oversized.bytes += segment.length;
        dropped.push(this.#finalizeOversized());
      } else if (this.#buffer.length + segment.length > this.#maximumLineBytes) {
        dropped.push(this.#dropSegment(segment));
      } else {
        let line = this.#buffer.length
          ? Buffer.concat([this.#buffer, segment])
          : Buffer.from(segment);
        this.#buffer = Buffer.alloc(0);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        lines.push(line.toString("utf8"));
      }
      start = index + 1;
    }
    const remainder = bytes.subarray(start);
    if (this.#oversized) {
      this.#oversized.bytes += remainder.length;
    } else if (this.#buffer.length + remainder.length > this.#maximumLineBytes) {
      this.#oversized = {
        bytes: this.#buffer.length + remainder.length,
        preview: this.#previewOf(remainder),
      };
      this.#buffer = Buffer.alloc(0);
    } else if (remainder.length) {
      this.#buffer = this.#buffer.length
        ? Buffer.concat([this.#buffer, remainder])
        : Buffer.from(remainder);
    }
    return { lines, dropped };
  }

  finish() {
    const dropped = this.#oversized ? [this.#finalizeOversized()] : [];
    if (!this.#buffer.length) return { lines: [], dropped };
    const line = this.#buffer.toString("utf8");
    this.#buffer = Buffer.alloc(0);
    return { lines: [line], dropped };
  }

  #dropSegment(segment) {
    const dropped = {
      bytes: this.#buffer.length + segment.length,
      preview: this.#previewOf(segment),
    };
    // 修订 R4：必须清空 buffer——超限行已丢弃，下一行必须从干净状态起测；
    // 否则 stale partial 会让后续每一行都被判超限而持续丢弃、永远无法 resync
    //（跨 chunk 用例正是钉住这一点）。
    this.#buffer = Buffer.alloc(0);
    return dropped;
  }

  #previewOf(tail) {
    const head = this.#buffer.length
      ? Buffer.concat([this.#buffer, tail])
      : Buffer.from(tail);
    return head.subarray(0, this.#previewBytes).toString("utf8");
  }

  #finalizeOversized() {
    const dropped = { bytes: this.#oversized.bytes, preview: this.#oversized.preview };
    this.#oversized = null;
    return dropped;
  }
}
