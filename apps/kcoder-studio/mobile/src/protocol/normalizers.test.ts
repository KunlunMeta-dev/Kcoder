import { describe, expect, it } from "vitest";
import { stripTerminalControls, timestampMs, visibleUserContent } from "./normalizers";

describe("协议内容规范化", () => {
  it("隐藏服务端注入的记忆和附件标记", () => {
    expect(
      visibleUserContent(
        '<relevant-memories>secret</relevant-memories>\n你好\n<kcoder_attachments version="1">{"path":"/tmp/a"}</kcoder_attachments>',
      ),
    ).toBe("你好");
  });

  it("同时接受 ISO、epoch number 和 epoch string", () => {
    expect(timestampMs(1_785_314_635_973)).toBe(1_785_314_635_973);
    expect(timestampMs("1785314635973")).toBe(1_785_314_635_973);
    expect(timestampMs("2026-07-29T10:00:00.000Z")).toBe(Date.parse("2026-07-29T10:00:00.000Z"));
    expect(timestampMs("invalid")).toBe(0);
  });

  it("移除 PTY ANSI、OSC title 和 bracketed paste 控制序列", () => {
    const raw = "\u001b]0;devuser@vm\u0007\u001b[?2004h\u001b[32m$ pwd\u001b[0m\r\n/workspace\r\n";
    expect(stripTerminalControls(raw)).toBe("$ pwd\r\n/workspace\r\n");
  });
});
