import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";
import { startChromium } from "../harness/chromium.mjs";

const mobileRoot = resolve(repoRoot, "apps/kcoder-studio/mobile");
const themePath = "apps/kcoder-studio/mobile/src/theme.ts";
const terminalThemePath = "apps/kcoder-studio/mobile/src/components/terminal-theme.ts";
const baselineCommit = "e02c4f9f293c216f32fc4383194657e3e3d63890";
const ansiKeys = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
  "brightMagenta", "brightCyan", "brightWhite",
];
const contrastKeys = ["yellow", "brightBlack", "brightRed"];
const screenshotCases = new Set([
  "390:en:light",
  "320:zh-CN:light",
  "390:zh-CN:dark",
  "320:en:dark",
]);
const { build, stop } = createRequire(resolve(mobileRoot, "package.json"))("esbuild");

function readBaselineFile(path) {
  return execFileSync("git", ["show", `${baselineCommit}:${path}`], { cwd: repoRoot, encoding: "utf8" });
}

function colorFromPalette(source, palette, token) {
  const start = source.indexOf(`export const ${palette}: ThemeColors = {`);
  assert.notEqual(start, -1, `baseline source must contain ${palette}`);
  const end = source.indexOf("};", start);
  assert.notEqual(end, -1, `baseline source must close ${palette}`);
  const block = source.slice(start, end);
  const match = block.match(new RegExp(`\\b${token}:\\s*[\"']([^\"']+)[\"']`));
  assert.ok(match, `baseline ${palette} must contain ${token}`);
  return match[1];
}

