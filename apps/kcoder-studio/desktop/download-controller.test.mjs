import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerDownloads } from "./download-controller.mjs";

function fixture() {
  const session = new EventEmitter(),
    ipcMain = {
      handlers: new Map(),
      handle(k, f) {
        this.handlers.set(k, f);
      },
      removeHandler(k) {
        this.handlers.delete(k);
      },
    };
  const contents = {
    session,
    mainFrame: { url: "http://127.0.0.1:12345/" },
    isDestroyed: () => false,
    downloadURL(url) {
      this.url = url;
    },
  };
  const window = { webContents: contents, isDestroyed: () => false };
  registerDownloads({
    session,
    ipcMain,
    getWindow: (c) => (c === contents ? window : null),
    getGatewayOrigin: () => "http://127.0.0.1:12345",
    downloadsDirectory: "/owned/downloads",
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const item = () => {
    const d = new EventEmitter();
    Object.assign(d, {
      getURL: () => contents.url,
      getURLChain: () => [contents.url],
      getFilename: () => "export.json",
      setSaveDialogOptions(o) {
        this.options = o;
      },
      cancel() {
        this.emit("done", {}, "cancelled");
      },
      getSavePath: () => "/owned/downloads/export.json",
    });
    return d;
  };
  return {
    ipcMain,
    contents,
    session,
    event,
    item,
    invoke: (params) => ipcMain.handlers.get("kcoder:download")(event, params),
  };
}

test("only explicitly approved trusted main frame exports reach DownloadItem", async () => {
  const f = fixture();
  const pending = f.invoke({
    url: "blob:http://127.0.0.1:12345/owned-id",
    filename: "export.json",
  });
  const item = f.item();
  let blocked = false;
  f.session.emit(
    "will-download",
    {
      preventDefault() {
        blocked = true;
      },
    },
    item,
    f.contents,
  );
  assert.equal(blocked, false);
  assert.equal(item.options.defaultPath, "/owned/downloads/export.json");
  item.emit("done", {}, "completed");
  assert.deepEqual(await pending, {
    status: "completed",
    filename: "export.json",
  });
  f.session.emit(
    "will-download",
    {
      preventDefault() {
        blocked = true;
      },
    },
    f.item(),
    f.contents,
  );
  assert.equal(
    blocked,
    true,
    "unapproved child/generic download cannot reuse a permit",
  );
});

test("save dialog cancellation is an explicit renderer result", async () => {
  const f = fixture();
  const pending = f.invoke({
    url: "blob:http://127.0.0.1:12345/id",
    filename: "export.json",
  });
  const item = f.item();
  f.session.emit("will-download", { preventDefault() {} }, item, f.contents);
  item.emit("done", {}, "cancelled");
  assert.deepEqual(await pending, {
    status: "cancelled",
    filename: "export.json",
  });
});

test("unknown frames, external URLs and path filenames are rejected before download", async () => {
  const f = fixture(),
    handler = f.ipcMain.handlers.get("kcoder:download");
  await assert.rejects(
    handler(
      { ...f.event, senderFrame: { url: f.contents.mainFrame.url } },
      { url: "blob:http://127.0.0.1:12345/id", filename: "file" },
    ),
    /main application frame/,
  );
  for (const params of [
    { url: "blob:https://example.test/id", filename: "file" },
    { url: "file:///etc/hosts", filename: "file" },
    { url: "blob:http://127.0.0.1:12345/id", filename: "../file" },
  ])
    await assert.rejects(f.invoke(params));
});

test("a rejected URL chain settles only its original pending request", async () => {
  const f = fixture();
  const rejected = assert.rejects(f.invoke({
    url: "blob:http://127.0.0.1:12345/rejected", filename: "export.json",
  }), /Application download was rejected/);
  const item = f.item();
  item.getURLChain = () => [f.contents.url, "https://example.test/redirect"];
  let blocked = false;
  f.session.emit("will-download", { preventDefault() { blocked = true; } }, item, f.contents);
  await rejected;
  assert.equal(blocked, true);
  assert.equal(item.options, undefined);
  const next = f.invoke({ url: "blob:http://127.0.0.1:12345/next", filename: "next.json" });
  const replacement = f.item();
  f.session.emit("will-download", { preventDefault() { assert.fail("valid replacement rejected"); } }, replacement, f.contents);
  item.emit("done", {}, "completed");
  replacement.emit("done", {}, "completed");
  assert.deepEqual(await next, { status: "completed", filename: "next.json" });
});

test("lost main-frame authority rejects its exact unclaimed download", async () => {
  const f = fixture();
  const rejected = assert.rejects(f.invoke({
    url: "blob:http://127.0.0.1:12345/owned", filename: "export.json",
  }), /Application download was rejected/);
  const item = f.item();
  f.contents.mainFrame = { url: "http://127.0.0.1:12345/replaced-frame" };
  f.event.senderFrame = f.contents.mainFrame;
  f.session.emit("will-download", { preventDefault() {} }, item, f.contents);
  await rejected;
  assert.equal(item.options, undefined);
});

test("a different native Session cannot mint this host's download ticket", async () => {
  const f = fixture();
  f.contents.session = new EventEmitter();
  await assert.rejects(f.invoke({
    url: "blob:http://127.0.0.1:12345/owned", filename: "export.json",
  }), /main application frame/);
  assert.equal(f.contents.url, undefined);
});

test("unrelated and duplicate items cannot settle the original active download", async () => {
  const f = fixture();
  const params = { url: "blob:http://127.0.0.1:12345/owned", filename: "export.json" };
  const pending = f.invoke(params);
  const unrelated = f.item();
  unrelated.getURL = () => "blob:http://127.0.0.1:12345/unrelated";
  f.session.emit("will-download", { preventDefault() {} }, unrelated, f.contents);
  await assert.rejects(f.invoke(params), /already pending/);
  const item = f.item();
  f.session.emit("will-download", { preventDefault() { assert.fail("original rejected"); } }, item, f.contents);
  f.session.emit("will-download", { preventDefault() {} }, f.item(), f.contents);
  item.emit("done", {}, "completed");
  assert.deepEqual(await pending, { status: "completed", filename: "export.json" });
});
