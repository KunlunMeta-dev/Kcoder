import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_CHUNK_BYTES, DIRECT_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES, uploadStagedAttachment } from "./attachment-upload";

describe("uploadStagedAttachment", () => {
  it("keeps the compatible direct request for small files", async () => {
    const request = vi.fn(async () => ({ path: "/tmp/small.txt" }));
    const read = vi.fn(async () => "aGk=");
    await expect(uploadStagedAttachment(request, "small.txt", DIRECT_ATTACHMENT_BYTES, read)).resolves.toBe("/tmp/small.txt");
    expect(request).toHaveBeenCalledWith("attachment/save", { filename: "small.txt", content_base64: "aGk=" }, 30_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("splits large base64 payloads into bounded sequential chunks", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method.endsWith("start")) return { upload_id: "upload-1" };
      if (method.endsWith("finish")) return { path: "/tmp/large.bin" };
      return { accepted: true };
    });
    const read = vi.fn(async (_offset: number, length: number) => "A".repeat(Math.ceil(length / 3) * 4));
    await expect(uploadStagedAttachment(request, "large.bin", ATTACHMENT_CHUNK_BYTES + 8, read)).resolves.toBe("/tmp/large.bin");
    const chunks = calls.filter(([method]) => method.endsWith("chunk"));
    expect(chunks).toHaveLength(2);
    expect(chunks.map(([, params]) => params.index)).toEqual([0, 1]);
    expect(read.mock.calls).toEqual([[0, ATTACHMENT_CHUNK_BYTES], [ATTACHMENT_CHUNK_BYTES, 8]]);
  });

  it("cancels server state when a chunk fails", async () => {
    const methods: string[] = [];
    const request = vi.fn(async (method: string) => {
      methods.push(method);
      if (method.endsWith("start")) return { upload_id: "upload-2" };
      if (method.endsWith("chunk")) throw new Error("network lost");
      return { cancelled: true };
    });
    await expect(uploadStagedAttachment(request, "large.bin", DIRECT_ATTACHMENT_BYTES + 1, async () => "AAAA")).rejects.toThrow("network lost");
    expect(methods.at(-1)).toBe("attachment/upload/cancel");
  });

  it("rejects files larger than 50 MiB before opening a request", async () => {
    const request = vi.fn();
    await expect(uploadStagedAttachment(request, "huge.bin", MAX_ATTACHMENT_BYTES + 1, async () => "")).rejects.toThrow("50 MiB");
    expect(request).not.toHaveBeenCalled();
  });
});
