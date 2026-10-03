import { existsSync } from 'node:fs';

function formatBrowserError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
  };
}

export function attachBrowserConsole(page, entries) {
  page.on('console', (message) => {
    entries.push({
      at: new Date().toISOString(),
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });
  page.on('pageerror', (error) => {
    entries.push({
      at: new Date().toISOString(),
      type: 'pageerror',
      error: formatBrowserError(error),
    });
  });
}

export function formatBrowserConsole(entries) {
  return entries
    .map((entry) => {
      if (entry.error) {
        return `[${entry.at}] ${entry.type}: ${entry.error.message}\n${entry.error.stack}`;
      }
      const location = entry.location?.url
        ? ` ${entry.location.url}:${entry.location.lineNumber}:${entry.location.columnNumber}`
        : '';
      return `[${entry.at}] ${entry.type}${location}: ${entry.text}`;
    })
    .join('\n');
}

export function capturedArtifactPath(file, exists = existsSync) {
  return file && exists(file) ? file : null;
}

export async function captureStep(page, trace, name, file) {
  const entry = {
    name,
    at: new Date().toISOString(),
    file,
    visualEvidenceValid: false,
  };
  trace.push(entry);
  const inspect = () => page.evaluate(() => ({
    ...window.tuiLab.rendererDiagnostics(),
    dimensions: window.tuiLab.dimensions(),
  }));
  const assertHealthy = (state, stage) => {
    entry.renderer = state.renderer;
    if (state.renderer !== 'webgl' || !(state.webglContexts > 0) || state.contextLost !== false) {
      throw new Error(`WebGL visual evidence unavailable ${stage} capture: ${JSON.stringify(state)}`);
    }
  };
  entry.rendererBefore = await inspect();
  assertHealthy(entry.rendererBefore, 'before');
  await page.screenshot({ path: file });
  entry.rendererAfter = await inspect();
  assertHealthy(entry.rendererAfter, 'after');
  Object.assign(entry, {
    dimensions: entry.rendererAfter.dimensions,
    visualEvidenceValid: true,
  });
}
