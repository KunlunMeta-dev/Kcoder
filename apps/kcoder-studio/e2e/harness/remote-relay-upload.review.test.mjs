import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { uploadPinnedRelayRuntimeArchive } from "./remote-relay-lifecycle.mjs";

async function archiveFile(t, bytes) {
  const directory = await mkdtemp(join(tmpdir(), "kc-relay-upload-review-"));
  const path = join(directory, "runtime.tar.gz");
  await writeFile(path, bytes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path;
}

function contextFor(child, abortSignal = null) {
  const stopped = [];
  return {
    abortSignal,
    stopped,
    isolatedEnvironment: () => ({ PATH: process.env.PATH }),
    async stopOwned(label) {
      stopped.push(label);
      child.stdin.destroy();
      child.signalCode = "SIGTERM";
    },
  };
}

function transportFor(child) {
  const calls = [];
  return {
    calls,
    async spawnManaged(label, command, options) {
      calls.push({ label, command, options });
      return child;
    },
  };
}

test("archive upload observes backpressure deadline and stops its owned SSH child", async t => {
  const archivePath = await archiveFile(t, Buffer.alloc(64 * 1024, 0x5a));
  let writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  let sinkDestroyed = false;
  const child = { exitCode: null, signalCode: null };
  child.stdin = new Writable({
    highWaterMark: 1,
    write() { writeStarted(); },
    destroy(error, callback) { sinkDestroyed = true; callback(error); },
  });
  const context = contextFor(child);
  const transport = transportFor(child);

  const upload = uploadPinnedRelayRuntimeArchive(context, {
    archivePath, runRoot: "/tmp/owned-run", sshTransport: transport, timeoutMs: 300,
  });
  await started;
  await assert.rejects(upload, /deadline/);

  assert.equal(sinkDestroyed, true);
  assert.deepEqual(context.stopped, ["remote-relay-runtime-upload"]);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].options.stdin, "pipe");
  assert.match(transport.calls[0].command, /^\/usr\/bin\/tar -xzf - -C '\/tmp\/owned-run' /);
});

test("archive upload observes parent abort during backpressure and stops its owned SSH child", async t => {
  const archivePath = await archiveFile(t, Buffer.alloc(64 * 1024, 0x2a));
  const abortController = new AbortController();
  let writeStarted;
  const started = new Promise(resolve => { writeStarted = resolve; });
  let sinkDestroyed = false;
  const child = { exitCode: null, signalCode: null };
  child.stdin = new Writable({
    highWaterMark: 1,
    write() { writeStarted(); },
    destroy(error, callback) { sinkDestroyed = true; callback(error); },
  });
  const context = contextFor(child, abortController.signal);
  const transport = transportFor(child);

  const upload = uploadPinnedRelayRuntimeArchive(context, {
    archivePath, runRoot: "/tmp/owned-run", sshTransport: transport, timeoutMs: 5_000,
  });
  await started;
  abortController.abort(new Error("test run aborted"));
  await assert.rejects(upload);

  assert.equal(sinkDestroyed, true);
  assert.deepEqual(context.stopped, ["remote-relay-runtime-upload"]);
  assert.equal(transport.calls.length, 1);
});

test("archive upload deadline also bounds waiting for the managed SSH child to exit", async t => {
  const archivePath = await archiveFile(t, Buffer.from("complete archive"));
  let finalized = false;
  let sinkDestroyed = false;
  const child = { exitCode: null, signalCode: null };
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) { finalized = true; callback(); },
    destroy(error, callback) { sinkDestroyed = true; callback(error); },
  });
  const context = contextFor(child);
  const transport = transportFor(child);

  await assert.rejects(uploadPinnedRelayRuntimeArchive(context, {
    archivePath, runRoot: "/tmp/owned-run", sshTransport: transport, timeoutMs: 300,
  }), /deadline/);

  assert.equal(finalized, true, "the input pipe completed before the child-close wait stalled");
  assert.equal(sinkDestroyed, true);
  assert.deepEqual(context.stopped, ["remote-relay-runtime-upload"]);
  assert.equal(transport.calls.length, 1);
});

test("archive upload rejects a completed remote extraction with a nonzero exit", async t => {
  const archivePath = await archiveFile(t, Buffer.from("complete archive"));
  const child = { exitCode: null, signalCode: null };
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) { child.exitCode = 2; callback(); },
  });
  const context = contextFor(child);
  const transport = transportFor(child);

  await assert.rejects(uploadPinnedRelayRuntimeArchive(context, {
    archivePath, runRoot: "/tmp/owned-run", sshTransport: transport, timeoutMs: 5_000,
  }), /remote extraction of pinned Relay runtime must succeed/);

  assert.deepEqual(context.stopped, ["remote-relay-runtime-upload"]);
  assert.equal(child.exitCode, 2);
  assert.equal(transport.calls.length, 1);
});

test("archive upload preserves bytes and the existing managed SSH command on success", async t => {
  const bytes = Buffer.from("pinned runtime archive bytes\0with-tail");
  const archivePath = await archiveFile(t, bytes);
  const received = [];
  const child = { exitCode: null, signalCode: null };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) { received.push(Buffer.from(chunk)); callback(); },
    final(callback) { child.exitCode = 0; callback(); },
  });
  const context = contextFor(child);
  const transport = transportFor(child);

  await uploadPinnedRelayRuntimeArchive(context, {
    archivePath, runRoot: "/tmp/owned run", sshTransport: transport, timeoutMs: 5_000,
  });

  assert.deepEqual(Buffer.concat(received), await readFile(archivePath));
  assert.deepEqual(context.stopped, []);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].command,
    "/usr/bin/tar -xzf - -C '/tmp/owned run' --no-same-owner --no-same-permissions");
  assert.equal(transport.calls[0].options.stdin, "pipe");
});
