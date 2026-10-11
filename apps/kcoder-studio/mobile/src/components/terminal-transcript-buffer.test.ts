import { describe, expect, it } from "vitest";
import { TerminalTranscriptBuffer, terminalTranscriptCharacterLimit } from "./terminal-transcript-buffer";

describe("TerminalTranscriptBuffer", () => {
  it("合并数千个小 chunk，而不对完整 transcript 反复复制", () => {
    const buffer = new TerminalTranscriptBuffer(100_000, 10_000);
    for (let index = 0; index < 5_000; index += 1) buffer.append(`line-${index}\n`);
    expect(buffer.toString()).toContain("line-4999");
    expect(buffer.chunkCountForTest()).toBeLessThan(8);
  });

  it("截断时从完整字符开始并重置 ANSI 样式", () => {
    const buffer = new TerminalTranscriptBuffer(24, 3);
    buffer.append("\u001b[31mold\n一二三\n四五六\n七八九\n");
    const restored = buffer.toString();
    expect(restored.startsWith("\u001b[0m")).toBe(true);
    expect(restored).toContain("七八九");
    expect(restored).not.toContain("old");
  });

  it("截断点落入 ANSI CSI 或 OSC 序列时跳过剩余控制片段", () => {
    const csi = new TerminalTranscriptBuffer(7, 100);
    csi.append("AAAA\u001b[38;5;123mRED");
    expect(csi.toString()).toBe("\u001b[0mRED");

    const osc = new TerminalTranscriptBuffer(8, 100);
    osc.append("AAAA\u001b]0;private-title\u0007visible");
    expect(osc.toString()).toBe("\u001b[0mvisible");

    const oscWithStringTerminator = new TerminalTranscriptBuffer(8, 100);
    oscWithStringTerminator.append("AAAA\u001b]8;;https://secret.invalid\u001b\\visible");
    expect(oscWithStringTerminator.toString()).toBe("\u001b[0mvisible");

    const dcs = new TerminalTranscriptBuffer(8, 100);
    dcs.append("AAAA\u001bP1;2|private\u001b\\visible");
    expect(dcs.toString()).toBe("\u001b[0mvisible");

    const completeBeforeCut = new TerminalTranscriptBuffer(8, 100);
    completeBeforeCut.append("\u001b[31mABCDEFGH");
    expect(completeBeforeCut.toString()).toBe("\u001b[0mABCDEFGH");
  });

  it("控制序列跨 chunk 且起始 chunk 被丢弃时清理保留 chunk 的 payload", () => {
    const osc = new TerminalTranscriptBuffer(16_400, 100);
    osc.append(`${"A".repeat(16_380)}\u001b]0;`);
    osc.append("private-title\u0007visible");
    expect(osc.toString()).toBe("\u001b[0mvisible");

    const csi = new TerminalTranscriptBuffer(16_386, 100);
    csi.append(`${"A".repeat(16_382)}\u001b[`);
    csi.append("38;5;123mRED");
    expect(csi.toString()).toBe("\u001b[0mRED");
  });

  it("运行中修改回滚上限时立即裁剪权威 transcript", () => {
    const buffer = new TerminalTranscriptBuffer(100_000, 100);
    for (let index = 0; index < 20; index += 1) buffer.append(`line-${index}\n`);
    buffer.setLimits(100_000, 5);
    expect(buffer.toString()).toContain("line-19");
    expect(buffer.toString()).not.toContain("line-5\n");
    expect(terminalTranscriptCharacterLimit(100_000)).toBe(20_000_000);
  });
});
