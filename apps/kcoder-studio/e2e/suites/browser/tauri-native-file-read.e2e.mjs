import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve, join, sep, extname } from "node:path";
import { startOwnedDisplay } from "../../harness/ai-verify-gateway.mjs";
import {
  appRoot,
  runE2E,
  waitFor,
  repoRoot,
} from "../../harness/run-context.mjs";

// QA: normal Native host, production begin/chunk/cancel app commands and frontend
// reader. Standard devUrl is compiled to this run's port-0 server; no Gateway
// verification mode or extra Native permissions. All files/processes are owned.
await runE2E(
  import.meta.url,
  {
    testId: "tauri-selected-file-native-budget-and-cancellation",
    tier: "full-integration",
    modelPolicy:
      "model-independent real Native app commands and bounded file fixtures, no model calls",
    retainSuccessEvidence: true,
    evidenceReason:
      "Formal Native IPC preserves 100 MiB reads with metadata admission and cancellation",
  },
  async (context) => {
    const root = context.pathInState("files");
    await mkdir(root);
    const sparse = async (name, size) => {
      const path = join(root, name),
        file = await open(path, "wx");
      try {
        await file.truncate(size);
      } finally {
        await file.close();
      }
      return path;
    };
    const small = join(root, "small.txt");
    await writeFile(small, "owned native text");
    const large = await sparse("large.bin", 100 * 1024 * 1024),
      oversized = await sparse("oversized.bin", 100 * 1024 * 1024 + 1);
    const total = join(root, "total");
    await mkdir(total);
    for (let index = 0; index < 6; index++)
      await sparse(`total/${index}.bin`, 100 * 1024 * 1024);
    const count = join(root, "count");
    await mkdir(count);
    for (let index = 0; index < 513; index++)
      await sparse(`count/${index}.txt`, 0);
    const deep = join(root, "deep");
    await mkdir(deep);
    let child = deep;
    for (let index = 0; index < 17; index++) {
      child = join(child, "d");
      await mkdir(child);
    }
    const rendererRoot = context.pathInState("renderer"),
      token = randomBytes(32).toString("hex");
    context.registerSecret(token);
    const cases = await context.writeStateJson("native-cases.json", {
      small,
      large,
      rejects: [
        [oversized, "100 MiB"],
        [total, "total size"],
        [count, "file count"],
        [deep, "depth"],
      ],
      token,
    });
    const build = context.spawnOwned(
      "build-file-fixture",
      process.execPath,
      [
        resolve(appRoot, "e2e/fixtures/native-file-read/build.mjs"),
        rendererRoot,
        cases,
      ],
      { cwd: resolve(appRoot, "renderer") },
    );
    await waitFor(() => build.exitCode !== null, 60000, "native fixture build");
    assert.equal(build.exitCode, 0);
    let result = null;
    const server = createServer(async (request, response) => {
      try {
        if (
          request.method === "POST" &&
          request.url === "/native-file-result"
        ) {
          if (request.headers.authorization !== `Bearer ${token}`) {
            response.writeHead(403);
            response.end();
            return;
          }
          let raw = "";
          for await (const chunk of request) {
            raw += chunk.toString();
            if (raw.length > 8192)
              throw new Error("Oversized Native fixture result");
          }
          result = JSON.parse(raw);
          response.end("ok");
          return;
        }
        const pathname = decodeURIComponent(
            new URL(request.url, "http://127.0.0.1").pathname,
          ),
          path = resolve(
            rendererRoot,
            `.${pathname === "/" ? "/index.html" : pathname}`,
          );
        if (!path.startsWith(rendererRoot + sep)) {
          response.writeHead(404);
          response.end();
          return;
        }
        const type =
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(path)] || "application/octet-stream";
        response.setHeader("content-type", type);
        response.end(await readFile(path));
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    context.addCleanup(
      "native fixture HTTP server",
      () =>
        new Promise((resolveClose) => {
          server.closeAllConnections();
          server.close(resolveClose);
        }),
    );
    await new Promise((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const port = server.address().port;
    context.registerPort("native-fixture", port);
    const target =
      process.env.KCODER_E2E_NATIVE_CARGO_TARGET ||
      resolve(repoRoot, "target/repair2-host-tauri");
    const tauriConfig = JSON.stringify({
      build: { devUrl: `http://127.0.0.1:${port}` },
    });
    const nativeBuild = context.spawnOwned(
      "build-native-file-host",
      "cargo",
      [
        "build",
        "--manifest-path",
        resolve(appRoot, "renderer/src-tauri/Cargo.toml"),
      ],
      {
        cwd: repoRoot,
        env: context.isolatedEnvironment({
          CARGO_TARGET_DIR: target,
          CARGO_BUILD_JOBS: "8",
          TAURI_CONFIG: tauriConfig,
          CARGO_HOME: process.env.CARGO_HOME || "/root/.cargo",
          RUSTUP_HOME: process.env.RUSTUP_HOME || "/root/.rustup",
        }),
      },
    );
    await waitFor(
      () => nativeBuild.exitCode !== null,
      60000,
      "normal Native host build",
    );
    assert.equal(nativeBuild.exitCode, 0);
    const display = await startOwnedDisplay(context),
      binary = join(target, "debug/app");
    const app = context.spawnOwned("normal-native-file-host", binary, [], {
      cwd: context.stateDir,
      env: context.isolatedEnvironment({
        DISPLAY: display.display,
        XAUTHORITY: display.authority,
        GDK_BACKEND: "x11",
        KCODER_STUDIO_APP_CONFIG_DIR: context.pathInState("native-config"),
        WEGENT_EXECUTOR_HOME: context.pathInState("executor-home"),
      }),
    });
    const samples = [];
    const sample = async () => {
      const status = await readFile(`/proc/${app.pid}/status`, "utf8").catch(
        () => "",
      );
      const rss = status.match(/^VmRSS:\s+(\d+)/m)?.[1];
      if (rss) samples.push(Number(rss));
    };
    const timer = setInterval(() => {
      void sample();
    }, 20);
    context.addCleanup("native RSS sampling", () => clearInterval(timer));
    await waitFor(() => result, 60000, "normal Native file command results");
    await sample();
    clearInterval(timer);
    await context.writeArtifactJson("native-read-result.json", {
      ...result,
      tauriBinarySha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      formalNativeEntry: true,
      gatewayVerificationMode: false,
      rssKiBSamples: samples,
      maxNativeRssKiB: Math.max(...samples),
    });
    const screenshot = context.spawnOwned(
      "native-file-screenshot",
      "/usr/bin/import",
      ["-window", "root", context.pathInArtifacts("native-file-read.png")],
      {
        env: context.isolatedEnvironment({
          DISPLAY: display.display,
          XAUTHORITY: display.authority,
        }),
      },
    );
    await waitFor(
      () => screenshot.exitCode !== null,
      5000,
      "Native result screenshot",
    );
    assert.equal(screenshot.exitCode, 0);
    assert.equal(result.status, "passed", result.error);
    assert.equal(result.nativeAppCommands, true);
    assert.equal(result.exact100MiBImported, true);
    assert.equal(result.cancelledAndRecovered, true);
    assert.ok(
      Math.max(...samples) < 256 * 1024,
      "Native host RSS must remain below 256 MiB through 100 MiB transfer",
    );
  },
);
