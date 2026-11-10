import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { startGateway } from "../harness/gateway.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const configuredBinary = resolve(
  process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/release/kcoder"),
);
const configuredWebRoot = process.env.KCODER_E2E_BLOCKQUOTE_WEB_ROOT;
const initialPrompt =
  "KCODER_QUOTE_THEME_PROBE inspect `read` and src/sample.txt\n\n> KCODER_QUOTE_THEME_PROBE **visible quote** `read`\n\n";
const quoteMarker = "KCODER_QUOTE_THEME_PROBE";
const expectedQuoteText = `${quoteMarker} visible quote read`;
const responseSentinel = "tui-lab-mixed-tools-final-sentinel";
const appPreferencesKey = "kcoder-studio:mobile-app-preferences:v1";

async function verifyProcessingTimeline(context, page, assistant) {
  const group = assistant.locator('[data-testid^="ordered-message-processing-"]:not([data-testid$="-toggle"]):not([data-testid$="-details"])');
  assert.equal(await group.count(), 1);
  const id = await group.getAttribute("data-testid");
  const toggle = assistant.getByTestId(`${id}-toggle`);
  await toggle.click();
  const details = assistant.getByTestId(`${id}-details`);
  await details.waitFor({ state: "visible" });
  const observations = [];
  for (const colorScheme of ["dark", "light"]) {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(expected => document.documentElement.style.colorScheme === expected, colorScheme);
      await group.scrollIntoViewIfNeeded();
      const steps = await details.locator(':scope > [data-testid^="processing-step-"]').evaluateAll(elements => elements.map(element => {
        const node = element.querySelector('[data-testid^="transcript-node-"]');
        const chevron = element.querySelector('[data-testid^="transcript-chevron-"]');
        const line = element.querySelector('[data-testid$="-connector"]');
        const copy = node.nextElementSibling;
        const label = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT).nextNode().parentElement;
        return {
          nodeX: node.getBoundingClientRect().x,
          chevronX: chevron.getBoundingClientRect().x,
          dashed: getComputedStyle(line).borderLeftStyle,
          fontSize: getComputedStyle(label).fontSize,
          lineHeight: getComputedStyle(label).lineHeight,
          height: element.getBoundingClientRect().height,
        };
      }));
      assert.equal(steps.length, 6);
      for (const step of steps) {
        assert.equal(step.nodeX, steps[0].nodeX);
        assert.equal(step.chevronX, steps[0].chevronX);
        assert.ok(step.chevronX > step.nodeX);
        assert.equal(step.dashed, "dashed");
        assert.equal(step.fontSize, "16px");
        assert.equal(step.lineHeight, "24px");
        assert.ok(step.height >= 44 && step.height <= 60);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await group.screenshot({ path: context.pathInArtifacts(`timeline-${width}-${colorScheme}.png`) });
      const user = page.getByTestId("message-user").first().locator(":scope > *").first();
      const bubble = await user.evaluate(element => {
        const style = getComputedStyle(element);
        const text = getComputedStyle(element.firstElementChild);
        return { paddingX: style.paddingLeft, paddingY: style.paddingTop,
          fontSize: text.fontSize, lineHeight: text.lineHeight, radius: style.borderTopLeftRadius };
      });
      assert.deepEqual(bubble, { paddingX: "12px", paddingY: "8px", fontSize: "17px", lineHeight: "28px", radius: "22px" });
      await user.scrollIntoViewIfNeeded();
      await page.screenshot({ path: context.pathInArtifacts(`conversation-${width}-${colorScheme}.png`) });
      observations.push({ colorScheme, width, steps, bubble });
    }
  }
  // Synthetic layout stress exercises endpoint measurement without pretending
  // that these diagnostic labels came from the app-server fixture.
  await details.evaluate(element => {
    const steps = [...element.querySelectorAll(':scope > [data-testid^="processing-step-"]')];
    for (const step of [steps[0], steps.at(-1)]) {
      const copy = step.querySelector('[data-testid^="transcript-node-"]').nextElementSibling;
      const text = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT).nextNode();
      text.parentElement.dataset.originalTimelineLabel = text.textContent;
      text.textContent = "长标题换行布局验证 ".repeat(8);
    }
  });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-original-timeline-label]')].every(label => {
    const step = label.closest('[data-testid^="processing-step-"]');
    const node = step.querySelector('[data-testid^="transcript-node-"]').getBoundingClientRect();
    const line = step.querySelector('[data-testid$="-connector"]').getBoundingClientRect();
    return step.getBoundingClientRect().height > 60 && Math.abs((step === step.parentElement.firstElementChild ? line.top : line.bottom) - (node.top + node.height / 2)) <= 1;
  }));
  await group.screenshot({ path: context.pathInArtifacts("timeline-long-labels.png") });
  await details.evaluate(element => {
    for (const label of element.querySelectorAll('[data-original-timeline-label]')) {
      label.firstChild.textContent = label.dataset.originalTimelineLabel;
      delete label.dataset.originalTimelineLabel;
    }
  });
  const thoughts = details.locator('[data-testid^="ordered-message-segment-thinking-"][data-testid$="-toggle"]');
  assert.equal(await thoughts.count(), 2);
  await thoughts.first().click();
  assert.equal(await thoughts.first().getAttribute("aria-expanded"), "true");
  assert.equal(await thoughts.last().getAttribute("aria-expanded"), "false");
  const tool = details.locator('[data-testid^="tool-call-toggle-"]').first();
  await tool.click();
  assert.equal(await tool.getAttribute("aria-expanded"), "true");
  assert.equal(await thoughts.first().getAttribute("aria-expanded"), "true");
  await thoughts.first().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    "expanded thinking and tool details must not overflow the page horizontally");
  await page.screenshot({ path: context.pathInArtifacts("timeline-expanded.png") });
  await toggle.click();
  await context.writeArtifactJson("processing-timeline-observed.json", observations);
  await page.setViewportSize({ width: 390, height: 844 });
}

