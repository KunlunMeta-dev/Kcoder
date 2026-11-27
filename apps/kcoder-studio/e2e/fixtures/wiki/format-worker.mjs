import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { rpcClient, initializeRpc } from "../../harness/rpc.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
const [root, binary] = process.argv.slice(2);
assert.ok(root && binary);
await readFile(join(root, "owned.json"));
const samples = join(root, "samples"),
  cases = JSON.parse(await readFile(join(samples, "manifest.json"), "utf8"));
const cleanup = [];
let child;
let rpc;
const results = [];
try {
  const model = await startApprovalModelFixture(
    { addCleanup: (_, fn) => cleanup.push(fn), registerPort: () => {} },
    {
      responseSteps: ({ body }) => {
        const content = body.messages
          .filter((m) => m.role === "user")
          .at(-1).content;
        const blocks =
          typeof content === "string" ? [{ text: content }] : content;
        const images = blocks.filter((b) => b.type === "image_url");
        let output;
        if (images.length) {
          assert.equal(images.length, 1);
          assert.match(
            images[0].image_url.url,
            /^data:image\/(png|jpeg|webp);base64,/,
          );
          output =
            "NATIVE_IMAGE_INTERPRETATION: fixture protocol accepted full original bytes.";
        } else {
          const data = JSON.parse(blocks.map((b) => b.text || "").join(""));
          if (!data.analysis)
            output = JSON.stringify({
              summary: "Format sample",
              queries: [],
              conflicts: [],
            });
          else
            output = JSON.stringify({
              pages: [
                {
                  pageId: data.newPageIds[0],
                  expectedRevision: null,
                  kind: "source",
                  title: "Format " + data.source.sourceId,
                  markdown:
                    "# Format source\n" +
                    data.source.chunks.map((c) => c.text).join("\n"),
                  citations: data.source.chunks.map((c) => ({
                    sourceId: data.source.sourceId,
                    revisionId: data.source.revisionId,
                    chunkId: c.chunkId,
                    quote: c.text,
                  })),
                  relatedPageIds: [],
                },
              ],
              reviewNotes: [],
            });
        }
        return [
          {
            delta: { role: "assistant", content: output },
            finishReason: "stop",
          },
        ];
      },
    },
  );
  const profile = join(root, "profile"),
    workspace = join(root, "workspace");
  await mkdir(profile, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({
      active_provider: "format-fixture",
      max_retries: 0,
      plugins: { runtime: { enabled: false } },
      providers: {
        "format-fixture": {
          api_format: "openai_chat_completions",
          authentication: { mode: "none" },
          endpoint: model.baseUrl,
          default_model: "format-fixture",
          context_window_tokens: 128000,
          max_output_tokens: 4096,
          output_headroom_tokens: 4096,
          no_proxy: true,
          capabilities: { text: true, tools: true, vision: true },
        },
      },
    }),
  );
  child = spawn(
    binary,
    [
      "--settings-file",
      join(profile, "settings.json"),
      "--cwd",
      workspace,
      "app-server",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        KCODER_CONFIG_DIR: profile,
        NO_PROXY: "*",
        no_proxy: "*",
      },
    },
  );
  let diagnostics = "";
  child.stderr.on(
    "data",
    (b) => (diagnostics = (diagnostics + b).slice(-2048)),
  );
  const socket = new EventTarget();
  socket.send = (s) => child.stdin.write(s + "\n");
  socket.close = () => child.stdin.end();
  createInterface({ input: child.stdout }).on("line", (data) =>
    socket.dispatchEvent(new MessageEvent("message", { data })),
  );
  rpc = rpcClient(socket);
  await initializeRpc(rpc, "wiki-format-audit");
  await rpc.request("knowledge/configure", { enabled: true });
  const library = await rpc.request("knowledge/create", {
    idempotencyKey: "formats",
    name: "Isolated format audit",
  });
  for (const sample of cases) {
    const row = {
      name: sample.name,
      edge: !!sample.edge,
      independentReaderVerified: sample.independentReaderVerified ?? null,
    };
    const bytes = await readFile(join(samples, sample.file || sample.name));
    let staged;
    const settingsPath = join(profile, "settings.json");
    if (sample.noVision) {
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.providers["format-fixture"].capabilities.vision = false;
      await writeFile(settingsPath, JSON.stringify(settings));
    }
    try {
      const upload = await rpc.request("attachment/upload/start", {
        filename: sample.name,
        size: bytes.length,
      });
      for (let i = 0, at = 0; at < bytes.length; i++, at += 192 * 1024)
        await rpc.request("attachment/upload/chunk", {
          upload_id: upload.upload_id,
          index: i,
          content_base64: bytes
            .subarray(at, at + 192 * 1024)
            .toString("base64"),
        });
      staged = (
        await rpc.request("attachment/upload/finish", {
          upload_id: upload.upload_id,
        })
      ).path;
      const source = await rpc.request(
        "knowledge/source/importAttachment",
        {
          libraryId: library.id,
          idempotencyKey: sample.name,
          title: sample.name,
          attachmentPath: staged,
        },
        120000,
      );
      if (sample.error)
        throw new Error("Unexpected success; expected " + sample.error);
      const read = await rpc.request("knowledge/source/read", {
        libraryId: library.id,
        sourceId: source.sourceId,
        revisionId: source.revisionId,
        limit: 16,
      });
      const text = read.items.map((c) => c.text).join("");
      row.extractedText = text.slice(0, 4096);
      row.pages = read.items
        .map((c) => c.page)
        .filter((p) => p !== null && p !== undefined);
      for(const excluded of sample.excluded??[])assert.ok(!text.includes(excluded),'Inactive HTML leaked: '+excluded);
      for (const marker of sample.markers)
        assert.ok(text.includes(marker), "Missing content: " + marker);
      if (sample.ordered)
        assert.ok(
          text.indexOf(sample.ordered[0]) < text.indexOf(sample.ordered[1]),
          "Presentation order",
        );
      if (sample.pages) assert.deepEqual([...new Set(row.pages)], sample.pages);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const original = await readFile(
        join(profile, "knowledge", "state.objects", library.id, hash + ".md"),
      );
      assert.ok(original.equals(bytes), "Original bytes must be preserved");
      row.originalRetained = true;
      const artifact = await rpc.request("knowledge/source/original/export", {
        libraryId: library.id,
        sourceId: source.sourceId,
        revisionId: source.revisionId,
      });
      const parts = [];
      let offset = 0;
      while (offset < artifact.size) {
        const value = await rpc.request("knowledge/export/read", {
          attachmentPath: artifact.path,
          offset,
        });
        parts.push(Buffer.from(value.contentBase64, "base64"));
        assert.ok(value.nextOffset > offset);
        offset = value.nextOffset;
      }
      assert.ok(
        Buffer.concat(parts).equals(bytes),
        "Original RPC download must preserve bytes",
      );
      await rpc.request("attachment/delete", { path: artifact.path });
      row.originalDownloadVerified = true;

      const job = await rpc.request("knowledge/job/start", {
        libraryId: library.id,
        sourceId: source.sourceId,
        revisionId: source.revisionId,
        idempotencyKey: "job-" + sample.name,
        language: "en",
      });
      const deadline = Date.now() + 30000;
      let status;
      do {
        status = await rpc.request("knowledge/job/get", {
          libraryId: library.id,
          jobId: job.id,
        });
        if (
          [
            "completed",
            "failed",
            "paused",
            "awaiting_review",
            "cancelled",
          ].includes(status.status)
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      } while (Date.now() < deadline);
      assert.equal(
        status.status,
        "completed",
        "Wiki organization job " + JSON.stringify(status),
      );
      row.organized = true;
      const pages = await rpc.request("knowledge/page/list", {
        libraryId: library.id,
        limit: 16,
      });
      let generated = "";
      for (const page of pages.items) {
        const detail = await rpc.request("knowledge/page/read", {
          libraryId: library.id,
          pageId: page.pageId,
          revisionId: page.revisionId,
        });
        if (
          detail.draft.citations.some((c) => c.sourceId === source.sourceId)
        ) {
          generated += detail.draft.markdown;
          row.citationsValidated = true;
        }
      }
      for (const marker of sample.markers)
        assert.ok(
          generated.includes(marker),
          "Organized page missing " + marker,
        );
      row.status = "passed";
    } catch (error) {
      row.error = error.message;
      row.status =
        sample.error &&
        error.message.toLowerCase().includes(sample.error.toLowerCase())
          ? "rejected-as-expected"
          : sample.edge
            ? "compatibility-gap"
            : "failed";
    } finally {
      if (staged)
        await rpc
          .request("attachment/delete", { path: staged })
          .catch(() => {});
      if (sample.noVision) {
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        settings.providers["format-fixture"].capabilities.vision = true;
        await writeFile(settingsPath, JSON.stringify(settings));
      }
    }
    results.push(row);
    console.log(JSON.stringify({ name: row.name, status: row.status }));
  }
  const directory = join(root, "directory-selection");
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < 11; i++)
    await writeFile(join(directory, `file-${i}.md`), "Directory source");
  const preview = await rpc.request("knowledge/source/directoryPreview", {
    directory,
  });
  assert.equal(preview.items.length, 11);
  const selected = await rpc.request("knowledge/source/directoryStage", {
    directory,
    selectedTitles: ["file-0.md"],
  });
  assert.equal(selected.items.length, 1);
  await rpc.request("attachment/delete", {
    path: selected.items[0].attachmentPath,
  });
  await assert.rejects(
    rpc.request("knowledge/source/directoryStage", {
      directory,
      selectedTitles: ["../file-0.md"],
    }),
  );
  const report = {
    platform: process.platform,
    modelPolicy:
      "deterministic transport/persistence; image recognition quality not measured",
    results,
    modelRequests: model.requests.length,
    compatibilityGaps: results.filter((r) => r.status === "compatibility-gap")
      .length,
    allTestedVariantsSupported: !results.some((r) =>
      ["failed", "compatibility-gap"].includes(r.status),
    ),
    coreFailures: results.filter((r) => r.status === "failed").length,
  };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  if (report.coreFailures) process.exitCode = 1;
} finally {
  rpc?.close();
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
  for (const fn of cleanup.reverse()) await fn();
}
