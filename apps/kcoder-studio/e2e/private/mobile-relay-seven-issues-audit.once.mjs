import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { startChromium } from "../harness/chromium.mjs";
import { runE2E } from "../harness/run-context.mjs";

process.umask(0o077);

const ORIGIN = "https://49.234.36.54:8451";
const MOUNT = "/g/hmr-preview-20261014/mobile";
const ROUTES = [
  { id: "home", path: `${MOUNT}/`, slug: "01-home" },
  { id: "unknown-profile", path: `${MOUNT}/h/__relay_audit_missing_profile__`, slug: "02-unknown-profile" },
  { id: "sessions-no-profile", path: `${MOUNT}/sessions`, slug: "03-sessions-no-profile", observeMs: 30_000 },
  { id: "models-no-profile", path: `${MOUNT}/settings-section?section=models_services`, slug: "04-models-no-profile", observeMs: 30_000 },
  { id: "welcome", path: `${MOUNT}/welcome`, slug: "05-welcome" },
  { id: "unmatched-route", path: `${MOUNT}/__relay_audit_unmatched_route__`, slug: "07-unmatched-route" },
];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function errorCategory(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(error.code) ? error.code : null;
  return { name, code };
}

async function readUi(page) {
  return page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
    const bodyText = clean(document.body?.innerText).slice(0, 520);
    const headings = [...document.querySelectorAll("h1,h2,h3,[role=heading]")]
      .filter(visible).map(element => clean(element.innerText || element.getAttribute("aria-label"))).filter(Boolean).slice(0, 10);
    const buttons = [...document.querySelectorAll("button,[role=button]")]
      .filter(visible).map(element => ({
        name: clean(element.getAttribute("aria-label") || element.innerText || element.textContent).slice(0, 80),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      })).filter(button => button.name).slice(0, 16);
    const progressIndicators = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].filter(visible).length;
    const normalizedText = bodyText.toLowerCase();
    const loadingOnly = /^(loading|refreshing|please wait|加载中|正在刷新|刷新中)[.!… ]*$/i.test(bodyText);
    const rendered = Boolean(bodyText || headings.length || buttons.length) && !loadingOnly;
    const query = new URLSearchParams(location.search);
    const safeSection = query.get("section");
    const safeUrl = `${location.origin}${location.pathname}${safeSection ? `?section=${encodeURIComponent(safeSection)}` : ""}`;
    return {
      currentUrl: safeUrl,
      title: document.title || "",
      renderState: rendered ? "rendered-ui" : (progressIndicators || bodyText ? "loading-or-empty-ui" : "blank"),
      headings,
      buttons,
      progressIndicators,
      bodyText,
      bodyTextLength: bodyText.length,
      unmatchedRoute: /unmatched route/i.test(normalizedText),
    };
  });
}

async function waitForStableUi(page, maxMs) {
  const deadline = Date.now() + maxMs;
  let previous = null;
  let stableSince = null;
  let last = await readUi(page).catch(() => null);
  while (Date.now() < deadline) {
    last = await readUi(page).catch(() => last);
    if (last?.renderState === "rendered-ui") {
      const signature = JSON.stringify([last.title, last.headings, last.buttons.map(button => button.name), last.bodyText.slice(0, 180)]);
      if (signature === previous) {
        if (stableSince !== null && Date.now() - stableSince >= 700) return { stable: true, ui: last };
      } else {
        previous = signature;
        stableSince = Date.now();
      }
    } else {
      previous = null;
      stableSince = null;
    }
    await wait(200);
  }
  return { stable: false, ui: last };
}

