import { resolve, join } from 'node:path';
import { chromium } from '../../renderer/node_modules/@playwright/test/index.mjs';
import { requireExecutable, waitFor } from './run-context.mjs';

/** Start only this run's packaged Electron with its private app/profile data. */
export async function startPackagedDesktop(context, {
  root, label, servers, workspace, timeoutMs = 60000,
}, { executable = requireExecutable, connect = endpoint => chromium.connectOverCDP(endpoint) } = {}) {
  root = resolve(root);
  const binary = await executable(join(root, process.platform === 'win32' ? 'kcoder-studio.exe' : 'kcoder-studio'), 'packaged Studio');
  const env = context.isolatedEnvironment({
    KCODER_CONFIG_DIR: context.pathInState('home'),
    KCODER_STUDIO_SERVERS_FILE: servers,
    KCODER_STUDIO_WORKSPACE: workspace,
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState('desktop-profile'),
  }, ['DISPLAY', 'XAUTHORITY']);
  const args = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'];
  if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  const child = context.spawnOwned(label, binary, args, { cwd: root, env });
  let output = '';
  const collect = bytes => { output = (output + bytes).slice(-16000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const endpoint = await waitFor(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1], timeoutMs, 'packaged CDP');
  context.registerPort(label, Number(new URL(endpoint).port));
  const browser = await connect(endpoint);
  let disconnected = false;
  const disconnect = async () => {
    if (disconnected) return;
    disconnected = true;
    await browser.close().catch(() => {});
  };
  context.addCleanup(`disconnect ${label}`, disconnect);
  const page = await waitFor(() => browser.contexts().flatMap(c => c.pages())
    .find(p => p.url().startsWith('http://127.0.0.1:')), timeoutMs, 'packaged page');
  // Navigation before the initial loadURL finishes can abort host startup.
  await page.getByTestId('chat-message-input').waitFor({ timeout: timeoutMs });
  let stopped = false;
  return { page, root, async stop() {
    if (stopped) return;
    stopped = true;
    try { await disconnect(); } finally { await context.stopOwned(label); }
  } };
}
