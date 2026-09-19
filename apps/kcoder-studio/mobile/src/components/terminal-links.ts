export interface TerminalFileLink {
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface TerminalLinkRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TerminalBufferCellLike {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalBufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean): string;
  getCell(
    column: number,
    cell?: TerminalBufferCellLike,
  ): TerminalBufferCellLike | undefined;
}

export interface TerminalBufferLike {
  readonly length: number;
  getLine(index: number): TerminalBufferLineLike | undefined;
  getNullCell(): TerminalBufferCellLike;
}

export interface TerminalBufferFileLink extends TerminalFileLink {
  range: TerminalLinkRange;
}

const MAX_WINDOW_LENGTH = 2_000;

const TERMINAL_FILE_PATTERN =
  /(?:^|[\s("'`])((?:(?:\.{1,2}\/|\/)[^\s"'`<>]+|[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+|[A-Za-z0-9_.@-]+\.[A-Za-z0-9_-]{1,16})(?::\d+(?::\d+)?)?)(?=$|[\s)"'`,;])/g;

export function terminalFileLinksInLine(line: string): TerminalFileLink[] {
  const links: TerminalFileLink[] = [];
  for (const match of line.matchAll(TERMINAL_FILE_PATTERN)) {
    const text = match[1];
    if (!text) continue;
    const matchStart = match.index ?? 0;
    const offsetInMatch = match[0].lastIndexOf(text);
    const startIndex = matchStart + Math.max(0, offsetInMatch);
    links.push({ text, startIndex, endIndex: startIndex + text.length });
  }
  return links;
}

export function terminalFileLinksForBufferLine(
  buffer: TerminalBufferLike,
  bufferLineNumber: number,
): TerminalBufferFileLink[] {
  const windowed = wrappedLineWindow(buffer, bufferLineNumber - 1);
  if (!windowed || !windowed.text || windowed.text.length > MAX_WINDOW_LENGTH)
    return [];
  return terminalFileLinksInLine(windowed.text).flatMap((link) => {
    const range = terminalBufferRange(
      buffer,
      windowed.startLine,
      link.startIndex,
      link.endIndex,
    );
    return range ? [{ ...link, range }] : [];
  });
}

function wrappedLineWindow(
  buffer: TerminalBufferLike,
  requestedLine: number,
): { text: string; startLine: number } | null {
  if (!buffer.getLine(requestedLine)) return null;
  let startLine = requestedLine;
  let endLine = requestedLine;
  while (startLine > 0 && buffer.getLine(startLine)?.isWrapped) startLine -= 1;
  while (endLine + 1 < buffer.length && buffer.getLine(endLine + 1)?.isWrapped)
    endLine += 1;
  const text = Array.from(
    { length: endLine - startLine + 1 },
    (_, offset) =>
      buffer.getLine(startLine + offset)?.translateToString(true) ?? "",
  ).join("");
  return { text, startLine };
}

function terminalBufferRange(
  buffer: TerminalBufferLike,
  startLine: number,
  startIndex: number,
  endIndex: number,
): TerminalLinkRange | null {
  const start = bufferPositionForStringOffset(buffer, startLine, startIndex);
  const end = bufferPositionForStringOffset(buffer, startLine, endIndex);
  if (!start || !end) return null;
  return {
    start: { x: start.x + 1, y: start.y + 1 },
    // xterm end is a one-based cell including the final character, while string endIndex is exclusive.
    end: { x: end.x, y: end.y + 1 },
  };
}

function bufferPositionForStringOffset(
  buffer: TerminalBufferLike,
  startLine: number,
  offset: number,
): { x: number; y: number } | null {
  const reusableCell = buffer.getNullCell();
  let y = startLine;
  let remaining = offset;
  while (y < buffer.length) {
    const line = buffer.getLine(y);
    if (!line) return null;
    for (let column = 0; column < line.length; column += 1) {
      if (remaining <= 0) return { x: column, y };
      const cell = line.getCell(column, reusableCell);
      const width = cell?.getWidth() ?? 0;
      if (width > 0) remaining -= cell?.getChars().length || 1;
      if (remaining <= 0) return { x: column + width, y };
    }
    if (remaining <= 0) return { x: line.length, y };
    y += 1;
  }
  return null;
}
