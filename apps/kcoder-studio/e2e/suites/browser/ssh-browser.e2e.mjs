import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import {
  repoRoot,
  requireExecutable,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { startSshFixture } from "../../harness/ssh-fixture.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "loopback-ssh-remote-browser",
    tier: "pr-smoke",
    modelPolicy: "model-independent browser transport/lifecycle check",
    retainSuccessLogs: true,
  },
  async (context) => {
    const kcoderBin = await requireExecutable(
      resolve(repoRoot, "target/debug/kcoder"),
      "KCoder app-server",
    );
    const chromiumBin = await requireExecutable(
      process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
      "Chromium",
    );
    const noSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
    if (!noSandbox && process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX !== "1") {
      throw new Error(
        "UNMET_PREREQUISITE: explicitly set KCODER_E2E_CHROMIUM_NO_SANDBOX=1 for this isolated VM, or KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1 to require sandboxed Chromium",
      );
    }
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "ssh-browser",
    });
    const ssh = await startSshFixture(context);
    const site = await startFixtureSite(context, {
      title: "KCoder SSH Browser E2E",
      marker: "SSH_BROWSER_E2E_OK",
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "ssh-loopback",
        label: "Loopback SSH",
        transport: "ssh",
        host: "127.0.0.1",
        user: ssh.user,
        port: ssh.port,
        command: kcoderBin,
        workspace,
        chromiumBin,
        chromiumNoSandbox: noSandbox,
        acceptNewHostKey: true,
      },
    ]);
    const gateway = await startGateway(context, {
      workspace,
      serversFile,
      env: { ...ssh.gatewayEnv, KCODER_STUDIO_SCENARIO: "full-turn" },
    });
    const token = await waitForGatewayRpcToken(context, gateway);
    const rpc = await openRpc(
      gatewayRpcUrl(gateway, "ssh-loopback", token, "browser"),
    );
    context.addCleanup("close browser RPC", () => rpc.close());
    const initialized = await initializeRpc(rpc, "kcoder-e2e-ssh-browser");
    assert.equal(initialized.serverInfo.name, "kcoder-app-server");
    const browser = await rpc.request(
      "browser/start",
      { url: site.url, width: 800, height: 600 },
      60_000,
    );
    assert.equal(browser.sandbox_disabled, noSandbox);
    const screenshot = await rpc.request(
      "browser/screenshot",
      { session_id: browser.session_id },
      30_000,
    );
    assert.equal(screenshot.page.title, site.title);
    const screenshotData = Buffer.from(screenshot.data_base64, "base64");
    const screenshotBytes = screenshotData.length;
    assert.ok(
      screenshotBytes > 5_000,
      `remote screenshot too small: ${screenshotBytes}`,
    );
    const caseScreenshot = context.pathInCase(
      "node",
      "loopback-ssh-remote-browser",
      "remote-browser.jpg",
    );
    await mkdir(resolve(caseScreenshot, ".."), { recursive: true });
    await writeFile(caseScreenshot, screenshotData);
    const invalidPopupLink = await rpc.request("browser/evaluate", {
      session_id: browser.session_id,
      expression:
        "(() => { const rect = document.getElementById('invalid-popup').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()",
    });
    let rejectionObserved = false;
    try {
      await rpc.request("browser/action", {
        session_id: browser.session_id,
        action: "click",
        x: invalidPopupLink.value.x,
        y: invalidPopupLink.value.y,
      });
    } catch (error) {
      assert.match(String(error), /popup URL is not allowed/);
      rejectionObserved = true;
    }
    if (!rejectionObserved)
      await waitFor(
        async () => {
          try {
            await rpc.request(
              "browser/screenshot",
              { session_id: browser.session_id },
              30_000,
            );
            return null;
          } catch (error) {
            if (/popup URL is not allowed/.test(String(error))) return true;
            throw error;
          }
        },
        15_000,
        "disallowed popup rejection",
      );
    const recoveredOpener = await rpc.request(
      "browser/screenshot",
      { session_id: browser.session_id },
      30_000,
    );
    assert.equal(
      recoveredOpener.page.title,
      site.title,
      "拒绝非法 popup 后必须保留并恢复 opener session",
    );
    const popupLink = await rpc.request("browser/evaluate", {
      session_id: browser.session_id,
      expression:
        "(() => { const rect = document.getElementById('popup').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()",
    });
    assert.ok(
      Number.isFinite(popupLink.value?.x) &&
        Number.isFinite(popupLink.value?.y),
    );
    await rpc.request("browser/action", {
      session_id: browser.session_id,
      action: "click",
      x: popupLink.value.x,
      y: popupLink.value.y,
    });
    const popupScreenshot = await waitFor(
      async () => {
        const candidate = await rpc.request(
          "browser/screenshot",
          { session_id: browser.session_id },
          30_000,
        );
        return candidate.page.title === `${site.title} Popup`
          ? candidate
          : null;
      },
      15_000,
      "target=_blank popup adoption",
    );
    assert.ok(popupScreenshot.page.url.endsWith("/popup"));
    assert.equal(popupScreenshot.page.canGoBack, true);
    assert.equal(popupScreenshot.page.canGoForward, false);
    await rpc.request("browser/action", {
      session_id: browser.session_id,
      action: "back",
    });
    const backScreenshot = await rpc.request(
      "browser/screenshot",
      { session_id: browser.session_id },
      30_000,
    );
    assert.equal(backScreenshot.page.title, site.title);
    assert.equal(backScreenshot.page.canGoBack, false);
    assert.equal(backScreenshot.page.canGoForward, true);
    await rpc.request("browser/action", {
      session_id: browser.session_id,
      action: "forward",
    });
    const forwardScreenshot = await rpc.request(
      "browser/screenshot",
      { session_id: browser.session_id },
      30_000,
    );
    assert.equal(forwardScreenshot.page.title, `${site.title} Popup`);
    assert.ok(forwardScreenshot.page.url.endsWith("/popup"));
    assert.equal(forwardScreenshot.page.canGoBack, true);
    assert.equal(forwardScreenshot.page.canGoForward, false);
    const closed = await rpc.request(
      "browser/close",
      { session_id: browser.session_id },
      20_000,
    );
    assert.equal(closed.closed, true);
    const closedAgain = await rpc.request(
      "browser/close",
      { session_id: browser.session_id },
      20_000,
    );
    assert.equal(closedAgain.closed, false);
    rpc.close();
    await waitFor(
      () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
      5_000,
      "browser RPC close",
    );
    return {
      serverId: "ssh-loopback",
      title: screenshot.page.title,
      popupTitle: popupScreenshot.page.title,
      disallowedPopupRejectedWithoutPoisoningSession: true,
      backForwardRoundTrip: true,
      screenshotBytes,
      chromiumSandboxDisabled: noSandbox,
      browserClosed: closed.closed,
      browserClosedAgain: closedAgain.closed,
    };
  },
);
