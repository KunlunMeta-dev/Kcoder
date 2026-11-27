import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  copyNativeWebBundle,
  nativeReplaySettings,
  nativeWebFacts,
  snapshotNativeTree,
} from "../lib/native-web-history.mjs";

const settings = () => ({
  providers: {
    fixture: {
      endpoint: "http://127.0.0.1:1/v1",
      authentication: { mode: "none" },
      context_window_tokens: "[REDACTED]",
      output_headroom_tokens: "[REDACTED]",
      max_output_tokens: "[REDACTED]",
    },
  },
});
const row = (operation, readStatus) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: operation, content: [] }],
  webSources: [
    {
      schemaVersion: 1,
      toolCallId: operation,
      operation,
      sources: [
        {
          sourceId: operation,
          title: "Owned",
          url: "https://example.com/" + operation,
          readStatus,
        },
      ],
    },
  ],
});
const history = () =>
  [row("search", "summary_only"), row("fetch", "read")]
    .map(JSON.stringify)
    .join("\n") + "\n";

test("private replay fixes only public numeric fixture budgets without changing original snapshot", () => {
  const source = settings(),
    copy = structuredClone(source),
    result = nativeReplaySettings(source);
  assert.deepEqual(source, copy);
  assert.equal(result.settings.providers.fixture.context_window_tokens, 128000);
  assert.equal(result.settings.providers.fixture.output_headroom_tokens, 8192);
  assert.equal(result.settings.providers.fixture.max_output_tokens, 8192);
  assert.equal(result.fixtureBudgetFields.length, 3);
});
test("replay rejects external provider and credential snapshots", () => {
  const external = settings();
  external.providers.fixture.endpoint = "https://example.com/v1";
  assert.throws(() => nativeReplaySettings(external), /external provider/);
  const authenticated = settings();
  authenticated.providers.fixture.authentication.mode = "keyring";
  assert.throws(() => nativeReplaySettings(authenticated), /credential/);
});
test("native receipt facts require actual matching tool-result identities", () => {
  assert.equal(nativeWebFacts(history()).receipts, 2);
  const forged = row("search", "summary_only");
  forged.content[0].tool_use_id = "unrelated";
  assert.throws(
    () => nativeWebFacts(JSON.stringify(forged)),
    /bind the same row/,
  );
});
test("complete private replay preserves source/control/sidecar bytes and retained cwd", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "kcoder-native-history-unit-"),
  );
  try {
    const bundle = path.join(root, "bundle"),
      profile = path.join(root, "profile"),
      workspace = path.join(bundle, "workspace");
    await mkdir(path.join(bundle, "owned.hctl"), { recursive: true });
    await mkdir(path.join(bundle, "owned"));
    await mkdir(profile);
    await mkdir(workspace);
    await writeFile(path.join(bundle, "owned.jsonl"), history());
    await writeFile(path.join(bundle, "owned.hctl/source.json"), "{}");
    await writeFile(
      path.join(bundle, "owned/state.json"),
      JSON.stringify({ base_cwd: workspace }),
    );
    await writeFile(path.join(bundle, "owned/imported-context.v1"), "{}");
    await writeFile(
      path.join(bundle, "model-connection.json"),
      JSON.stringify(settings()),
    );
    await writeFile(path.join(bundle, "workspace-source.json"), "{}");
    const primary = await snapshotNativeTree(bundle);
    await writeFile(
      path.join(bundle, "files.json"),
      JSON.stringify({
        threadId: "owned",
        files: primary
          .filter((item) => item.path.startsWith("owned"))
          .map((item) => ({ ...item, path: "bundle/" + item.path })),
      }),
    );
    const before = await snapshotNativeTree(bundle),
      replay = await copyNativeWebBundle(
        path.join(bundle, "owned.jsonl"),
        profile,
      );
    assert.deepEqual(await snapshotNativeTree(bundle), before);
    assert.deepEqual(await snapshotNativeTree(replay.destination), before);
    assert.equal(replay.workspace, workspace);
    assert.equal(
      JSON.parse(await readFile(replay.launchSettings, "utf8")).providers
        .fixture.max_output_tokens,
      8192,
    );
    await writeFile(path.join(bundle, "owned.jsonl"), history() + "\n");
    await assert.rejects(
      copyNativeWebBundle(
        path.join(bundle, "owned.jsonl"),
        path.join(root, "other-profile"),
      ),
      /manifest/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
