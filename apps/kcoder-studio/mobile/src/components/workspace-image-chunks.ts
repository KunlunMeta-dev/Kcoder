import { toByteArray } from "base64-js";
import type { TaskRuntime } from "@/runtime/task-runtime";

type Chunk = Record<string, unknown>;
function record(value: unknown): Chunk {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Chunk)
    : {};
}
const changed = () => new Error("文件在读取中已变化，请重新加载。");

export async function readWorkspaceImageChunks(
  read: (offset: number, expectedRevision?: string) => Promise<Chunk>,
  options: {
    revisionSupported: boolean;
    maxBytes: number;
    isCurrent: () => boolean;
  },
): Promise<{ bytes: Uint8Array; tooLarge: boolean } | null> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let snapshot: Chunk | undefined;
  let revision: string | undefined;
  for (;;) {
    if (!options.isCurrent()) return null;
    const chunk = await read(offset, revision);
    if (!options.isCurrent()) return null;
    if (
      !Number.isSafeInteger(chunk.size) ||
      (chunk.size as number) < 0 ||
      chunk.offset !== offset ||
      typeof chunk.eof !== "boolean"
    )
      throw changed();
    if (!snapshot) {
      snapshot = {
        path: chunk.path,
        name: chunk.name,
        size: chunk.size,
        modified_at: chunk.modified_at ?? null,
      };
      if (options.revisionSupported) {
        if (typeof chunk.revision !== "string" || !chunk.revision.trim())
          throw changed();
        revision = chunk.revision;
      }
    }
    if (
      chunk.path !== snapshot.path ||
      chunk.name !== snapshot.name ||
      chunk.size !== snapshot.size ||
      (chunk.modified_at ?? null) !== snapshot.modified_at ||
      (revision !== undefined && chunk.revision !== revision)
    )
      throw changed();
    if ((chunk.size as number) > options.maxBytes)
      return { bytes: new Uint8Array(), tooLarge: true };
    if (typeof chunk.content_base64 !== "string")
      throw new Error("无效的图片分块内容");
    const bytes = toByteArray(chunk.content_base64);
    const nextOffset = offset + bytes.byteLength;
    if (
      !Number.isSafeInteger(nextOffset) ||
      nextOffset > (chunk.size as number) ||
      (bytes.byteLength === 0 && !chunk.eof) ||
      chunk.eof !== (nextOffset === chunk.size)
    )
      throw changed();
    chunks.push(bytes);
    offset = nextOffset;
    if (chunk.eof) break;
  }
  const merged = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return { bytes: merged, tooLarge: false };
}

export function loadWorkspaceImageChunks(
  task: TaskRuntime,
  parent: string,
  name: string,
  maxBytes: number,
  isCurrent: () => boolean,
) {
  const client = task.client;
  const generation = task.clientGeneration;
  const assertConnection = () => {
    if (task.client !== client || task.clientGeneration !== generation)
      throw new Error("文件预览连接已变化，请重新加载。");
  };
  return readWorkspaceImageChunks(
    async (offset, expectedRevision) => {
      assertConnection();
      const result = await task
        .request<{
          success?: boolean;
          stdout?: unknown;
          error?: string;
          stderr?: string;
        }>("device/execute", {
          command_key: "workspace_read_file_chunk",
          path: parent,
          args: [name, String(offset)],
          max_output_bytes: 2 * 1024 * 1024,
          ...(expectedRevision === undefined
            ? {}
            : { expected_revision: expectedRevision }),
        })
        .catch((error) => {
          if (
            error instanceof Error &&
            error.message.startsWith("workspace_file_changed:")
          )
            throw changed();
          throw error;
        });
      assertConnection();
      if (result.success === false) {
        const message = result.error || result.stderr || "读取图片失败";
        if (message.startsWith("workspace_file_changed:")) throw changed();
        throw new Error(message);
      }
      return record(result.stdout);
    },
    {
      revisionSupported:
        client?.supportsExperimental("workspaceBinaryRevisionV1") === true,
      maxBytes,
      isCurrent,
    },
  );
}
