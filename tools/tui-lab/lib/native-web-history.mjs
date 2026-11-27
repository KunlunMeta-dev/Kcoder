import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  readFile,
  readdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function snapshotNativeTree(root) {
  const files = [];
  let bytes = 0;
  async function visit(directory, relative = "") {
    const metadata = await lstat(directory);
    assert.ok(
      metadata.isDirectory() && !metadata.isSymbolicLink(),
      "Fixture directory must be real",
    );
    for (const name of (await readdir(directory)).sort()) {
      const absolute = path.join(directory, name),
        leaf = path.join(relative, name),
        info = await lstat(absolute);
      assert.ok(
        !info.isSymbolicLink(),
        "Native fixture links are not accepted",
      );
      if (info.isDirectory()) await visit(absolute, leaf);
      else {
        assert.ok(
          info.isFile(),
          "Native fixture must contain only regular files",
        );
        bytes += info.size;
        assert.ok(
          files.length < 256 && bytes <= 16 * 1024 * 1024,
          "Native fixture exceeds bounded replay size",
        );
        files.push({
          path: leaf.replaceAll(path.sep, "/"),
          bytes: info.size,
          sha256: createHash("sha256")
            .update(await readFile(absolute))
            .digest("hex"),
        });
      }
    }
  }
  await visit(root);
  return files;
}

export function nativeWebFacts(text) {
  const rows = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const receipts = rows.flatMap((row) =>
    (row.webSources || []).map((receipt) => {
      assert.equal(
        receipt.schemaVersion,
        1,
        "Only the native source schema is accepted",
      );
      assert.ok(
        row.content?.some(
          (block) =>
            block.type === "tool_result" &&
            block.tool_use_id === receipt.toolCallId,
        ),
        "Native receipt must bind the same row tool result",
      );
      return receipt;
    }),
  );
  const sources = receipts.flatMap((receipt) => receipt.sources || []);
  assert.ok(
    receipts.some((receipt) => receipt.operation === "search") &&
      receipts.some((receipt) => receipt.operation === "fetch"),
    "A real search/fetch receipt pair is required",
  );
  assert.ok(
    sources.some((source) => source.readStatus === "summary_only") &&
      sources.some((source) => source.readStatus === "read"),
    "Summary and read observations must both exist",
  );
  return {
    messages: rows.length,
    receipts: receipts.length,
    sourceIds: sources.map((source) => source.sourceId),
    urls: [...new Set(sources.map((source) => source.url))],
    sources,
  };
}

export function nativeReplaySettings(source) {
  const settings = structuredClone(source),
    fixtureBudgetFields = [];
  assert.ok(
    settings.providers && Object.keys(settings.providers).length > 0,
    "A public model-only snapshot is required",
  );
  for (const [name, provider] of Object.entries(settings.providers)) {
    const endpoint = new URL(provider.endpoint);
    assert.ok(
      endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
      "Replay cannot address an external provider",
    );
    assert.equal(
      provider.authentication?.mode,
      "none",
      "Replay must not load a credential",
    );
    for (const field of [
      "context_window_tokens",
      "output_headroom_tokens",
      "max_output_tokens",
    ]) {
      if (provider[field] === "[REDACTED]") {
        provider[field] = field === "context_window_tokens" ? 128000 : 8192;
        fixtureBudgetFields.push(`${name}.${field}`);
      }
    }
    provider.discover_models = false;
  }
  return { settings, fixtureBudgetFields };
}

export async function copyNativeWebBundle(historyPath, configHome) {
  const sourceHistory = path.resolve(historyPath),
    sourceRoot = path.dirname(sourceHistory),
    session = path.basename(sourceHistory, ".jsonl");
  assert.ok(
    sourceHistory.endsWith(".jsonl") && /^[a-zA-Z0-9_-]+$/.test(session),
    "Explicit fixture JSONL required",
  );
  for (const relative of [
    `${session}.hctl/source.json`,
    `${session}/state.json`,
    `${session}/imported-context.v1`,
    "model-connection.json",
    "workspace-source.json",
    "files.json",
  ])
    assert.ok(
      (await lstat(path.join(sourceRoot, relative))).isFile(),
      `Incomplete native replay bundle: ${relative}`,
    );
  const before = await snapshotNativeTree(sourceRoot);
  const manifest = JSON.parse(
    await readFile(path.join(sourceRoot, "files.json"), "utf8"),
  );
  assert.equal(
    manifest.threadId,
    session,
    "Manifest must identify the selected native session",
  );
  assert.ok(
    Array.isArray(manifest.files) && manifest.files.length === 4,
    "Four primary native files must be retained",
  );
  for (const item of manifest.files) {
    const prefix = path.basename(sourceRoot) + "/";
    assert.ok(
      item.path.startsWith(prefix),
      "Manifest path must stay within native bundle",
    );
    const file = before.find(
      (file) => file.path === item.path.slice(prefix.length),
    );
    assert.ok(
      file && file.bytes === item.bytes && file.sha256 === item.sha256,
      "Native bundle manifest must match complete primary bytes",
    );
  }
  const destination = path.join(configHome, "native-web-bundle");
  await cp(sourceRoot, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  assert.deepEqual(
    await snapshotNativeTree(destination),
    before,
    "Private copy must preserve complete native bytes",
  );
  const connection = JSON.parse(
    await readFile(path.join(destination, "model-connection.json"), "utf8"),
  );
  const launch = nativeReplaySettings(connection),
    launchSettings = path.join(configHome, "native-web-launch-settings.json");
  await writeFile(
    launchSettings,
    JSON.stringify(launch.settings, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const state = JSON.parse(
    await readFile(path.join(destination, session, "state.json"), "utf8"),
  );
  const workspace = state.base_cwd || state.cwd;
  assert.ok(
    path.isAbsolute(workspace) && (await lstat(workspace)).isDirectory(),
    "Retained actual cwd must remain available",
  );
  const facts = nativeWebFacts(await readFile(sourceHistory, "utf8"));
  return {
    sourceRoot,
    sourceHistory,
    destination,
    history: path.join(destination, session + ".jsonl"),
    workspace,
    sourceBefore: before,
    workspaceBefore: await snapshotNativeTree(workspace),
    launchSettings,
    launchSettingsFixtureBudgetFields: launch.fixtureBudgetFields,
    facts,
  };
}