assert.ok(
  typeof configuredWebRoot === "string" && isAbsolute(configuredWebRoot),
  "KCODER_E2E_BLOCKQUOTE_WEB_ROOT must be an absolute, already-built Mobile Web root",
);
assert.ok(Array.from(initialPrompt).length <= 120, "the complete quote probe must survive mixed-tools short_preview");

await runE2E(
  import.meta.url,
  {
    testId: "mobile-blockquote-theme-diagnostic",
    tier: "manual-live",
    retainSuccessLogs: true,
    cleanupTimeoutMs: 30_000,
    modelPolicy:
      "focused Mobile Markdown blockquote light/dark contrast check through an isolated real Gateway and app-server mixed-tools scenario; no Provider or model request",
  },
  async (context) => {
    const webRoot = await verifyMobileWebRoot(configuredWebRoot);

    const configuredBinaryBefore = await hashExecutableFile(configuredBinary);
    const ownedBinDir = context.pathInState("bin");
    await mkdir(ownedBinDir, { recursive: true, mode: 0o700 });
    const ownedBinary = resolve(ownedBinDir, "kcoder");
    await copyFile(configuredBinary, ownedBinary);
    await chmod(ownedBinary, 0o700);
    const [configuredBinaryAfterCopy, ownedBinaryBefore] = await Promise.all([
      hashExecutableFile(configuredBinary),
      hashExecutableFile(ownedBinary),
    ]);
    assert.equal(configuredBinaryAfterCopy.sha256, configuredBinaryBefore.sha256);
    assert.equal(ownedBinaryBefore.sha256, configuredBinaryBefore.sha256);

    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    await mkdir(resolve(workspace, "src"), { recursive: true, mode: 0o700 });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(resolve(workspace, "src/sample.txt"), "sample workspace file\n", "utf8");
    await writeFile(resolve(workspace, "src/sample.py"), "print('sample workspace file')\n", "utf8");
    await context.writeStateJson("config/settings.json", {});
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Owned blockquote theme diagnostic",
        runtime: "kcoder",
        transport: "local",
        command: ownedBinary,
        workspace,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "mobile-blockquote-theme-gateway",
      workspace,
      serversFile,
      kcoderBin: ownedBinary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: webRoot.path,
        KCODER_STUDIO_MOBILE_WEB_ROOT: webRoot.path,
        KCODER_STUDIO_SCENARIO: "mixed-tools",
      },
    });
    const httpReadiness = await verifyMountedMobileHttp(context, gateway, webRoot);
    const chromium = await startChromium(context, {
      label: "mobile-blockquote-theme-chromium",
      noSandbox: true,
      startTimeoutMs: 45_000,
    });
    const page = await chromium.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    const diagnostics = [];
    page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
    });
    const rpc = captureTurnStart(page, gateway.wsUrl);
    const navigation = createNavigationTimeline(page, gateway.baseUrl, chromium.browser);

    const mobileUrl = new URL("/mobile/", gateway.baseUrl).href;
    navigation.begin(mobileUrl);
    try {
      await page.goto(mobileUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      navigation.finish("completed");
    } catch (error) {
      navigation.finish("failed", error);
      throw error;
    } finally {
      await context.writeArtifactJson("mobile-blockquote-navigation-timeline.json", navigation.snapshot());
    }
    await page.getByTestId("welcome-direct-connection").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.getByTestId("welcome-direct-connection").click();
    await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
    await page.getByTestId("gateway-connect").click();
    await page.getByTestId("new-workspace").waitFor({
      state: "visible",
      timeout: 20_000,
    });

    const preferenceAtStart = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return { stored: false, preference: "system-default" };
      try {
        return { stored: true, preference: JSON.parse(raw)?.theme ?? "system-default" };
      } catch {
        return { stored: true, preference: "invalid" };
      }
    }, appPreferencesKey);
    assert.ok(
      preferenceAtStart.preference === "system-default" || preferenceAtStart.preference === "system",
      "fresh isolated Web profile must keep the normal system theme preference",
    );

    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("new-workspace-prompt").fill(initialPrompt);
    await page.getByTestId("create-workspace").click();
    await page.getByText(responseSentinel, { exact: false }).waitFor({
      state: "visible",
      timeout: 55_000,
    });

    const turn = await waitFor(
      () => rpc.turnStarts.find((entry) => entry.response?.ok),
      10_000,
      "successful browser turn/start RPC to the owned local app-server",
      50,
      context.abortSignal,
    );
    assert.ok(turn.request.promptHasProbe, "turn/start must carry the quote probe prompt");
    assert.equal(turn.request.promptSha256, sha256(initialPrompt.trim()));
    assert.equal(rpc.turnStarts.filter((entry) => entry.response?.ok).length, 1);

    const assistant = page
      .locator('[data-testid="message-assistant"]')
      .filter({ hasText: responseSentinel })
      .last();
    await assistant.getByText("visible quote", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });

    if (process.env.KCODER_E2E_PROCESSING_TIMELINE === "1") {
      await verifyProcessingTimeline(context, page, assistant);
    }
    const observations = [];
    for (const colorScheme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(
        (expected) => document.documentElement.style.colorScheme === expected,
        colorScheme,
        { timeout: 10_000 },
      );
      const quoteText = assistant.getByText("visible quote", { exact: true });
      const quoteBox = await findQuoteBox(quoteText, expectedQuoteText);
      try {
        const style = await quoteBox.evaluate((box, expectedTexts) => {
          const findTextNode = (value) => {
            const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const start = node.nodeValue?.indexOf(value) ?? -1;
              if (start >= 0) return { node, start };
            }
            return null;
          };
          const inspectText = (value) => {
            const match = findTextNode(value);
            if (!match) return null;
            const { node, start } = match;
            const element = node.parentElement;
            if (!element) return null;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + value.length);
            const rects = [...range.getClientRects()];
            const ancestors = [];
            for (let current = element; current; current = current.parentElement) {
              const computed = getComputedStyle(current);
              ancestors.push({
                backgroundColor: computed.backgroundColor,
                display: computed.display,
                opacity: Number(computed.opacity),
                visibility: computed.visibility,
              });
              if (current === document.documentElement) break;
            }
            const computed = getComputedStyle(element);
            return {
              text: value,
              nodeValue: node.nodeValue,
              element: element.tagName.toLowerCase(),
              color: computed.color,
              backgroundColor: computed.backgroundColor,
              backgroundLayers: ancestors.reverse().map((entry) => entry.backgroundColor),
              fontFamily: computed.fontFamily,
              fontWeight: computed.fontWeight,
              opacity: ancestors.reduce((result, entry) => result * entry.opacity, 1),
              visible: rects.some((rect) => rect.width > 0 && rect.height > 0) &&
                ancestors.every((entry) => entry.display !== "none" && entry.visibility !== "hidden" && entry.opacity > 0),
            };
          };
          const texts = Object.fromEntries(expectedTexts.map(({ name, text }) => [name, inspectText(text)]));
          const bounds = box.getBoundingClientRect();
          return {
            rootColorScheme: document.documentElement.style.colorScheme,
            mediaColorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
            quoteElement: box.tagName.toLowerCase(),
            quoteBackground: getComputedStyle(box).backgroundColor,
            quoteBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            boxText: box.innerText,
            texts,
          };
        }, [
          { name: "normalText", text: quoteMarker },
          { name: "boldText", text: "visible quote" },
          { name: "inlineCode", text: "read" },
        ]);
        assert.equal(style.rootColorScheme, colorScheme, `${colorScheme} theme must be active in the real Web app`);
        assert.equal(style.mediaColorScheme, colorScheme, `${colorScheme} media preference must be active`);
        assert.equal(
          style.boxText.replace(/\s+/g, " ").trim(),
          expectedQuoteText,
          `${colorScheme} screenshot target must contain only the Markdown quote probe`,
        );
        assert.ok(style.boxText.replace(/\s+/g, " ").includes(`${quoteMarker} visible quote read`));

        const textObservations = {};
        for (const [name, text] of Object.entries(style.texts)) {
          assert.ok(text, `${colorScheme} ${name} must resolve to a real rendered TextNode`);
          assert.ok(text.visible, `${colorScheme} ${name} TextNode must be visible in the real Web DOM`);
          const contrast = contrastRatio(text.color, effectiveBackground(text.backgroundLayers), text.opacity);
          assert.ok(
            contrast >= 4.5,
            `${colorScheme} ${name} text/background contrast ${contrast.toFixed(2)} is below 4.5 (${text.color} on ${text.backgroundColor})`,
          );
          textObservations[name] = {
            text: text.text,
            textNodeValue: text.nodeValue,
            element: text.element,
            color: text.color,
            elementBackground: text.backgroundColor,
            effectiveBackground: effectiveBackground(text.backgroundLayers),
            contrastRatio: Number(contrast.toFixed(2)),
            visible: text.visible,
            fontFamily: text.fontFamily,
            fontWeight: text.fontWeight,
          };
        }
        assert.ok(Number.parseFloat(style.texts.boldText.fontWeight) >= 600, `${colorScheme} emphasized quote must remain bold`);
        assert.ok(style.texts.inlineCode.fontFamily.toLowerCase().includes("monospace"), `${colorScheme} quote probe must retain its inline code style`);

        const screenshot = `mobile-blockquote-${colorScheme}.png`;
        await quoteBox.screenshot({ path: context.pathInArtifacts(screenshot), timeout: 10_000 });
        const observation = {
          colorScheme,
          preferenceAtStart: preferenceAtStart.preference,
          quoteElement: style.quoteElement,
          quoteBounds: style.quoteBounds,
          quoteBackground: style.quoteBackground,
          minimumRequired: 4.5,
          text: textObservations,
          screenshot: `artifacts/${screenshot}`,
        };
        observations.push(observation);
        await context.writeArtifactJson(`blockquote-${colorScheme}-observation.json`, observation);
      } finally {
        await quoteBox.dispose();
      }
    }

    const manifestAfter = await readFile(resolve(webRoot.path, "kcoder-mobile-web.json"));
    assert.equal(sha256(manifestAfter), webRoot.manifestSha256, "reused static Webroot manifest must remain unchanged");
    assert.deepEqual(diagnostics, [], "Mobile Web page must not emit JavaScript errors");
    const ownedAppServerProcesses = await findOwnedExecutableProcesses({
      pgid: gateway.child.pid,
      executablePath: ownedBinaryBefore.path,
    });
    const [configuredBinaryAfter, ownedBinaryAfter] = await Promise.all([
      hashExecutableFile(configuredBinary),
      hashExecutableFile(ownedBinary),
    ]);
    assert.equal(configuredBinaryAfter.sha256, configuredBinaryBefore.sha256);
    assert.equal(ownedBinaryAfter.sha256, ownedBinaryBefore.sha256);
    assert.ok(
      ownedAppServerProcesses.some((process) => process.sha256 === ownedBinaryBefore.sha256),
      "the isolated Gateway process group must own the configured KCoder app-server executable",
    );

    await context.writeArtifactJson("mobile-blockquote-theme-result.json", {
      modelBoundary: "deterministic mixed-tools scenario through the owned real app-server; no Provider or model request",
      scenario: "mixed-tools",
      providerRequest: false,
      workspaceFixtures: ["src/sample.txt", "src/sample.py"],
      turnStart: {
        route: turn.route,
        promptHasProbe: turn.request.promptHasProbe,
        promptSha256: turn.request.promptSha256,
        responseOk: turn.response.ok,
        resultReceived: turn.response.resultReceived,
        errorCode: turn.response.errorCode,
      },
      webRoot: {
        manifestSha256: webRoot.manifestSha256,
        manifestVersion: 1,
        verifiedFileCount: webRoot.fileCount,
        bundleSha256: webRoot.bundleSha256,
      },
      httpReadiness,
      binary: {
        sourceBinding: "UNVERIFIED",
        ownedPathRelativeToRun: "state/bin/kcoder",
        sha256: ownedBinaryBefore.sha256,
        processGroupId: gateway.child.pid,
        matchingOwnedProcessCount: ownedAppServerProcesses.length,
      },
      observations,
      diagnostics,
    });
    return { observations, turnStartOk: true, providerRequest: false };
  },
);

