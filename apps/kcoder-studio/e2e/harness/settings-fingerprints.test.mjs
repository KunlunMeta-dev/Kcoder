import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { redact } from "./run-context.mjs";
import {
  fingerprintRegularFile,
  fingerprintRegularTree,
  fingerprintRendererSource,
  fingerprintSharedAssets,
} from "./settings-fingerprints.mjs";

const temporaryRoots = [];

after(async () => {
  await Promise.all(temporaryRoots.map(path => rm(path, { recursive: true, force: true })));
});

test("Renderer source fingerprint excludes nested dependency trees", async () => {
  const root = await createRendererTree();
  const dependencies = resolve(root, "dependency-tree");
  await mkdir(dependencies, { recursive: true });
  await mkdir(resolve(dependencies, "socket.io-client"), { recursive: true });
  await writeFile(resolve(dependencies, "socket.io-client/index.js"), "dependency bytes");
  await symlink(dependencies, resolve(root, "packages/chat-core/node_modules"), "dir");

  const fingerprint = await fingerprintRendererSource(root);

  assert.ok(fingerprint.entries.some(entry => entry.path === "packages/chat-core/src/index.ts"));
  assert.equal(fingerprint.entries.some(entry => entry.path.includes("/node_modules/")), false);
  assert.match(fingerprint.digest, /^[a-f0-9]{64}$/);
});

test("Renderer source fingerprint rejects symlinks inside included source", async () => {
  const root = await createRendererTree();
  const outside = resolve(root, "outside-source.ts");
  await writeFile(outside, "outside bytes");
  await symlink(outside, resolve(root, "src/escaped.ts"));

  await assert.rejects(fingerprintRendererSource(root), /cannot be a symlink/);
  await rm(outside, { force: true });
});

test("regular export fingerprint keeps every regular file and rejects symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-settings-fingerprint-export-"));
  temporaryRoots.push(root);
  await writeFile(resolve(root, "index.html"), "export");
  const fingerprint = await fingerprintRegularTree(root);
  assert.deepEqual(fingerprint.entries.map(entry => entry.path), ["index.html"]);

  const outside = resolve(root, "outside-export-file");
  await writeFile(outside, "outside");
  await symlink(outside, resolve(root, "outside-link"));
  await assert.rejects(fingerprintRegularTree(root), /cannot be a symlink/);
  await rm(outside, { force: true });
});

test("single-file fingerprint binds shared reading contract bytes and rejects symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-settings-fingerprint-reading-"));
  temporaryRoots.push(root);
  await writeFile(resolve(root, "conversationReading.ts"), "export const spacing = 1;\n");
  const before = await fingerprintRegularFile(root, "conversationReading.ts");
  assert.deepEqual(before.entries.map(entry => entry.path), ["conversationReading.ts"]);
  assert.match(before.digest, /^[a-f0-9]{64}$/);

  await writeFile(resolve(root, "conversationReading.ts"), "export const spacing = 2;\n");
  const after = await fingerprintRegularFile(root, "conversationReading.ts");
  assert.notEqual(after.digest, before.digest);

  await writeFile(resolve(root, "outside-contract.ts"), "external");
  await rm(resolve(root, "conversationReading.ts"), { force: true });
  await symlink(resolve(root, "outside-contract.ts"), resolve(root, "conversationReading.ts"));
  await assert.rejects(fingerprintRegularFile(root, "conversationReading.ts"), /cannot be a symlink/);
});

test("shared assets fingerprint exposes Noto Sans SC files and detects font changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-settings-fingerprint-assets-"));
  temporaryRoots.push(root);
  const fonts = resolve(root, "fonts/noto-sans-sc");
  await mkdir(fonts, { recursive: true });
  await writeFile(resolve(root, "gptDefaultInstructions.md"), "shared asset");
  for (const name of ["NotoSansSC-Regular.otf", "NotoSansSC-Bold.otf", "LICENSE", "SOURCES"]) {
    await writeFile(resolve(fonts, name), name);
  }

  const before = await fingerprintSharedAssets(root);
  assert.deepEqual(before.notoSansSc.entries.map(entry => entry.path), [
    "fonts/noto-sans-sc/LICENSE",
    "fonts/noto-sans-sc/NotoSansSC-Bold.otf",
    "fonts/noto-sans-sc/NotoSansSC-Regular.otf",
    "fonts/noto-sans-sc/SOURCES",
  ]);
  assert.equal(before.notoSansSc.digest,
    createHash("sha256").update(JSON.stringify(before.notoSansSc.entries)).digest("hex"));

  await writeFile(resolve(fonts, "NotoSansSC-Regular.otf"), "changed font bytes");
  const after = await fingerprintSharedAssets(root);
  assert.notEqual(after.digest, before.digest);
  assert.notEqual(after.notoSansSc.digest, before.notoSansSc.digest);
});

test("RunContext redaction preserves secret-looking fingerprint paths and still redacts token fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-settings-fingerprint-redaction-"));
  temporaryRoots.push(root);
  const sourceFile = resolve(root, "src/storage/device-secret-binding.test.ts");
  await mkdir(resolve(root, "src/storage"), { recursive: true });
  await writeFile(sourceFile, "ordinary source content");

  const fingerprint = await fingerprintRegularTree(root);
  assert.ok(fingerprint.entries.some(entry => entry.path === "src/storage/device-secret-binding.test.ts"));
  assert.deepEqual(redact(fingerprint), fingerprint);
  assert.deepEqual(redact({ token: "fixture-token-value" }), { token: "[REDACTED]" });
});

async function createRendererTree() {
  const root = await mkdtemp(join(tmpdir(), "kcoder-settings-fingerprint-renderer-"));
  temporaryRoots.push(root);
  for (const directory of ["src", "packages/chat-core/src", "branding", "third_party", "public"]) {
    await mkdir(resolve(root, directory), { recursive: true });
  }
  for (const file of [
    "index.html",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "postcss.config.js",
    "tailwind.config.js",
    "components.json",
    "src/main.tsx",
    "packages/chat-core/src/index.ts",
    "branding/demo.json",
    "third_party/vendor.js",
    "public/runtime-config.js",
  ]) await writeFile(resolve(root, file), file);
  return root;
}