await runE2E(import.meta.url, {
  testId: "mobile-relay-seven-issues-audit",
  modelPolicy: "read-only unauthenticated audit of the specified public Relay Mobile Web mount",
  processSignalTimeoutMs: 5_000,
  cleanupTimeoutMs: 7_500,
  survivorCheckTimeoutMs: 5_000,
}, async context => {
  const evidence = {
    testId: "mobile-relay-seven-issues-audit",
    startedAt: new Date().toISOString(),
    publicOrigin: ORIGIN,
    mountPrefix: MOUNT,
    browser: null,
    routes: [],
    safety: {
      freshChromiumProfile: true,
      credentialsEntered: false,
      pairingSubmitted: false,
      gatewaySessionPostCount: 0,
    },
    welcomeManualForm: null,
  };
  const browser = await startChromium(context, {
    label: "mobile-relay-seven-issues-audit-chromium",
    startTimeoutMs: 12_000,
    connectTimeoutMs: 8_000,
    pageTimeoutMs: 10_000,
    closeTimeoutMs: 5_000,
    windowSize: { width: 430, height: 900 },
  });
  const process = context.processes.get("mobile-relay-seven-issues-audit-chromium");
  evidence.browser = {
    pid: process?.pid ?? null,
    executablePath: browser.executablePath,
    version: browser.browser.version(),
    cdpPort: browser.cdpPort,
    profileDir: browser.profileDir,
    noSandbox: browser.noSandbox,
    headless: browser.headless,
  };

  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  page.on("request", request => {
    if (request.method().toUpperCase() !== "POST") return;
    let pathname = "<unparsed>";
    try { pathname = new URL(request.url()).pathname; } catch { /* Do not retain raw URLs. */ }
    if (pathname.endsWith("/api/mobile/session")) evidence.safety.gatewaySessionPostCount += 1;
  });

  for (const route of ROUTES) {
    const startedAt = Date.now();
    const row = { id: route.id, requestedUrl: `${ORIGIN}${route.path}`, navigationStatus: null, navigationError: null, stableUi: false, samples: [], screenshot: null };
    try {
      const response = await page.goto(row.requestedUrl, { waitUntil: "domcontentloaded", timeout: 7_000 });
      row.navigationStatus = response?.status() ?? null;
    } catch (error) {
      row.navigationError = errorCategory(error);
    }

    const settled = await waitForStableUi(page, 3_000);
    row.stableUi = settled.stable;
    if (settled.ui) row.samples.push({ elapsedMs: Date.now() - startedAt, ...settled.ui });

    if (route.observeMs) {
      for (const offsetMs of [5_000, 15_000, route.observeMs]) {
        const remaining = offsetMs - (Date.now() - startedAt);
        if (remaining > 0) await wait(remaining);
        const ui = await readUi(page).catch(() => null);
        if (ui) row.samples.push({ elapsedMs: Date.now() - startedAt, ...ui });
      }
    }

    try {
      const screenshot = context.pathInCase("mobile-relay-audit", route.slug, "page.png");
      await mkdir(dirname(screenshot), { recursive: true });
      await page.screenshot({ path: screenshot, timeout: 3_000 });
      row.screenshot = screenshot;
    } catch (error) {
      row.screenshotError = errorCategory(error);
    }
    row.finishedAt = new Date().toISOString();
    evidence.routes.push(row);

    if (route.id === "welcome") {
      const manual = { opened: false, endpointFieldVisible: false, tokenFieldVisible: false, submitted: false, sample: null, screenshot: null };
      try {
        await page.getByTestId("welcome-direct-connection").click({ timeout: 5_000 });
        manual.opened = true;
        await waitForStableUi(page, 2_000);
        const [endpointVisible, tokenVisible, ui] = await Promise.all([
          page.getByTestId("gateway-endpoint").isVisible().catch(() => false),
          page.getByTestId("gateway-token").isVisible().catch(() => false),
          readUi(page).catch(() => null),
        ]);
        manual.endpointFieldVisible = endpointVisible;
        manual.tokenFieldVisible = tokenVisible;
        manual.sample = ui;
        const screenshot = context.pathInCase("mobile-relay-audit", "06-welcome-manual-form", "page.png");
        await mkdir(dirname(screenshot), { recursive: true });
        await page.screenshot({ path: screenshot, timeout: 3_000 });
        manual.screenshot = screenshot;
      } catch (error) {
        manual.error = errorCategory(error);
      }
      evidence.welcomeManualForm = manual;
    }
  }

  evidence.finishedAt = new Date().toISOString();
  await context.writeArtifactJson("mobile-relay-seven-issues-audit.json", evidence);
  await browser.close();
  return { routeCount: evidence.routes.length, gatewaySessionPostCount: evidence.safety.gatewaySessionPostCount };
});