async function verifyMobileWebRoot(rootInput) {
  const root = resolve(rootInput);
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), "Mobile Web root must be a real directory");
  assert.equal(await realpath(root), root, "Mobile Web root path must be canonical");
  const manifestBytes = await readFile(resolve(root, "kcoder-mobile-web.json"));
  const manifestSha256 = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.baseToken, "/__kcoder_mobile_mount_v1__");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  assert.ok(manifest.files.some((file) => file.path === "index.html"));
  assert.ok(manifest.files.some((file) => file.replacements > 0));
  const paths = new Set();
  const resources = new Map();
  let totalBytes = 0;
  for (const file of manifest.files) {
    assert.ok(safeManifestPath(file.path), `invalid Mobile Web manifest path: ${file.path}`);
    assert.ok(!paths.has(file.path), `duplicate Mobile Web manifest path: ${file.path}`);
    paths.add(file.path);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 32 * 1024 * 1024);
    const filePath = resolve(root, file.path);
    assert.ok(filePath.startsWith(`${root}${sep}`));
    let directory = root;
    for (const part of file.path.split("/")) {
      directory = resolve(directory, part);
      const info = await lstat(directory);
      assert.ok(!info.isSymbolicLink(), `Mobile Web manifest resource is a symlink: ${file.path}`);
    }
    const info = await lstat(filePath);
    assert.ok(info.isFile() && info.size === file.size, `Mobile Web resource size mismatch: ${file.path}`);
    const bytes = await readFile(filePath);
    assert.equal(sha256(bytes), file.sha256, `Mobile Web resource hash mismatch: ${file.path}`);
    resources.set(file.path, { manifest: file, bytes });
    totalBytes += file.size;
  }
  assert.ok(totalBytes <= 256 * 1024 * 1024, "Mobile Web manifest exceeds the documented resource limit");
  const actualPaths = await listFiles(root);
  const expectedPaths = [...paths, "kcoder-mobile-web.json"].sort();
  assert.deepEqual(actualPaths, expectedPaths, "Mobile Web root must contain exactly its manifest-listed resources");
  const index = resources.get("index.html");
  const entryPath = findMobileEntryJsPath(index.bytes.toString("utf8"), manifest.baseToken);
  const entry = resources.get(entryPath);
  assert.ok(entry, `Mobile Web entry JavaScript must be included in the verified manifest: ${entryPath}`);
  assert.ok(entryPath.endsWith(".js"), `Mobile Web entry resource must be JavaScript: ${entryPath}`);
  return {
    path: root,
    manifestSha256,
    fileCount: manifest.files.length,
    bundleSha256: manifest.bundleSha256 ?? null,
    mountPath: "/mobile",
    resources: {
      index: expectedMountedResource(index, manifest.baseToken, "/mobile"),
      entry: {
        path: entryPath,
        ...expectedMountedResource(entry, manifest.baseToken, "/mobile"),
      },
    },
  };
}

