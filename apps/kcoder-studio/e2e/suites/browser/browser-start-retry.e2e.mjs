import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import {
  repoRoot,
  requireExecutable,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const START_FAILURE = "KCODER_E2E_BROWSER_FIRST_START_FAILED";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "real-browser-startup-failure-same-url-retry",
    tier: "full-integration",
    modelPolicy:
      "no model turn; real Gateway/app-server browser process failure and UI recovery",
  },
  async (context) => {
    if (
      process.platform !== "linux" ||
      process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1"
    ) {
      throw new Error(
        "UNMET_PREREQUISITE: Linux isolated browser failure fixture requires explicit KCODER_E2E_CHROMIUM_NO_SANDBOX=1",
      );
    }
    const chrome = await requireExecutable(
      process.env.KCODER_E2E_CHROMIUM_BIN ||
        "/usr/local/lib/kcoder/chrome/chrome-linux64/chrome",
      "managed Chrome",
    );
    const kcoder = await requireExecutable(
      resolve(repoRoot, "target/debug/kcoder"),
      "KCoder app-server",
    );
    const chromium = await startChromium(context, {
      label: "browser-retry-chromium",
      executablePath: chrome,
    });
    const site = await startFixtureSite(context, {
      title: "Browser retry recovered",
      marker: "BROWSER_RETRY_RECOVERED",
    });
    const results = [];

    for (const action of ["submit", "reload"]) {
      const { path: workspace } = await materializeWorkspace(
        context,
        "minimal",
        { instanceId: `browser-retry-${action}` },
      );
      const attemptsPath = context.pathInState(`browser-attempts-${action}`);
      const markerPath = context.pathInState(`browser-failed-${action}`);
      const wrapperPath = context.pathInState(`browser-fail-once-${action}.sh`);
      // Fault injection runs before Chrome starts; it does not replace browser RPC or DOM behavior.
      await writeFile(
        wrapperPath,
        [
          "#!/bin/sh",
          `printf 'attempt\\n' >> ${shellQuote(attemptsPath)}`,
          `if [ ! -e ${shellQuote(markerPath)} ]; then`,
          `  printf 'failed\\n' > ${shellQuote(markerPath)}`,
          `  printf '%s\\n' '${START_FAILURE}' >&2`,
          "  exit 1",
          "fi",
          `exec ${shellQuote(chrome)} "$@"`,
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const serversFile = await context.writeStateJson(
        `servers-${action}.json`,
        [
          {
            id: "local",
            label: `Browser retry ${action}`,
            transport: "local",
            command: kcoder,
            workspace,
            chromiumBin: wrapperPath,
            chromiumNoSandbox: true,
          },
        ],
      );
      const gatewayLabel = `browser-retry-${action}-gateway`;
      const gateway = await startGateway(context, {
        label: gatewayLabel,
        workspace,
        serversFile,
        auth: true,
      });
      const browserContext = await chromium.browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      context.addCleanup(`close ${action} browser context`, () =>
        browserContext.close(),
      );
      const page = await browserContext.newPage();
      const wire = { starts: 0, reloads: 0 };
      const diagnostics = [];
      page.on("pageerror", (error) => diagnostics.push(error.message));
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          try {
            const message = JSON.parse(String(payload));
            if (message.method === "browser/start") wire.starts += 1;
            if (
              message.method === "browser/action" &&
              message.params?.action === "reload"
            )
              wire.reloads += 1;
          } catch {
            /* Ignore non-JSON frames. */
          }
        });
      });
      try {
        await login(page, gateway);
        await page.getByTestId("toggle-right-workspace-panel-button").click();
        await page.getByTestId("right-workspace-browser-option").click();
        const address = page.getByTestId("workspace-browser-url-input");
        await address.fill(site.url);
        await address.press("Enter");
        const error = page.getByTestId("workspace-browser-error");
        await error
          .filter({ hasText: START_FAILURE })
          .waitFor({ state: "visible", timeout: 30_000 });
        assert.equal(await address.inputValue(), site.url);
        assert.equal(await attempts(attemptsPath), 1);
        assert.equal(wire.starts, 1);
        assert.equal(
          await page.getByTestId("kcoder-remote-browser-surface").count(),
          0,
        );

        if (action === "submit") await address.press("Enter");
        else await page.getByTestId("workspace-browser-reload-button").click();
        await waitFor(
          async () => (await attempts(attemptsPath)) === 2,
          30_000,
          `${action} starts a second OS process`,
        );
        await page
          .getByTestId("right-workspace-browser-tab")
          .filter({ hasText: site.title })
          .waitFor({ state: "visible", timeout: 30_000 });
        const surface = page.getByTestId("kcoder-remote-browser-surface");
        await surface.waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction(
          () => {
            const image = document.querySelector(
              '[data-testid="kcoder-remote-browser-surface"]',
            );
            return (
              image instanceof HTMLImageElement &&
              image.complete &&
              image.naturalWidth > 0
            );
          },
          undefined,
          { timeout: 30_000 },
        );
        assert.equal(await error.count(), 0);
        assert.equal(await address.inputValue(), site.url);
        assert.equal(wire.starts, 2);
        assert.equal(
          wire.reloads,
          0,
          "a failed start must retry browser/start, not reload a nonexistent session",
        );
        assert.deepEqual(diagnostics, []);
        await page.screenshot({
          path: context.pathInCase(
            "system-chromium",
            `same-url-${action}`,
            "recovered.png",
          ),
          fullPage: true,
        });
        await page.getByTestId("right-workspace-browser-tab").hover();
        await page
          .getByTestId("right-workspace-browser-tab-close-button")
          .click();
        await surface.waitFor({ state: "detached", timeout: 30_000 });
        results.push({
          action,
          starts: wire.starts,
          osStarts: await attempts(attemptsPath),
          missingSessionReloads: wire.reloads,
          sameUrlRecovered: true,
        });
      } catch (error) {
        await context.writeArtifactJson(`${action}-failure.json`, {
          error: String(error),
          diagnostics,
          wire,
        });
        await page
          .screenshot({
            path: context.pathInCase(
              "system-chromium",
              `same-url-${action}`,
              "failure.png",
            ),
            mask: [page.locator('input[name="token"]')],
            fullPage: true,
          })
          .catch(() => undefined);
        throw error;
      } finally {
        await browserContext.close();
        await context.stopOwned(gatewayLabel);
      }
    }
    return {
      cases: results,
      screenshotsReason: "critical same-URL browser retry UI recovery",
    };
  },
);

async function login(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page
    .getByTestId("desktop-sidebar")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function attempts(path) {
  return (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean).length;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
