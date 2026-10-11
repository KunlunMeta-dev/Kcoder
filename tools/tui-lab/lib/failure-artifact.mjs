import { chmod, writeFile } from 'node:fs/promises';

import { formatBrowserConsole } from './browser-evidence.mjs';

async function writeTextArtifact(file, content) {
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644);
}

async function writeBinaryArtifact(file, content) {
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644);
}

async function writeJsonArtifact(file, value) {
  await writeTextArtifact(file, `${JSON.stringify(value, null, 2)}\n`);
}

function formatError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
  };
}

async function boundedPageOperation(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('failure evidence page operation timed out'), { code: 'ETIMEDOUT' })), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureFailurePageEvidence({
  page,
  timeoutMs = 1000,
}) {
  if (!page) return { text: '', dimensions: null, hasScrollbar: null, inputEvents: [], screenshotCaptured: false };
  try {
    return await boundedPageOperation(
      (async () => {
        const [text, dimensions, hasScrollbar, inputEvents] = await Promise.all([
          page.evaluate(() => window.tuiLab?.text?.() || ''),
          page.evaluate(() => window.tuiLab?.dimensions?.() || null),
          page.evaluate(() => window.tuiLab?.hasScrollbar?.() || false),
          page.evaluate(() => window.tuiLab?.inputEvents?.() || []),
        ]);
        const screenshot = await page.screenshot({ type: 'png' });
        return { text, dimensions, hasScrollbar, inputEvents, screenshot, screenshotCaptured: true };
      })(),
      timeoutMs,
    );
  } catch (error) {
    return { text: '', dimensions: null, hasScrollbar: null, inputEvents: [], screenshotCaptured: false, captureError: formatError(error) };
  }
}

export async function writeFailureArtifact({
  artifacts,
  runOptions,
  command,
  mode,
  session,
  page,
  browserConsole,
  trace,
  error,
  repoRoot,
  now = new Date(),
  pageEvidence,
  pageTimeoutMs = 1000,
}) {
  const captured = pageEvidence || await captureFailurePageEvidence({
    page,
    timeoutMs: pageTimeoutMs,
  });
  const { text = '', dimensions = null, hasScrollbar = null, inputEvents = [] } = captured;
  if (text) {
    await writeTextArtifact(artifacts.text, text);
  }
  if (captured.screenshotCaptured) {
    await writeBinaryArtifact(artifacts.failureScreenshot, captured.screenshot);
  }
  if (session) {
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
  }
  await writeTextArtifact(artifacts.browserConsoleLog, formatBrowserConsole(browserConsole));
  const failure = {
    ok: false,
    mode,
    command,
    cwd: repoRoot,
    runId: artifacts.runId,
    date: artifacts.dateStamp,
    time: artifacts.timeStamp,
    description: artifacts.description,
    runDir: artifacts.dir,
    workspace: artifacts.workspace,
    workspaceTemplate: artifacts.workspaceTemplate,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
    configDir: artifacts.configDir,
    projectKey: artifacts.projectKey,
    projectDir: artifacts.projectDir,
    message: runOptions.message,
    secondMessage: mode === 'two-turn' ? runOptions.secondMessage : undefined,
    scenario: runOptions.scenario,
    text: text ? artifacts.text : undefined,
    ptyLog: session ? artifacts.ptyLog : undefined,
    browserConsoleLog: artifacts.browserConsoleLog,
    failureScreenshot: captured.screenshotCaptured ? artifacts.failureScreenshot : undefined,
    dimensions,
    hasScrollbar,
    inputEvents: inputEvents.map((value) => Buffer.from(value).toString('hex')),
    pageEvidenceError: captured.captureError,
    trace,
    ptyExit: session?.getExitInfo?.() || null,
    ptyDiagnostics: session?.getDiagnostics?.() || [],
    cleanup: error.cleanup,
    cleanupError: error.cleanupError ? formatError(error.cleanupError) : undefined,
    assertions: error.assertions,
    error: formatError(error),
    failedAt: now.toISOString(),
  };
  await writeJsonArtifact(artifacts.failure, failure);
  if (artifacts.meta) {
    await writeJsonArtifact(artifacts.meta, failure);
  }
}