function findMobileEntryJsPath(indexHtml, baseToken) {
  const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>/gi)].map(([, attributes]) => {
    const values = Object.fromEntries(
      [...attributes.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
        .map(([, name, doubleQuoted, singleQuoted, bare]) => [
          name.toLowerCase(), doubleQuoted ?? singleQuoted ?? bare ?? "",
        ]),
    );
    return values;
  }).filter((attributes) => typeof attributes.src === "string" && /\.m?js(?:[?#]|$)/i.test(attributes.src));
  const script = scripts.find((attributes) => attributes.type?.toLowerCase() === "module") ?? scripts[0];
  assert.ok(script, "Mobile Web index must declare an entry JavaScript file");
  const mountedSource = script.src.replaceAll(baseToken, "/mobile");
  const mountedUrl = new URL(mountedSource, "http://mobile-entry.invalid/mobile/");
  assert.equal(mountedUrl.origin, "http://mobile-entry.invalid", "Mobile Web entry must use the current Gateway origin");
  assert.ok(mountedUrl.pathname.startsWith("/mobile/"), "Mobile Web entry must use the actual Gateway mount path");
  assert.equal(mountedUrl.search, "", "Mobile Web entry must not depend on query credentials or cache tokens");
  assert.equal(mountedUrl.hash, "", "Mobile Web entry must not use a fragment");
  return decodeURIComponent(mountedUrl.pathname.slice("/mobile/".length));
}

function expectedMountedResource(resource, baseToken, mountPath) {
  const { manifest, bytes } = resource;
  let mountedBytes = bytes;
  if (manifest.text) {
    const text = bytes.toString("utf8");
    assert.ok(Buffer.from(text).equals(bytes), `Mobile Web text resource must be valid UTF-8: ${manifest.path}`);
    assert.equal(text.split(baseToken).length - 1, manifest.replacements);
    mountedBytes = Buffer.from(text.replaceAll(baseToken, mountPath));
  } else {
    assert.ok(!bytes.includes(Buffer.from(baseToken)), `Mobile Web binary must not contain the mount token: ${manifest.path}`);
  }
  return {
    sourceSha256: manifest.sha256,
    sourceSize: manifest.size,
    mountedSha256: sha256(mountedBytes),
    mountedSize: mountedBytes.length,
  };
}

async function verifyMountedMobileHttp(context, gateway, webRoot) {
  const startedAt = Date.now();
  const deadline = startedAt + 30_000;
  const resources = [
    {
      name: "index",
      path: "/mobile/",
      expectedSha256: webRoot.resources.index.mountedSha256,
      expectedSize: webRoot.resources.index.mountedSize,
    },
    {
      name: "entry",
      path: `/mobile/${webRoot.resources.entry.path.split("/").map(encodeURIComponent).join("/")}`,
      expectedSha256: webRoot.resources.entry.mountedSha256,
      expectedSize: webRoot.resources.entry.mountedSize,
    },
  ];
  const attempts = [];
  let readiness = null;
  while (Date.now() < deadline && !context.abortSignal.aborted && attempts.length < 60) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const timeoutMs = Math.min(3_000, remainingMs);
    const signal = AbortSignal.any([
      context.abortSignal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const attempt = {
      number: attempts.length + 1,
      startedAt: new Date().toISOString(),
      resources: await Promise.all(resources.map((resource) => fetchMountedResource(
        gateway.baseUrl,
        resource,
        signal,
      ))),
    };
    attempt.durationMs = Date.now() - Date.parse(attempt.startedAt);
    attempt.ready = attempt.resources.every((resource) =>
      resource.status === 200 && resource.digestMatches && resource.sizeMatches,
    );
    attempts.push(attempt);
    if (attempt.ready) {
      readiness = {
        ready: true,
        verifiedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        mountPath: "/mobile/",
        resources: attempt.resources,
      };
      break;
    }
    if (Date.now() < deadline && !context.abortSignal.aborted) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const evidence = {
    gatewayOrigin: new URL(gateway.baseUrl).origin,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    timeoutMs: 30_000,
    ready: Boolean(readiness),
    readiness,
    attempts,
  };
  await context.writeArtifactJson("mobile-blockquote-http-readiness.json", evidence);
  assert.ok(
    readiness,
    `owned Gateway Mobile Web HTTP readiness failed within 30 seconds; last attempt: ${JSON.stringify(attempts.at(-1) ?? null)}`,
  );
  return evidence;
}

async function fetchMountedResource(baseUrl, resource, signal) {
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(resource.path, baseUrl), {
      redirect: "manual",
      cache: "no-store",
      signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    return {
      name: resource.name,
      path: resource.path,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      size: bytes.length,
      sha256: digest,
      expectedSha256: resource.expectedSha256,
      digestMatches: digest === resource.expectedSha256,
      expectedSize: resource.expectedSize,
      sizeMatches: bytes.length === resource.expectedSize,
    };
  } catch (error) {
    return {
      name: resource.name,
      path: resource.path,
      status: null,
      elapsedMs: Date.now() - startedAt,
      errorName: error?.name ?? "Error",
      errorCode: error?.cause?.code ?? error?.code ?? null,
    };
  }
}

function createNavigationTimeline(page, baseUrl, browser) {
  const origin = new URL(baseUrl).origin;
  const maximumEvents = 256;
  const events = [];
  let droppedEventCount = 0;
  let startedAtMs = null;
  let startedAt = null;
  let finishedAt = null;
  let durationMs = null;
  let outcome = "not-started";
  let failure = null;

  const record = (type, detail = {}) => {
    if (events.length >= maximumEvents) {
      droppedEventCount += 1;
      return;
    }
    const timestamp = Date.now();
    events.push({
      type,
      at: new Date(timestamp).toISOString(),
      elapsedMs: startedAtMs === null ? null : timestamp - startedAtMs,
      ...detail,
    });
  };
  const requestDetails = (request) => {
    const path = safeSameOriginPath(request.url(), origin);
    if (!path) return null;
    return { path, method: request.method(), resourceType: request.resourceType() };
  };

  page.on("request", (request) => {
    const detail = requestDetails(request);
    if (detail) record("request", detail);
  });
  page.on("response", (response) => {
    const detail = requestDetails(response.request());
    if (detail) record("response", { ...detail, status: response.status() });
  });
  page.on("requestfailed", (request) => {
    const detail = requestDetails(request);
    if (detail) record("requestfailed", {
      ...detail,
      error: String(request.failure()?.errorText ?? "unknown").replace(/https?:\/\/\S+/g, "[url]").slice(0, 160),
    });
  });
  page.on("domcontentloaded", () => record("domcontentloaded"));
  page.on("crash", () => record("page-crash"));
  browser.on("disconnected", () => record("browser-disconnected"));

  return {
    begin(url) {
      startedAtMs = Date.now();
      startedAt = new Date(startedAtMs).toISOString();
      outcome = "running";
      record("navigation-start", { path: safeSameOriginPath(url, origin) });
    },
    finish(result, error = null) {
      const timestamp = Date.now();
      finishedAt = new Date(timestamp).toISOString();
      durationMs = startedAtMs === null ? null : timestamp - startedAtMs;
      outcome = result;
      if (error) {
        failure = {
          name: error?.name ?? "Error",
          message: String(error?.message ?? error).replace(/https?:\/\/\S+/g, "[url]").slice(0, 240),
        };
      }
      record("navigation-finish", { outcome, ...(failure ? { failure } : {}) });
    },
    snapshot() {
      return { startedAt, finishedAt, durationMs, outcome, failure, maximumEvents, droppedEventCount, events };
    },
  };
}

function safeSameOriginPath(rawUrl, origin) {
  try {
    const url = new URL(rawUrl);
    return url.origin === origin ? url.pathname.slice(0, 512) : null;
  } catch {
    return null;
  }
}

async function findQuoteBox(quoteText, expectedText) {
  await quoteText.waitFor({ state: "visible", timeout: 10_000 });
  const handle = await quoteText.evaluateHandle((element, expected) => {
    let current = element;
    while (current instanceof HTMLElement && current !== document.body) {
      const text = current.innerText.replace(/\s+/g, " ").trim();
      if (
        Number.parseFloat(getComputedStyle(current).borderLeftWidth) > 0 &&
        text === expected
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }, expectedText);
  const box = handle.asElement();
  assert.ok(box, "rendered quote must resolve to the exact Markdown container with a left border");
  return box;
}

async function listFiles(root, relativeRoot = "") {
  const output = [];
  for (const entry of await readdir(resolve(root, relativeRoot), { withFileTypes: true })) {
    const child = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`unexpected Mobile Web symlink: ${child}`);
    if (entry.isDirectory()) output.push(...await listFiles(root, child));
    else if (entry.isFile()) output.push(child);
    else throw new Error(`unexpected Mobile Web filesystem entry: ${child}`);
  }
  return output.sort();
}

function safeManifestPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 1024 &&
    !path.startsWith("/") && !/[\\\x00-\x20\x7f%?#]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".." &&
      (!part.startsWith(".") || path === "_expo/.routes.json"));
}

function captureTurnStart(page, gatewayWebSocketPrefix) {
  const evidence = { turnStarts: [] };
  page.on("websocket", (socket) => {
    let route;
    try {
      const socketUrl = new URL(socket.url());
      const gatewayUrl = new URL(gatewayWebSocketPrefix);
      route = {
        server: socketUrl.searchParams.get("server"),
        channel: socketUrl.searchParams.get("channel"),
      };
      if (socketUrl.origin !== gatewayUrl.origin || socketUrl.pathname !== "/rpc" ||
          route.server !== "local" || route.channel !== "runtime") return;
    } catch {
      return;
    }
    const pending = new Map();
    socket.on("framesent", ({ payload }) => {
      for (const frame of parseJsonMessages(payload)) {
        if (frame?.method !== "turn/start" || frame.id === undefined) continue;
        const text = Array.isArray(frame.params?.input)
          ? frame.params.input.filter((item) => item?.type === "text").map((item) => item.text ?? "").join("\n")
          : "";
        const record = {
          route,
          request: {
            promptHasProbe: text.includes(`${quoteMarker} **visible quote**`),
            promptSha256: sha256(text),
          },
          response: null,
        };
        evidence.turnStarts.push(record);
        pending.set(String(frame.id), record);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      for (const frame of parseJsonMessages(payload)) {
        if (frame?.id === undefined || (!Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"))) continue;
        const record = pending.get(String(frame.id));
        if (!record) continue;
        pending.delete(String(frame.id));
        record.response = {
          ok: !frame.error,
          resultReceived: Object.hasOwn(frame, "result"),
          errorCode: frame.error?.code ?? null,
        };
      }
    });
  });
  return evidence;
}

function parseJsonMessages(payload) {
  try {
    const decoded = JSON.parse(typeof payload === "string" ? payload : String(payload ?? ""));
    return Array.isArray(decoded) ? decoded : [decoded];
  } catch {
    return [];
  }
}

function contrastRatio(foreground, background, opacity = 1) {
  const foregroundRgba = parseColor(foreground);
  const backgroundRgba = Array.isArray(background) ? background : parseColor(background);
  foregroundRgba[3] *= opacity;
  const opaqueBackground = composite(backgroundRgba, [255, 255, 255, 1]);
  const effectiveForeground = composite(foregroundRgba, opaqueBackground);
  const luminance = (rgba) => {
    const [r, g, b] = rgba.map((channel) => {
      const srgb = channel / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const left = luminance(effectiveForeground);
  const right = luminance(opaqueBackground);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function effectiveBackground(backgroundLayers) {
  return backgroundLayers.reduce(
    (background, layer) => composite(parseColor(layer), background),
    [255, 255, 255, 1],
  );
}

function parseColor(value) {
  const match = String(value).match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  assert.ok(match, `unsupported computed browser color: ${value}`);
  const alpha = match[4] === undefined ? 1 : match[4].endsWith("%")
    ? Number(match[4].slice(0, -1)) / 100
    : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

function composite(foreground, background) {
  const foregroundAlpha = foreground[3];
  const backgroundAlpha = background[3] ?? 1;
  const alpha = foregroundAlpha + backgroundAlpha * (1 - foregroundAlpha);
  if (alpha <= 0) return [0, 0, 0, 0];
  return [
    ...[0, 1, 2].map((index) =>
      (foreground[index] * foregroundAlpha + background[index] * backgroundAlpha * (1 - foregroundAlpha)) / alpha,
    ),
    alpha,
  ];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
