const DEFAULT_MAX_CHARACTERS = 1_000_000;
const DEFAULT_MAX_LINES = 10_000;
const COALESCE_LIMIT = 16_384;

interface Chunk {
  text: string;
  lines: number;
}

function newlineCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1)
    if (value.charCodeAt(index) === 10) count += 1;
  return count;
}

type AnsiState =
  "ground" | "escape" | "csi" | "osc" | "oscEscape" | "string" | "stringEscape";

function nextAnsiState(state: AnsiState, character: string): AnsiState {
  const code = character.charCodeAt(0);
  if (state === "ground") return code === 0x1b ? "escape" : "ground";
  if (state === "escape") {
    if (character === "[") return "csi";
    if (character === "]") return "osc";
    if ("PX^_".includes(character)) return "string";
    return code === 0x1b ? "escape" : "ground";
  }
  if (state === "csi") return code >= 0x40 && code <= 0x7e ? "ground" : "csi";
  if (state === "osc")
    return code === 0x07 ? "ground" : code === 0x1b ? "oscEscape" : "osc";
  if (state === "oscEscape")
    return character === "\\" ? "ground" : code === 0x1b ? "oscEscape" : "osc";
  if (state === "string") return code === 0x1b ? "stringEscape" : "string";
  return character === "\\"
    ? "ground"
    : code === 0x1b
      ? "stringEscape"
      : "string";
}

function scanAnsiState(
  value: string,
  state: AnsiState = "ground",
  end = value.length,
): AnsiState {
  for (let index = 0; index < end; index += 1)
    state = nextAnsiState(state, value[index]);
  return state;
}

function safeTruncationStart(value: string, start: number): number {
  if (start <= 0) return start;
  let state = scanAnsiState(value, "ground", start);
  if (state === "ground") return start;
  let index = start;
  while (index < value.length && state !== "ground")
    state = nextAnsiState(state, value[index++]);
  return index;
}

/** Maintain a bounded O(new characters) transcript under high-frequency output, merging only during renderer recovery. */
export class TerminalTranscriptBuffer {
  private chunks: Chunk[] = [];
  private characters = 0;
  private lines = 0;

  constructor(
    private maxCharacters = DEFAULT_MAX_CHARACTERS,
    private maxLines = DEFAULT_MAX_LINES,
  ) {}

  setLimits(maxCharacters: number, maxLines: number): void {
    this.maxCharacters = Math.max(1, Math.floor(maxCharacters));
    this.maxLines = Math.max(1, Math.floor(maxLines));
    this.trim();
  }

  append(data: string): void {
    if (!data) return;
    const lines = newlineCount(data);
    const last = this.chunks.at(-1);
    if (last && last.text.length + data.length <= COALESCE_LIMIT) {
      last.text += data;
      last.lines += lines;
    } else {
      this.chunks.push({ text: data, lines });
    }
    this.characters += data.length;
    this.lines += lines;
    this.trim();
  }

  replace(data: string): void {
    this.chunks = [];
    this.characters = 0;
    this.lines = 0;
    this.append(data);
  }

  toString(): string {
    return this.chunks.map((chunk) => chunk.text).join("");
  }

  chunkCountForTest(): number {
    return this.chunks.length;
  }

  private trim(): void {
    let truncated = false;
    let removedAnsiState: AnsiState = "ground";
    while (
      this.chunks.length > 1 &&
      (this.characters > this.maxCharacters || this.lines > this.maxLines)
    ) {
      const removed = this.chunks.shift()!;
      removedAnsiState = scanAnsiState(removed.text, removedAnsiState);
      this.characters -= removed.text.length;
      this.lines -= removed.lines;
      truncated = true;
    }
    if (this.characters <= this.maxCharacters && this.lines <= this.maxLines) {
      if (truncated) {
        this.discardPartialAnsiPrefix(removedAnsiState);
        this.prependReset();
      }
      return;
    }
    const only = this.chunks[0];
    if (!only) return;
    let start = Math.max(0, only.text.length - this.maxCharacters);
    if (this.lines > this.maxLines) {
      let remaining = this.maxLines;
      for (let index = only.text.length - 1; index >= 0; index -= 1) {
        if (only.text.charCodeAt(index) !== 10) continue;
        remaining -= 1;
        if (remaining === 0) {
          start = Math.max(start, index + 1);
          break;
        }
      }
    }
    start = safeTruncationStart(only.text, start);
    if (
      start > 0 &&
      /[\uD800-\uDBFF]/.test(only.text[start - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(only.text[start] ?? "")
    )
      start += 1;
    only.text = `\u001b[0m${only.text.slice(start)}`;
    only.lines = newlineCount(only.text);
    this.characters = only.text.length;
    this.lines = only.lines;
  }

  private discardPartialAnsiPrefix(state: AnsiState): void {
    while (state !== "ground" && this.chunks.length > 0) {
      const first = this.chunks[0];
      let end = 0;
      while (end < first.text.length && state !== "ground")
        state = nextAnsiState(state, first.text[end++]);
      if (end === 0) return;
      this.characters -= end;
      first.text = first.text.slice(end);
      first.lines = newlineCount(first.text);
      this.lines = this.chunks.reduce((total, chunk) => total + chunk.lines, 0);
      if (!first.text) this.chunks.shift();
    }
  }

  private prependReset(): void {
    const first = this.chunks[0];
    if (!first || first.text.startsWith("\u001b[0m")) return;
    first.text = `\u001b[0m${first.text}`;
    this.characters += 4;
  }
}

export function terminalTranscriptCharacterLimit(
  scrollbackLines: number,
): number {
  return Math.max(
    DEFAULT_MAX_CHARACTERS,
    Math.min(20_000_000, Math.round(scrollbackLines) * 200),
  );
}
