import { describe, expect, it } from "vitest";
import { terminalFileLinksForBufferLine, terminalFileLinksInLine, type TerminalBufferCellLike, type TerminalBufferLineLike } from "./terminal-links";

describe("terminalFileLinksInLine", () => {
  it("识别终端输出中的相对、绝对和带行号文件路径", () => {
    expect(terminalFileLinksInLine("error src/app.tsx:12:4 and /repo/README.md").map((link) => link.text)).toEqual([
      "src/app.tsx:12:4",
      "/repo/README.md",
    ]);
    expect(terminalFileLinksInLine("README.md  package.json").map((link) => link.text)).toEqual(["README.md", "package.json"]);
  });

  it("不把普通命令和 URL 当作工作区文件", () => {
    expect(terminalFileLinksInLine("npm test --help https://example.com")).toEqual([]);
  });
});

describe("terminalFileLinksForBufferLine", () => {
  it("uses xterm inclusive end coordinates without consuming the next cell", () => {
    const [link] = terminalFileLinksForBufferLine(fakeBuffer([asciiLine("echo README.md:5")]), 1);
    expect(link?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 16, y: 1 } });
  });

  it("maps links after wide characters using terminal cell widths", () => {
    const [link] = terminalFileLinksForBufferLine(fakeBuffer([widePrefixLine("错误 ", "README.md:2")]), 1);
    expect(link?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 16, y: 1 } });
  });

  it("returns a range spanning wrapped buffer rows", () => {
    const buffer = fakeBuffer([
      asciiLine("error src/very/", false),
      asciiLine("long/file.ts:9", true),
    ]);
    const [link] = terminalFileLinksForBufferLine(buffer, 2);
    expect(link?.text).toBe("src/very/long/file.ts:9");
    expect(link?.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 14, y: 2 } });
  });
});

function fakeBuffer(lines: TerminalBufferLineLike[]) {
  return {
    length: lines.length,
    getLine: (index: number) => lines[index],
    getNullCell: () => cell("", 1),
  };
}

function asciiLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return line(Array.from(text, (character) => cell(character, 1)), isWrapped);
}

function widePrefixLine(prefix: string, suffix: string): TerminalBufferLineLike {
  const cells: TerminalBufferCellLike[] = [];
  for (const character of prefix) {
    const wide = /[^\x00-\xff]/.test(character);
    cells.push(cell(character, wide ? 2 : 1));
    if (wide) cells.push(cell("", 0));
  }
  cells.push(...Array.from(suffix, (character) => cell(character, 1)));
  return line(cells, false);
}

function line(cells: TerminalBufferCellLike[], isWrapped: boolean): TerminalBufferLineLike {
  return {
    isWrapped,
    length: cells.length,
    translateToString: () => cells.map((item) => item.getChars()).join(""),
    getCell: (index: number) => cells[index],
  };
}

function cell(chars: string, width: number): TerminalBufferCellLike {
  return { getChars: () => chars, getWidth: () => width };
}
