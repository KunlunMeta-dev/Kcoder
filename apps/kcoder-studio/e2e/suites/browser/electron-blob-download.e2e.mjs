import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "../../../renderer/node_modules/@playwright/test/index.mjs";
import {
  appRoot,
  runE2E,
  waitFor,
  requireExecutable,
} from "../../harness/run-context.mjs";
import { openRpc } from "../../harness/rpc.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// QA: production Electron host and download helper, owned local Blob exports;
// real GTK save/escape, disk bytes, explicit renderer outcome, unapproved frame.
await runE2E(
  import.meta.url,
  {
    testId: "electron-trusted-blob-save-and-cancel",
    tier: "full-integration",
    modelPolicy:
      "model-independent real Electron DownloadItem and save-dialog filesystem outcomes, no model calls",
    retainSuccessEvidence: true,
    evidenceReason:
      "Local Blob download completes and cancelled save is observable",
  },
  async (context) => {
    assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, "1");
    const electron = await requireExecutable(
      resolve(appRoot, "node_modules/electron/dist/electron"),
      "Electron",
    );
    const workspace = await materializeWorkspace(context, "minimal", {
      instanceId: "blob-download",
    });
    const rendererRoot = context.pathInState("renderer");
    const build = context.spawnOwned(
      "build-download-fixture",
      process.execPath,
      [
        resolve(appRoot, "e2e/fixtures/native-file-read/build.mjs"),
        rendererRoot,
      ],
      { cwd: resolve(appRoot, "renderer") },
    );
    await waitFor(
      () => build.exitCode !== null,
      60000,
      "download fixture build",
    );
    assert.equal(build.exitCode, 0);
    const child = context.spawnOwned(
      "blob-electron",
      "/usr/bin/xvfb-run",
      [
        "-a",
        electron,
        "--no-sandbox",
        "--disable-gpu",
        "--inspect=127.0.0.1:0",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        resolve(appRoot, "desktop/main.mjs"),
      ],
      {
        cwd: appRoot,
        env: context.isolatedEnvironment({
          KCODER_STUDIO_DESKTOP_USER_DATA_DIR:
            context.pathInState("electron-profile"),
          KCODER_STUDIO_WEB_ROOT: rendererRoot,
          KCODER_STUDIO_KCODER_BIN:
            process.env.KCODER_E2E_KCODER_BIN || "/usr/local/bin/kcoder",
          KCODER_STUDIO_WORKSPACE: workspace.path,
        }),
      },
    );
    let output = "";
    const collect = (data) => {
      output = (output + data.toString()).slice(-20000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const cdp = await waitFor(
      () =>
        output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
      30000,
      "owned Electron CDP",
    );
    context.registerPort("download-cdp", Number(new URL(cdp).port));
    const browser = await chromium.connectOverCDP(cdp);
    context.addCleanup("download CDP", async () => {
      await context.stopOwned("blob-electron");
      await browser.close();
    });
    const page = await waitFor(
      () =>
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().startsWith("http://127.0.0.1:")),
      30000,
      "owned application",
    );
    await page.getByTestId("download-wiki").waitFor();
    const address = output.match(
      /Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/,
    )?.[1];
    assert.ok(address);
    context.registerPort("download-inspector", Number(new URL(address).port));
    const inspector = await openRpc(address);
    context.addCleanup("download inspector", () => inspector.close());
    let sequence = 0;
    const evaluate = async (expression) => {
      const id = ++sequence;
      inspector.socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
      const response = await inspector.waitFor(
        (m) => m.id === id,
        10000,
        "owned main evaluation",
      );
      assert.ok(!response.error && !response.result?.exceptionDetails);
      return response.result.result.value;
    };
    const display = await evaluate(
      "({ DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY })",
    );
    let operations = 0;
    const xdotool = async (args) => {
      const p = context.spawnOwned(
        `download-dialog-${++operations}`,
        "/usr/bin/xdotool",
        args,
        { env: context.isolatedEnvironment(display) },
      );
      await waitFor(() => p.exitCode !== null, 5000, "owned save dialog input");
      assert.equal(p.exitCode, 0);
    };
    const mainMetrics = await evaluate(
      "(() => { const e = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); globalThis.ownedDownloadMetrics = { blocked: 0, allowed: 0 }; e.session.fromPartition('persist:kcoder-studio-desktop').on('will-download', event => { globalThis.ownedDownloadMetrics[event.defaultPrevented ? 'blocked' : 'allowed']++; }); return true; })()",
    );
    assert.equal(mainMetrics, true);
    const result = () =>
      page.evaluate(() => document.documentElement.dataset.downloadResult);
    for (const [kind, filename, content] of [
      ["wiki", "wiki-original.md", "# Owned Wiki source\n"],
      ["workflow", "workflow-owned.json", '{"id":"owned-workflow","nodes":[]}'],
      ["legacy", "legacy-wiki.md", "# Legacy Gateway Wiki export\n"],
    ]) {
      await page.evaluate(() => {
        delete document.documentElement.dataset.downloadResult;
      });
      if (kind === "legacy") {
        await page.evaluate(() => {
          const link = document.createElement("a");
          const url = URL.createObjectURL(new Blob(["# Legacy Gateway Wiki export\n"]));
          link.href = url; link.download = "legacy-wiki.md";
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      } else await page.getByTestId(`download-${kind}`).click();
      await waitFor(
        () => evaluate("globalThis.ownedDownloadMetrics.allowed"),
        10000,
        "real download admitted",
      );
      // Ctrl+L targets the Save chooser's full path input in the owned X display.
      await new Promise((resolveWait) => setTimeout(resolveWait, 700));
      const path = context.pathInState(filename);
      const shot = context.spawnOwned(
        `download-dialog-shot-${kind}`,
        "/usr/bin/import",
        ["-window", "root", context.pathInArtifacts(`dialog-${kind}.png`)],
        { env: context.isolatedEnvironment(display) },
      );
      await waitFor(() => shot.exitCode !== null, 5000, "dialog snapshot");
      await xdotool(["mousemove", "--sync", "250", "27", "click", "1"]);
      await xdotool(["key", "ctrl+a"]);
      await xdotool(["type", "--clearmodifiers", path]);
      await xdotool(["key", "Return"]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      await xdotool(["mousemove", "--sync", "1075", "799", "click", "1"]);
      try {
        await waitFor(
          async () => (await result())?.includes("completed"),
          15000,
          "native download completion",
        );
      } catch (error) {
        await context.writeArtifactJson("failure-observation.json", {
          outcome: await result(),
          metrics: await evaluate("globalThis.ownedDownloadMetrics"),
        });
        throw error;
      }
      assert.equal(await readFile(path, "utf8"), content);
    }
    await page.evaluate(() => {
      delete document.documentElement.dataset.downloadResult;
    });
    await page.getByTestId("download-wiki").click();
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    await xdotool(["key", "Escape"]);
    await waitFor(
      async () => (await result())?.includes("cancelled"),
      10000,
      "save cancellation outcome",
    );
    await page.getByText(/^(Download cancelled|下载已取消)$/).waitFor();
    const before = await evaluate("globalThis.ownedDownloadMetrics.blocked");
    await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const child = iframe.contentWindow;
      const url = child.URL.createObjectURL(
        new child.Blob(["owned unapproved frame"]),
      );
      const link = child.document.createElement("a");
      link.href = url;
      link.download = "unapproved-frame.txt";
      child.document.body.append(link);
      link.click();
    });
    await waitFor(
      async () =>
        (await evaluate("globalThis.ownedDownloadMetrics.blocked")) > before,
      5000,
      "unapproved frame download refused",
    );
    assert.equal(
      await access(context.pathInState("unapproved-frame.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
    await page.screenshot({
      path: context.pathInArtifacts("download-cancelled.png"),
    });
    await context.writeArtifactJson("download-result.json", {
      diskWikiBlobVerified: true,
      diskWorkflowBlobVerified: true,
      legacyMainDocumentBlobVerified: true,
      realSaveDialog: true,
      saveDialogCancelled: true,
      rendererCancellationObserved: true,
      unknownFrameRejected: true,
      metrics: await evaluate("globalThis.ownedDownloadMetrics"),
      modelCalls: 0,
    });
  },
);
