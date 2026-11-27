import { BoundedReceiveBuffer } from './bounded-receive-buffer.js';

export class BoundedJsonlDecoder {
  #buffer;
  #maximumLineBytes;
  #previewBytes;
  #utf8;
  #oversized = null;

  constructor(maximumLineBytes, previewBytes = 4096, { strictUtf8 = false } = {}) {
    if (!Number.isInteger(maximumLineBytes) || maximumLineBytes < 1) {
      throw new TypeError("maximumLineBytes must be a positive integer");
    }
    this.#maximumLineBytes = maximumLineBytes;
    this.#previewBytes = previewBytes;
    this.#buffer = new BoundedReceiveBuffer(maximumLineBytes);
    this.#utf8 = strictUtf8 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : null;
  }

  /**
   * Push a chunk. Oversized lines and invalid UTF-8 in strict mode are
   * reported as dropped, with a head preview for request correlation.
   * Each drop records how many complete lines preceded it in this batch.
   * The decoder resynchronizes at the next newline.
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
        dropped.push({ ...this.#finalizeOversized(), precedingLines: lines.length });
      } else if (this.#buffer.length + segment.length > this.#maximumLineBytes) {
        dropped.push({ ...this.#dropSegment(segment), precedingLines: lines.length });
      } else {
        let line = this.#buffer.length
          ? Buffer.concat([this.#buffer.bytes, segment])
          : segment;
        this.#buffer.clear();
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        this.#decodeLine(line, lines, dropped);
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
      this.#buffer.clear();
    } else if (remainder.length) {
      this.#buffer.append(remainder);
    }
    return { lines, dropped };
  }

  finish() {
    const dropped = this.#oversized ? [this.#finalizeOversized()] : [];
    if (!this.#buffer.length) return { lines: [], dropped };
    const lines = [];
    this.#decodeLine(this.#buffer.bytes, lines, dropped);
    this.#buffer.clear();
    return { lines, dropped };
  }

  #decodeLine(line, lines, dropped) {
    try {
      lines.push(this.#utf8 ? this.#utf8.decode(line) : line.toString('utf8'));
    } catch (error) {
      if (!this.#utf8 || !(error instanceof TypeError)) throw error;
      // A preview can correlate a receipt, but the invalid line never reaches JSON parsing.
      dropped.push({ bytes: line.length, preview: line.subarray(0, this.#previewBytes).toString('utf8'),
        precedingLines: lines.length, invalidUtf8: true });
    }
  }

  #dropSegment(segment) {
    const dropped = {
      bytes: this.#buffer.length + segment.length,
      preview: this.#previewOf(segment),
    };
    // Reset discarded partial bytes so the next line starts with a fresh budget.
    // Otherwise every later chunk would inherit the oversized line and fail.
    this.#buffer.clear();
    return dropped;
  }

  #previewOf(tail) {
    if (!this.#buffer.length) return tail.subarray(0, this.#previewBytes).toString("utf8");
    const head = this.#buffer.bytes.subarray(0, this.#previewBytes);
    if (head.length >= this.#previewBytes) return head.toString("utf8");
    return Buffer.concat([head, tail.subarray(0, this.#previewBytes - head.length)]).toString("utf8");
  }

  #finalizeOversized() {
    const dropped = { bytes: this.#oversized.bytes, preview: this.#oversized.preview };
    this.#oversized = null;
    return dropped;
  }
}
