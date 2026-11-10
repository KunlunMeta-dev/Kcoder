import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRuntime, StagedAttachment } from "@/runtime/task-runtime";

const hookHost = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  states: [] as unknown[],
  effects: [] as Array<() => void | (() => void)>,
  refIndex: 0,
  stateIndex: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => {
    hookHost.effects.push(effect);
  },
  useRef: (value: unknown) => {
    const index = hookHost.refIndex++;
    return (hookHost.refs[index] ??= { current: value });
  },
  useState: (initial: unknown) => {
    const index = hookHost.stateIndex++;
    if (!(index in hookHost.states)) hookHost.states[index] = initial;
    return [
      hookHost.states[index],
      (update: unknown) => {
        hookHost.states[index] =
          typeof update === "function"
            ? (update as (previous: unknown) => unknown)(hookHost.states[index])
            : update;
      },
    ];
  },
}));

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("expo-file-system", () => ({ File: class File {} }));
vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "/fixture",
  deleteAsync: vi.fn(),
  EncodingType: { Base64: "base64" },
  writeAsStringAsync: vi.fn(),
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(),
}));
vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  Platform: { OS: "web" },
}));

import { DIRECT_ATTACHMENT_BYTES } from "@/protocol/attachment-limits";
import { useAttachmentAccess } from "./useAttachmentAccess";

type TaskFixture = {
  threadId: string;
  isDisposed(): boolean;
  getSnapshot(): { threadId: string };
  request: ReturnType<typeof vi.fn>;
};

function taskFixture(
  threadId: string,
  request: TaskFixture["request"],
): TaskRuntime {
  const task: TaskFixture = {
    threadId,
    isDisposed: () => false,
    getSnapshot: () => ({ threadId }),
    request,
  };
  return task as unknown as TaskRuntime;
}

const image: StagedAttachment = {
  filename: "photo.png",
  mimeType: "image/png",
  fileSize: 8,
  path: "/workspace/photo.png",
};

function renderAccess(
  task: TaskRuntime,
  attachment = image,
  localPreviewUri?: string,
) {
  hookHost.refIndex = 0;
  hookHost.stateIndex = 0;
  hookHost.effects = [];
  const access = useAttachmentAccess(attachment, task, localPreviewUri);
  for (const effect of hookHost.effects) effect();
  return access;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

beforeEach(() => {
  hookHost.refs = [];
  hookHost.states = [];
  hookHost.effects = [];
  hookHost.refIndex = 0;
  hookHost.stateIndex = 0;
});

describe("useAttachmentAccess inline previews", () => {
  it("uses a local large raster preview without requesting remote bytes", async () => {
    const request = vi.fn(async () => ({ contentBase64: "unused" }));
    const access = renderAccess(
      taskFixture("thread-a", request),
      { ...image, fileSize: DIRECT_ATTACHMENT_BYTES + 1 },
      "file:///owned/photo.png",
    );

    expect(access.previewMime).toBe("image/png");
    expect(access.inlinePreviewUri).toBe("file:///owned/photo.png");
    await expect(access.loadInlinePreview()).resolves.toBe(
      "file:///owned/photo.png",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an oversized remote image using decoded bytes when size is omitted", async () => {
    const oversizedBase64 = "A".repeat(
      Math.ceil((DIRECT_ATTACHMENT_BYTES + 1) / 3) * 4,
    );
    const request = vi.fn(async () => ({ contentBase64: oversizedBase64 }));
    const task = taskFixture("thread-a", request);
    let access = renderAccess(task);

    await expect(access.loadInlinePreview()).resolves.toBeNull();
    access = renderAccess(task);

    expect(request).toHaveBeenCalledOnce();
    expect(access.inlinePreviewUri).toBeNull();
    expect(access.error).toBe(
      "task.the_attachment_exceeds_the_256_kib_preview_limit",
    );
  });

  it("does not let an old read populate the replacement owner's cache or preview", async () => {
    const oldRead = deferred<{ contentBase64: string }>();
    const oldRequest = vi.fn(() => oldRead.promise);
    const newRequest = vi.fn(async () => ({ contentBase64: "bmV3" }));
    const oldTask = taskFixture("thread-a", oldRequest);
    const newTask = taskFixture("thread-a", newRequest);

    const oldAccess = renderAccess(oldTask);
    const oldOpen = oldAccess.open();
    expect(oldRequest).toHaveBeenCalledOnce();

    let currentAccess = renderAccess(newTask);
    await currentAccess.open();
    oldRead.resolve({ contentBase64: "b2xk" });
    await oldOpen;
    currentAccess = renderAccess(newTask);

    expect(newRequest).toHaveBeenCalledOnce();
    expect(currentAccess.previewUri).toBe("data:image/png;base64,bmV3");
    expect(currentAccess.error).toBeNull();
  });
});
