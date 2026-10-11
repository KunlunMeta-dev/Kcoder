import { expect, test, vi } from "vitest";
import type { TaskRuntime } from "@/runtime/task-runtime";
import {
  loadWorkspaceImageChunks,
  readWorkspaceImageChunks,
} from "./workspace-image-chunks";

const first = {
  path: "/workspace/image.png",
  name: "image.png",
  size: 4,
  modified_at: 1000,
  offset: 0,
  eof: false,
  content_base64: "AQI=",
  revision: "opaque-first",
};
const last = { ...first, offset: 2, eof: true, content_base64: "AwQ=" };
const options = {
  revisionSupported: true,
  maxBytes: 8 * 1024 * 1024,
  isCurrent: () => true,
};

test("the mobile consumer pins negotiated revisions and assembles the same wire payload", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ success: true, stdout: first })
    .mockResolvedValueOnce({ success: true, stdout: last });
  const task = {
    client: { supportsExperimental: () => true },
    clientGeneration: 1,
    request,
  } as unknown as TaskRuntime;
  expect(
    (
      await loadWorkspaceImageChunks(
        task,
        "/workspace",
        "image.png",
        options.maxBytes,
        options.isCurrent,
      )
    )?.bytes,
  ).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(request).toHaveBeenNthCalledWith(
    2,
    "device/execute",
    expect.objectContaining({
      args: ["image.png", "2"],
      expected_revision: "opaque-first",
    }),
  );
});

test.each([
  { revision: "opaque-replaced" },
  { revision: undefined },
  { size: 5 },
  { modified_at: 1001 },
  { path: "/workspace/replaced.png" },
  { name: "replaced.png" },
  { offset: 1 },
  { content_base64: "" },
  { eof: false },
])("rejects mixed or incomplete image chunks: %j", async (changed) => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ ...last, ...changed });
  await expect(readWorkspaceImageChunks(read, options)).rejects.toThrow(
    "文件在读取中已变化",
  );
  expect(read).toHaveBeenCalledTimes(2);
});

test("old targets ignore incidental tokens and retain observable metadata checks", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ ...last, revision: "unnegotiated-other" });
  const result = await readWorkspaceImageChunks(read, {
    ...options,
    revisionSupported: false,
  });
  expect(result?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(read).toHaveBeenNthCalledWith(2, 2, undefined);
  read
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({ ...last, modified_at: 1001 });
  await expect(
    readWorkspaceImageChunks(read, { ...options, revisionSupported: false }),
  ).rejects.toThrow("文件在读取中已变化");
});

test("an expired view does not publish a pending chunk or continue downloading", async () => {
  let current = true;
  let finish!: (value: typeof first) => void;
  const read = vi.fn(
    () =>
      new Promise<typeof first>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = readWorkspaceImageChunks(read, {
    ...options,
    isCurrent: () => current,
  });
  current = false;
  finish(first);
  await expect(pending).resolves.toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});

test.each(["connection", "generation"])(
  "a replacement mobile %s cannot supply the old preview",
  async (change) => {
    const task = {
      client: { supportsExperimental: () => true },
      clientGeneration: 1,
    } as unknown as TaskRuntime;
    task.request = vi.fn(async () => {
      if (change === "generation") task.clientGeneration += 1;
      else task.client = { supportsExperimental: () => true } as never;
      return { success: true, stdout: first };
    }) as TaskRuntime["request"];
    await expect(
      loadWorkspaceImageChunks(
        task,
        "/workspace",
        "image.png",
        options.maxBytes,
        options.isCurrent,
      ),
    ).rejects.toThrow("连接已变化");
  },
);

test.each([
  "workspace_file_changed: backend revision mismatch",
  "Gateway connection closed",
])("file-change and transport failures stay distinct: %s", async (message) => {
  const task = {
    client: { supportsExperimental: () => true },
    clientGeneration: 1,
    request: vi.fn().mockRejectedValue(new Error(message)),
  } as unknown as TaskRuntime;
  await expect(
    loadWorkspaceImageChunks(
      task,
      "/workspace",
      "image.png",
      options.maxBytes,
      options.isCurrent,
    ),
  ).rejects.toThrow(
    message.startsWith("workspace_file_changed:")
      ? "文件在读取中已变化"
      : message,
  );
});

test("the existing image limit is checked before decoding and empty files are complete", async () => {
  const large = vi.fn(async () => ({
    ...first,
    size: options.maxBytes + 1,
    content_base64: "invalid",
  }));
  await expect(readWorkspaceImageChunks(large, options)).resolves.toMatchObject(
    { tooLarge: true },
  );
  const empty = vi.fn(async () => ({
    ...first,
    size: 0,
    eof: true,
    content_base64: "",
  }));
  await expect(readWorkspaceImageChunks(empty, options)).resolves.toMatchObject(
    { bytes: new Uint8Array(), tooLarge: false },
  );
});
