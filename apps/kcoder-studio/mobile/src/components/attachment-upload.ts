import {
  ATTACHMENT_CHUNK_BYTES,
  DIRECT_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES,
} from "@/protocol/attachment-limits";

export { ATTACHMENT_CHUNK_BYTES, DIRECT_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES };

type AttachmentRequest = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export async function uploadStagedAttachment(
  request: AttachmentRequest,
  filename: string,
  size: number,
  readBase64Chunk: (offset: number, length: number) => Promise<string>,
): Promise<string> {
  if (size > MAX_ATTACHMENT_BYTES) throw new Error("单个附件不能超过 50 MiB");
  if (size <= DIRECT_ATTACHMENT_BYTES) {
    const contentBase64 = await readBase64Chunk(0, size);
    const result = await request("attachment/save", { filename, content_base64: contentBase64 }, 30_000) as { path?: string };
    if (!result.path) throw new Error("app-server 未返回附件路径");
    return result.path;
  }

  const started = await request("attachment/upload/start", { filename, size }, 30_000) as { upload_id?: string };
  if (!started.upload_id) throw new Error("app-server 未返回附件上传 ID");
  const uploadId = started.upload_id;
  try {
    let index = 0;
    for (let offset = 0; offset < size; offset += ATTACHMENT_CHUNK_BYTES) {
      const length = Math.min(ATTACHMENT_CHUNK_BYTES, size - offset);
      await request("attachment/upload/chunk", {
        upload_id: uploadId,
        index,
        content_base64: await readBase64Chunk(offset, length),
      }, 30_000);
      index += 1;
    }
    const result = await request("attachment/upload/finish", { upload_id: uploadId }, 30_000) as { path?: string };
    if (!result.path) throw new Error("app-server 未返回附件路径");
    return result.path;
  } catch (error) {
    await request("attachment/upload/cancel", { upload_id: uploadId }, 10_000).catch(() => {});
    throw error;
  }
}
