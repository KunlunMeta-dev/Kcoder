import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '../../renderer/node_modules/@playwright/test/index.mjs';
import { appRoot, repoRoot, requireExecutable, waitFor } from './run-context.mjs';
import { prepareWindowsSourceDesktop } from './windows-source-desktop.mjs';
import { prepareInstalledDesktop, verifyInstalledNativeWitness } from './installed-desktop-identity.mjs';

export function windowsDesktopTemporaryDirectory(context, label) {
  const directory = context.pathInState(`t-${createHash('sha256').update(label).digest('hex').slice(0, 12)}`);
  // Native Git aliases add a separator, "kg-", 32 hex digits and a two-byte child.
  // Git checks this path before reading core.longpaths; keep it inside owned state.
  if (Buffer.byteLength(directory) + 38 > 219)
    throw new Error('UNMET_PREREQUISITE: Windows desktop state path is too long for Native Git aliases; use a shorter checkout path');
  return directory;
}

async function inspectStartupTargets(endpoint) {
  const url = new URL(endpoint);
  url.protocol = 'http:'; url.pathname = '/json/list'; url.search = ''; url.hash = '';
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Owned CDP startup diagnostics unavailable');
  const targets = await response.json();
  return targets.slice(0, 32).map(target => {
    let location = '';
    try { const value = new URL(target.url); location = `${value.origin}${value.pathname}`; } catch {}
    return { type: target.type, location };
  });
}

async function inspectStartupPages(browser) {
  return Promise.all(browser.contexts().flatMap(context => context.pages()).slice(0, 8)
    .filter(page => typeof page.evaluate === 'function').map(async page => {
      let location = '';
      try { const url = new URL(page.url()); location = `${url.origin}${url.pathname}`; } catch {}
      let timer;
      try {
        const state = await Promise.race([
          page.evaluate(() => {
            const locationOnly = value => { try { const url = new URL(value, location.href); return `${url.origin}${url.pathname}`; } catch { return ''; } };
            return { readyState: document.readyState, visibility: document.visibilityState,
              rootChildren: document.getElementById('root')?.childElementCount ?? 0,
              resources: performance.getEntriesByType('resource').slice(-128).map(entry => ({
                location: locationOnly(entry.name), durationMs: Math.round(entry.duration),
                bytes: entry.transferSize, status: entry.responseStatus ?? null,
              })),
              stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).slice(0, 16)
                .map(link => ({ location: locationOnly(link.href), loaded: Boolean(link.sheet) })),
            };
          }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup renderer unresponsive')), 2000); }),
        ]);
        return { location, ...state };
      } catch { return { location, unavailable: true }; }
      finally { clearTimeout(timer); }
    }));
}