function relativeLuminance(color) {
  const channels = color.match(/[\da-f]{2}/gi)?.map(value => parseInt(value, 16) / 255);
  assert.ok(channels?.length === 3, `expected a hex color, got ${color}`);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const baselineThemeSource = readBaselineFile(themePath);
const baselineTerminalThemeSource = readBaselineFile(terminalThemePath);
const baselineYellow = colorFromPalette(baselineThemeSource, "lightColors", "yellow");

const fixtureSource = `
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { lightColors, darkColors } from "./src/theme";
import { createTerminalTheme as createCurrentTheme } from "./src/components/terminal-theme";
import { createTerminalTheme as createHeadTheme } from ${JSON.stringify("__OLD_TERMINAL_THEME_PATH__")};

const BASELINE_YELLOW = ${JSON.stringify(baselineYellow)};
const oldLightColors = { ...lightColors, yellow: BASELINE_YELLOW };
const terminals = { before: null, after: null };
const codes = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];

function ansiLine(start, end) {
  return codes.slice(start, end).map(code => "\\x1b[" + code + "m" + code + "\\x1b[0m").join(" ");
}

function terminalOutput() {
  return "\\x1b[0m" + ansiLine(0, 8) + "\\r\\n" + ansiLine(8, 16) + "\\r\\n\\x1b[0m";
}

function nextFrames() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function makeTerminal(host, theme) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: false,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.15,
    scrollback: 0,
    theme,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  fit.fit();
  return { terminal, fit };
}

window.renderTerminalPalette = async ({ mode, locale, width }) => {
  for (const current of Object.values(terminals)) current?.terminal.dispose();
  document.documentElement.lang = locale;
  document.body.dataset.mode = mode;
  document.body.dataset.locale = locale;
  const strings = locale === "zh-CN"
    ? { title: "Mobile 终端配色", before: "修复前（基线）", after: "修复后（当前源码）", mode: mode === "light" ? "浅色" : "深色" }
    : { title: "Mobile terminal palette", before: "Before (baseline)", after: "After (current source)", mode: mode === "light" ? "Light" : "Dark" };
  document.body.innerHTML = "<main><header><strong>" + strings.title + "</strong><span>" + strings.mode + " · " + width + "px</span></header><section><h2>" + strings.before + "</h2><div id='terminal-before' class='terminal-host'></div></section><section><h2>" + strings.after + "</h2><div id='terminal-after' class='terminal-host'></div></section><footer>ANSI 30–37 · 90–97</footer></main>";
  const colors = mode === "light" ? lightColors : darkColors;
  const oldColors = mode === "light" ? oldLightColors : darkColors;
  const beforeTheme = createHeadTheme(mode, oldColors);
  const afterTheme = createCurrentTheme(mode, colors);
  document.body.style.background = colors.background;
  document.body.style.color = colors.text;
  document.querySelector("main").style.setProperty("--surface", colors.surface);
  const before = makeTerminal(document.querySelector("#terminal-before"), beforeTheme);
  const after = makeTerminal(document.querySelector("#terminal-after"), afterTheme);
  terminals.before = before;
  terminals.after = after;
  const output = terminalOutput();
  await Promise.all([
    new Promise(resolve => before.terminal.write(output, resolve)),
    new Promise(resolve => after.terminal.write(output, resolve)),
  ]);
  before.fit.fit();
  after.fit.fit();
  await nextFrames();
  return {
    mode,
    locale,
    width,
    before: before.terminal.options.theme,
    after: after.terminal.options.theme,
    rows: after.terminal.rows,
    columns: after.terminal.cols,
    ansiCodes: codes,
    terminalCount: document.querySelectorAll(".xterm").length,
    scrollWidth: document.documentElement.scrollWidth,
  };
};

document.head.insertAdjacentHTML("beforeend", \`<style>
  * { box-sizing: border-box; }
  html, body { width: 100%; min-height: 100%; margin: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; }
  main { width: 100%; padding: 10px; }
  header { display: flex; flex-direction: column; gap: 3px; padding: 0 2px 8px; font-size: 13px; }
  header span, footer { color: #64748b; font-size: 11px; }
  section { margin: 0 0 8px; padding: 8px; border: 1px solid rgba(100, 116, 139, .25); border-radius: 10px; background: var(--surface); }
  h2 { margin: 0 0 5px; font-size: 11px; font-weight: 600; }
  .terminal-host { width: 100%; height: 94px; overflow: hidden; border-radius: 4px; }
  .xterm { height: 100%; }
  footer { padding: 0 2px; }
</style>\`);
`;

let completedRunRoot;
await runE2E(import.meta.url, {
  testId: "mobile-terminal-palette-contrast",
  tier: "manual-live",
  modelPolicy: `model-independent actual xterm ANSI rendering with baseline ${baselineCommit} and current Mobile terminal themes; no Gateway, provider, user data or native host`,
}, async context => {
  completedRunRoot = context.runRoot;
  context.addCleanup("stop owned terminal palette compiler", () => stop());

  const stagedOldTheme = context.pathInState("terminal-theme-head.ts");
  await writeFile(stagedOldTheme, baselineTerminalThemeSource, { flag: "wx", mode: 0o600 });
  const source = fixtureSource.replace("__OLD_TERMINAL_THEME_PATH__", stagedOldTheme);
  const bundle = await build({
    absWorkingDir: mobileRoot,
    outdir: context.pathInState("bundle"),
    stdin: { contents: source, resolveDir: mobileRoot, sourcefile: "terminal-palette-fixture.ts", loader: "ts" },
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    write: false,
    metafile: true,
    tsconfig: resolve(mobileRoot, "tsconfig.json"),
    plugins: [{
      name: "mobile-appearance-stub",
      setup(builder) {
        builder.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "mobile-appearance-stub" }));
        builder.onLoad({ filter: /.*/, namespace: "mobile-appearance-stub" }, () => ({
          contents: 'export const Appearance = { getColorScheme: () => "light", addChangeListener: () => ({ remove() {} }) };',
          loader: "js",
        }));
      },
    }],
  });
  stop();
  const javascript = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
  const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
  assert.ok(javascript, "esbuild must produce the real xterm browser bundle");
  assert.ok(stylesheet, "esbuild must include the official xterm stylesheet");

  const chromium = await startChromium(context, {
    label: "mobile-terminal-palette-chromium",
    executablePath: "/usr/bin/chromium",
    noSandbox: true,
  });
  const page = await chromium.newPage({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"></head><body></body></html>`);
  await page.addStyleTag({ content: stylesheet });
  await page.addScriptTag({ content: javascript });

  const results = [];
  const screenshotByCase = new Map();
  for (const width of [320, 390]) {
    for (const locale of ["en", "zh-CN"]) {
      for (const mode of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 700 });
        const rendered = await page.evaluate(async options => window.renderTerminalPalette(options), { mode, locale, width });
        assert.equal(rendered.terminalCount, 2, "each comparison must mount two real xterm instances");
        assert.equal(rendered.scrollWidth, width, "terminal comparison must not overflow the Mobile viewport");
        assert.deepEqual(rendered.ansiCodes, [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97]);

        const changedKeys = ansiKeys.filter(color => rendered.before[color] !== rendered.after[color]).sort();
        assert.deepEqual(changedKeys, mode === "light" ? ["brightBlack", "brightRed", "yellow"] : [], `${mode} changed ANSI foregrounds must match the scoped fix`);
        const contrast = Object.fromEntries(contrastKeys.map(color => [color, {
          before: Number(contrastRatio(rendered.before[color], rendered.before.background).toFixed(4)),
          after: Number(contrastRatio(rendered.after[color], rendered.after.background).toFixed(4)),
        }]));
        const lightAnsiContrast = mode === "light"
          ? Object.fromEntries(ansiKeys.map(color => [color, Number(contrastRatio(rendered.after[color], rendered.after.background).toFixed(4))]))
          : null;
        if (mode === "light") {
          for (const color of ansiKeys) {
            assert.ok(lightAnsiContrast[color] >= 4.5, `${color} must reach 4.5:1 on the current light terminal surface`);
          }
          assert.equal(rendered.before.yellow, "#A16207");
          assert.equal(rendered.after.yellow, "#9A5E07");
          assert.equal(rendered.before.brightBlack, "#64748B");
          assert.equal(rendered.after.brightBlack, "#5F6F85");
          assert.equal(rendered.before.brightRed, "#DC2626");
          assert.equal(rendered.after.brightRed, "#D42525");
        }

        const screenshotKey = `${width}:${locale}:${mode}`;
        if (screenshotCases.has(screenshotKey)) {
          const fileName = `terminal-${width}-${locale}-${mode}.png`;
          const artifactPath = context.pathInArtifacts(fileName);
          await page.screenshot({ path: artifactPath, fullPage: true, animations: "disabled" });
          screenshotByCase.set(screenshotKey, { fileName, artifactPath });
        }
        results.push({
          width,
          locale,
          mode,
          terminalRows: rendered.rows,
          terminalColumns: rendered.columns,
          ansiForegroundsChanged: changedKeys,
          contrast,
          lightAnsiContrast,
        });
      }
    }
  }

  assert.equal(results.length, 8, "matrix must cover both widths, locales and themes");
  assert.equal(screenshotByCase.size, screenshotCases.size);
  const currentThemeSource = await readFile(resolve(repoRoot, terminalThemePath), "utf8");
  const currentPaletteSource = await readFile(resolve(repoRoot, themePath), "utf8");
  await context.writeArtifactJson("terminal-palette-contrast.json", {
    source: {
      gitHead: context.gitCommit,
      baselineCommit,
      oldTerminalTheme: `${baselineCommit}:${terminalThemePath}`,
      baselineLightYellow: baselineYellow,
      currentTerminalTheme: terminalThemePath,
      currentThemePalette: themePath,
      currentTerminalThemeSha256: (await import("node:crypto")).createHash("sha256").update(currentThemeSource).digest("hex"),
      currentThemePaletteSha256: (await import("node:crypto")).createHash("sha256").update(currentPaletteSource).digest("hex"),
      baselineTerminalThemeSha256: (await import("node:crypto")).createHash("sha256").update(baselineTerminalThemeSource).digest("hex"),
    },
    browser: { executablePath: chromium.executablePath, headless: chromium.headless, noSandbox: chromium.noSandbox },
    matrix: results,
    screenshots: [...screenshotByCase.values()].map(({ fileName }) => fileName),
    boundary: "Isolated Mobile-width Chromium fixture using actual xterm, actual current palette and createTerminalTheme, and the pinned baseline createTerminalTheme source. It does not load the actual Mobile app or prove native-device behavior. No Gateway, Rust, provider, personal profile or shared port.",
  });
  return { scenarios: results.length, screenshotCount: screenshotByCase.size, modelRequests: 0, terminalInstancesPerScenario: 2 };
});

assert.ok(completedRunRoot, "RunContext must expose the private run root");
const manifest = JSON.parse(await readFile(join(completedRunRoot, "manifest.json"), "utf8"));
assert.equal(manifest.status, "passed", "RunContext must record a passing isolated browser run");
await assert.rejects(readFile(join(completedRunRoot, "state")), error => error?.code === "ENOENT", "RunContext private state must be removed");
assert.ok(manifest.cleanupSteps.every(step => step.status === "completed"), "RunContext cleanup must finish every owned resource");
console.log(JSON.stringify({ privateStateCleaned: true, cleanupSteps: manifest.cleanupSteps.length, screenshots: [...screenshotCases] }));