/** Start real source Electron with an owned display, profile and dynamic CDP port. */
export async function startSourceDesktop(context, {
  label, profile, servers, workspace, env = {},
  kcoderBin, rendererRoot, installedDirectory, installedIdentity, nativeWitness,
}, { executable = requireExecutable, connect = endpoint => chromium.connectOverCDP(endpoint),
  platform = process.platform, noSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1',
  prepareWindows = prepareWindowsSourceDesktop, prepareInstalled = prepareInstalledDesktop,
  verifyWitness = verifyInstalledNativeWitness, inspectTargets = inspectStartupTargets } = {}) {
  if (!['linux', 'win32'].includes(platform)) throw new Error('UNMET_PREREQUISITE: source desktop capture requires Linux Xvfb or an owned Windows desktop');
  if (platform === 'linux' && !noSandbox) throw new Error('UNMET_PREREQUISITE: isolated VM no-sandbox opt-in required');
  if (platform === 'win32' && noSandbox) throw new Error('UNMET_PREREQUISITE: Windows source Electron requires the normal Chromium sandbox');
  if (platform === 'win32' && !process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN)
    throw new Error('UNMET_PREREQUISITE: explicit Windows process supervisor is required');
  let installed = null, witness = null;
  if (installedDirectory !== undefined) {
    if (platform !== 'win32') throw new Error('UNMET_PREREQUISITE: this installed host gate requires actual Windows');
    if (kcoderBin !== undefined || rendererRoot !== undefined || servers !== undefined)
      throw new Error('Installed host cannot use source Native, renderer or server-command overrides');
    for (const [name, value] of Object.entries(env)) {
      if (value && /^(?:KCODER_STUDIO_(?:KCODER_BIN|WEB_ROOT|GATEWAY.*|SERVERS.*|REMOTE.*|DESKTOP_PROFILE)|ELECTRON_RUN_AS_NODE)$/i.test(name))
        throw new Error('Installed host cannot override packaged runtime sources');
    }
    installed = await prepareInstalled(context, { label, directory: installedDirectory, expected: installedIdentity });
    if (nativeWitness) witness = await verifyWitness(context, installed, nativeWitness);
  } else if (nativeWitness) throw new Error('Native witness requires a verified installed package');
  const xvfb = platform === 'linux' ? await executable('/usr/bin/xvfb-run', 'Xvfb runner') : null;
  const electron = await executable(installed?.hostPath || process.env.KCODER_E2E_ELECTRON_BIN || resolve(appRoot, `node_modules/electron/dist/electron${platform === 'win32' ? '.exe' : ''}`), 'Electron');
  const binary = installed ? null : await executable(kcoderBin || resolve(repoRoot, `target/debug/kcoder${platform === 'win32' ? '.exe' : ''}`), 'KCoder');
  const electronArgs = [...(platform === 'linux' ? ['--no-sandbox'] : []),
    // Avoid depending on an interactive GPU surface in the private test desktop.
    ...(platform === 'win32' ? ['--disable-gpu'] : []),
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    ...(installed ? [] : [resolve(appRoot, 'desktop/main.mjs')]),
  ];
  const windowsTemporary = platform === 'win32' ? windowsDesktopTemporaryDirectory(context, label) : null;
  const hostEnv = context.isolatedEnvironment({
    ...env, HOME: context.pathInState('home'), USERPROFILE: context.pathInState('home'), ELECTRON_RUN_AS_NODE: '',
    KCODER_CONFIG_DIR: profile, KCODER_STUDIO_SERVERS_FILE: servers,
    KCODER_STUDIO_WORKSPACE: workspace,
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState(`${label}-profile`),
    ...(installed ? (witness ? { KCODER_STUDIO_KCODER_BIN: witness.path } : {}) : {
      KCODER_STUDIO_KCODER_BIN: binary,
      KCODER_STUDIO_WEB_ROOT: rendererRoot || process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'),
      KCODER_STUDIO_TEST_WINDOWS_MENU: '1',
    }),
    ...(platform === 'win32' ? {
      APPDATA: context.pathInState(`${label}-appdata`), LOCALAPPDATA: context.pathInState(`${label}-local-appdata`),
      TEMP: windowsTemporary, TMP: windowsTemporary, TMPDIR: windowsTemporary,
    } : {}),
  });
  const hostCwd = installed?.root || appRoot;
  const windows = platform === 'win32'
    ? await prepareWindows(context, { label, electron, args: electronArgs, cwd: hostCwd, env: hostEnv, executable }) : null;
  const child = windows
    ? context.spawnOwned(label, windows.command, windows.args, windows.options)
    : context.spawnOwned(label, xvfb, ['-a', '-s', '-screen 0 1600x1100x24 -nolisten tcp', electron, ...electronArgs], { cwd: appRoot, env: hostEnv });
  let stopHostPromise;
  const stopHost = () => stopHostPromise ??= Promise.resolve().then(() => windows ? windows.close(child) : context.stopOwned(label));
  if (windows) context.addCleanup(`release ${label} private Windows desktop`, stopHost);
  let output = '';
  const collect = bytes => { output = `${output}${bytes}`.slice(-16000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const endpoint = await waitFor(() => {
    if (child.exitCode != null || child.signalCode != null) throw new Error('Owned source desktop exited before CDP readiness');
    return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
  }, 30000, 'source desktop CDP', 100, context.abortSignal);
  context.registerPort(`${label}-cdp`, Number(new URL(endpoint).port));
  const browser = await connect(endpoint);
  let disconnectPromise;
  const disconnect = () => disconnectPromise ??= (async () => {
    const failures = [];
    // CDP is an observer of this host. End its actual owner before detaching it.
    try { await stopHost(); }
    catch (error) { failures.push(error); }
    finally {
      try { await browser.close(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `Owned host and CDP cleanup failed: ${label}`);
  })();
  context.addCleanup(`disconnect ${label} CDP`, disconnect);
  let hostReceipt = null, page;
  try {
    page = await waitFor(() => browser.contexts().flatMap(item => item.pages())
      .find(item => item.url().startsWith('http://127.0.0.1:')), windows ? 60000 : 30000, 'source desktop page', 100, context.abortSignal);
    if (windows) await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
    hostReceipt = windows ? await windows.ready(child) : null;
  }
  catch (error) {
    // Passive target metadata helps explain hidden-window startup failures;
    // it never substitutes for the required visible Win32 window receipt.
    try { await context.writeArtifactJson(`${label}-startup-targets.json`, {
      targets: await inspectTargets(endpoint), pages: await inspectStartupPages(browser),
    }); }
    catch { await context.writeArtifactJson(`${label}-startup-targets.json`, { unavailable: true }); }
    throw error;
  }
  return { child, page, browser, hostReceipt, installedIdentity: installed, nativeWitness: witness, output: () => output, stop: disconnect };
}
