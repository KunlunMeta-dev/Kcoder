// Runs only against a private copy of the installed Electron host and synthetic profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

const [binary, installation, overlay, artifacts] = process.argv.slice(2);
const workflowProbe = process.argv.includes('--workflows');
const pluginsProbe = process.argv.includes('--plugins');
const installedResources = process.argv.includes('--installed-resources');
const accountsProbe = process.argv.includes('--accounts');
let accountInput;
const steerProbe = process.argv.includes('--steer');
const historyProbe = process.argv.includes('--project-history') || workflowProbe;
if (process.platform !== 'win32' || ![binary, installation, overlay, artifacts].every(Boolean))
  throw Error('An explicit Windows binary, installation, overlay and artifact directory are required');
const root = fs.mkdtempSync(path.join(artifacts, 'studio-ui-'));
let app;
let socket;
let stage = 'prepare';
let appOutput = '';
let cleaned = false;
let captureFailure;
let failureText;
let modelFixture;
let modelRequests = 0;
let imageRequests = 0;
const wireTrace = [];
const steerIds = new Map();
const completions = new Map();
const appliedSteers = [];
const runtimeDiagnostics = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    if (app && app.exitCode !== null) throw Error(`Private App exited at ${stage}`);
    await delay(40);
  }
  throw Error(`Timed out at ${stage}`);
}
function stopApp() {
  if (app && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
}
const deadline = setTimeout(() => { stopApp(); }, historyProbe || steerProbe || installedResources ? 180000 : 75000);

async function main() {
  const host = path.join(root, 'app');
  const resources = path.join(host, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  for (const entry of fs.readdirSync(installation, { withFileTypes: true })) {
    if (entry.isFile() && !/^uninstall/i.test(entry.name))
      fs.copyFileSync(path.join(installation, entry.name), path.join(host, entry.name));
  }
  fs.cpSync(path.join(installation, 'locales'), path.join(host, 'locales'), { recursive: true });
  fs.copyFileSync(path.join(installation, 'resources/app.asar'), path.join(resources, 'app.asar'));
  assert.ok(fs.readFileSync(path.join(resources, 'app.asar')).includes(Buffer.from('KCODER_STUDIO_DESKTOP_USER_DATA_DIR')),
    'Installed host does not support an isolated profile');
  fs.cpSync(path.join(installation, 'resources/shell'), path.join(resources, 'shell'), { recursive: true });
  fs.cpSync(path.join(installation, 'resources/gateway'), path.join(resources, 'gateway'), { recursive: true });
  if (installedResources) {
    fs.cpSync(path.join(installation, 'resources/renderer-dist'), path.join(resources, 'renderer-dist'), { recursive: true });
    fs.cpSync(path.join(installation, 'resources/bin'), path.join(resources, 'bin'), { recursive: true });
    assert.ok(fs.readFileSync(binary).equals(fs.readFileSync(path.join(resources, 'bin/kcoder.exe'))), 'Installed runtime differs from the reviewed Windows build');
  } else {
    fs.copyFileSync(path.join(overlay, 'dev-server.mjs'), path.join(resources, 'gateway/dev-server.mjs'));
    fs.cpSync(path.join(overlay, 'src'), path.join(resources, 'gateway/src'), { recursive: true, force: true });
    fs.mkdirSync(path.join(resources, 'bin'));
    fs.copyFileSync(binary, path.join(resources, 'bin/kcoder.exe'));
    fs.copyFileSync(path.join(installation, 'resources/bin/kcoder-process-supervisor.exe'), path.join(resources, 'bin/kcoder-process-supervisor.exe'));
  }
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  if (historyProbe) {
    modelFixture = http.createServer((req, res) => {
      req.resume();
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] }));
      } else {
        let body = '';
        req.on('data', chunk => { if (body.length < 8 * 1024 * 1024) body += chunk; });
        req.once('end', () => {
          try {
            const parsed = JSON.parse(body);
            const latest = parsed.messages?.filter(message => message.role === 'user').at(-1);
            if (Array.isArray(latest?.content) && latest.content.some(part => part.type === 'image_url')) imageRequests++;
          } catch {}
        });
        modelRequests++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = { id: `history-${modelRequests}`, object: 'chat.completion.chunk', created: 1, model: 'fixture' };
        res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'WINDOWS_HISTORY_REPLY' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
    });
    await new Promise((resolve, reject) => { modelFixture.once('error', reject); modelFixture.listen(0, '127.0.0.1', resolve); });
  }
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ active_provider: 'fixture',
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: historyProbe ? `http://127.0.0.1:${modelFixture.address().port}/v1` : 'http://127.0.0.1:1/v1', no_proxy: true,
      default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192 } } }));
  fs.writeFileSync(path.join(profile, 'credentials.json'), JSON.stringify(historyProbe
    ? { fixture: { type: 'api', key: 'synthetic-windows-history-fixture' } } : {}));
  const steerGate = path.join(root, 'steer-gate');
  if (steerProbe) {
    fs.mkdirSync(steerGate);
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ providers: {}, model: 'tui-dev-mock',
      context_window_tokens: 200000, context_output_headroom: 20000, max_tokens: 4096 }));
  }
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ProgramData', 'ProgramFiles', 'CommonProgramFiles', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC'])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    KCODER_CONFIG_DIR: profile,
    KCODER_STUDIO_DESKTOP_USER_DATA_DIR: path.join(root, 'electron-profile'),
    KCODER_STUDIO_WEB_ROOT: installedResources ? path.join(resources, 'renderer-dist') : path.join(overlay, 'renderer/dist'),
    KCODER_STUDIO_KCODER_BIN: path.join(resources, 'bin/kcoder.exe'),
    KCODER_STUDIO_WORKSPACE: workspace,
    ...(installedResources && !accountsProbe ? { KCODER_STUDIO_AUTH_SESSION_TTL_MS: '3000' } : {}),
    KCODER_STUDIO_SERVERS: JSON.stringify([{ id: 'local', label: 'Windows UI fixture', transport: 'local',
      command: path.join(resources, 'bin/kcoder.exe'), workspace }]),
  });
  if (accountsProbe) {
    env.KCODER_STUDIO_SERVERS = JSON.stringify([{ id: 'account-server', label: 'KCoder account fixture',
      transport: 'ssh', host: accountInput.host, user: 'root',
      security: { identity: { mode: 'kcoder-account', username: accountInput.username } } }]);
  }
  if (steerProbe) Object.assign(env, { KCODER_STUDIO_SCENARIO: 'subagent-trace', KCODER_TUI_LAB_STEER_GATE_DIR: steerGate });
  stage = 'app-start';
  const appStartedAt = Date.now();
  app = spawn(path.join(host, 'kcoder-studio.exe'), ['--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = data => { appOutput = `${appOutput}${data}`.slice(-16000); };
  app.stdout.on('data', collect); app.stderr.on('data', collect);
  const browserUrl = await until(() => appOutput.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]);
  const debuggerOrigin = `http://${new URL(browserUrl).host}`;
  const target = await until(async () => {
    const targets = await (await fetch(`${debuggerOrigin}/json/list`)).json();
    return targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
  });
  const base = new URL(target.url).origin;
  assert.ok(fs.existsSync(path.join(root, 'electron-profile/Partitions/kcoder-studio-desktop')), 'Private Chromium profile was not created');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let sequence = 0;
  let navigation = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Error(`CDP ${request.method} failed`)) : request.resolve(message.result);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const args = message.params.args ?? [];
      if (message.params.type === 'error' || String(args[0]?.value).includes('[KCoder Studio] Runtime')) {
        const values = [];
        for (const arg of args) {
          if (arg.value !== undefined) values.push(arg.value);
          else if (arg.subtype === 'error') values.push(arg.description);
          else if (arg.preview) values.push(Object.fromEntries((arg.preview.properties ?? []).map(p => [p.name, p.value])));
        }
        runtimeDiagnostics.push(values);
        if (runtimeDiagnostics.length > 400) runtimeDiagnostics.shift();
      }
    } else if (message.method === 'Page.fileChooserOpened') events.push(message);
    else if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) navigation++;
    else if (['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(message.method)) {
      try {
        const frame = JSON.parse(message.params.response.payloadData);
        if (steerProbe && message.method === 'Network.webSocketFrameReceived') {
          const event = frame.params?.event;
          if (frame.method === 'item/event' && event?.type === 'background_job_associated') steerIds.set(event.tool_call_id, event.id);
          if (frame.method === 'item/event' && event?.type === 'background_job_completed') completions.set(event.id, { text: event.text, isError: event.is_error });
          if (frame.method === 'agent/steer/applied') appliedSteers.push({ agentId: frame.params.agentId, messageId: frame.params.messageId });
        }
        // Whitelist protocol metadata only; never retain tokens, message bodies or URLs.
        wireTrace.push({ at: Date.now(), socket: message.params.requestId,
          direction: message.method.endsWith('Sent') ? 'sent' : 'received', id: frame.id,
          method: frame.method, errorCode: frame.error?.code,
          eventType: frame.params?.event?.type,
          eventId: frame.params?.event?.id,
          sequence: frame.params?.sequence,
          eventError: steerProbe ? frame.params?.event?.error : undefined,
          resultKeys: frame.result ? Object.keys(frame.result) : undefined,
          messages: Array.isArray(frame.result?.messages) ? frame.result.messages.length : undefined });
        if (wireTrace.length > 400) wireTrace.shift();
      } catch {}
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('CDP open timed out')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP open failed')); }, { once: true });
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, method === 'Runtime.evaluate' ? 30000 : 10000);
    pending.set(id, { method, resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw Error(`Page script failed at ${stage}: ${String(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text).slice(0, 2000)}`);
    return response.result.value;
  };
  const traceIpc = () => evaluate(`(()=>{const original=window.__TAURI_INTERNALS__.invoke;const entries=[];window.__kcoderProbeIpc=entries;window.__TAURI_INTERNALS__.invoke=async function(command,args){const item={at:Date.now(),command,method:args?.method,taskId:args?.params?.address?.taskId||args?.params?.taskId,state:'pending'};entries.push(item);if(entries.length>150)entries.shift();try{const result=await original.call(this,command,args);item.state='resolved';item.ms=Date.now()-item.at;return result}catch(error){item.state='rejected';item.error=String(error.message).slice(0,180);throw error}};return true})()`);
  const selector = id => `[data-testid="${id}"]`;
  const exists = id => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector(id))}))`);
  const click = async id => {
    await until(() => exists(id));
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector(id))});e.scrollIntoView({block:'center'});if(e.disabled)throw Error('disabled');e.click();return true})()`);
  };
  const navigate = async (route, id) => {
    const before = navigation;
    await request('Page.navigate', { url: `${base}${route}` });
    await until(() => navigation > before);
    await until(() => exists(id));
  };
  const reload = async id => {
    const before = navigation;
    await request('Page.reload');
    await until(() => navigation > before);
    await until(() => exists(id));
    if (historyProbe) await traceIpc();
  };
  const choose = async id => {
    events.length = 0;
    await request('Page.setInterceptFileChooserDialog', { enabled: true });
    await click(id);
    const event = await until(() => events.shift());
    await request('DOM.setFileInputFiles', { backendNodeId: event.params.backendNodeId,
      files: [path.join(overlay, 'logo/logo.png')] });
  };
  const screenshot = async name => {
    const result = await request('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifacts, name), Buffer.from(result.data, 'base64'));
  };
  captureFailure = async () => {
    if (accountsProbe) failureText = await evaluate('document.body.innerText.slice(0,3000)');
    await screenshot('windows-failure.png');
    if (historyProbe || steerProbe) {
      const state = await evaluate(`({ testIds: [...document.querySelectorAll('[data-testid]')].map(node=>({id:node.dataset.testid,visible:node.getClientRects().length>0})).filter(item=>/message|pause/.test(item.id)), assistants: [...document.querySelectorAll('[data-testid="message-assistant"]')].map(node=>({text:node.textContent,inner:node.innerText})), text:document.body.innerText.slice(-6000) })`);
      const ipc = await evaluate('window.__kcoderProbeIpc || []');
      fs.writeFileSync(path.join(artifacts, 'windows-history-dom.json'), JSON.stringify({ ...state, wireTrace, ipc,
        steerIds: [...steerIds], completions: [...completions], appliedSteers, runtimeDiagnostics }));
    }
  };
  await request('Page.enable');
  await request('Runtime.enable');
  await request('Network.enable');
  await request('Page.bringToFront');
  await request('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => exists(accountsProbe ? 'kcoder-account-login' : 'desktop-sidebar'));
  if (accountsProbe) {
    stage = 'account-login';
    const fillInput = async (selector, value) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const loginFormVisible = () => evaluate(`Boolean(document.querySelector('[data-testid="kcoder-account-username"]'))`);
    const accountLoginSection = () => evaluate(`(document.querySelector('[data-testid="kcoder-account-login"]')||{innerText:''}).innerText`);
    const submitLogin = async (username, password) => {
      await fillInput('[data-testid="kcoder-account-username"]', username);
      await fillInput('[data-testid="kcoder-account-password"]', password);
      await evaluate(`document.querySelector('[data-testid="kcoder-account-submit"]').click()`);
    };
    await submitLogin(accountInput.username, accountInput.password);
    await until(async () => {
      if (await evaluate(`Boolean(document.querySelector('[data-testid="kcoder-account-login"] [role="alert"]'))`)) throw Error('Account login rejected');
      return exists('desktop-sidebar');
    }, 30000);
    // The workbench sidebar account chip must expose per-target login,
    // switch and sign-out entries for the authenticated account target.
    stage = 'sidebar-account-menu';
    await evaluate(`document.querySelector('[data-testid="settings-button"]').click()`);
    await until(() => exists('gateway-account-section'), 15000);
    await until(() => exists('gateway-account-switch-account-server'), 10000);
    assert.equal(await exists('gateway-account-logout-account-server'), true);
    await screenshot('windows-sidebar-account-menu.png');
    await evaluate(`document.querySelector('[data-testid="settings-button"]').click()`);
    await until(async () => !(await exists('gateway-account-section')), 5000);
    await navigate('/settings/kcoder-servers', 'kcoder-account-management');
    stage = 'account-administration';
    await evaluate(`document.querySelector('[data-testid="kcoder-account-management"] button').click()`);
    await until(() => exists('kcoder-account-create'));
    await fillInput('[data-testid="kcoder-account-new-username"]', accountInput.testUsername);
    await fillInput('[data-testid="kcoder-account-new-password"]', 'synthetic-windows-account-password');
    await click('kcoder-account-create');
    await until(() => evaluate(`document.querySelector('[data-testid="kcoder-account-management"]').innerText.includes(${JSON.stringify(accountInput.testUsername)})`));
    assert.equal(await evaluate(`document.querySelector('[data-testid="kcoder-account-new-password"]').value`), '');
    stage = 'account-reload';
    await reload('kcoder-account-management');
    await screenshot('windows-account-management.png');

    // Switch account on the same connection: root -> freshly created user,
    // without creating a new server target.
    stage = 'account-switch';
    await until(() => exists('kcoder-account-switch'), 15000);
    await evaluate(`document.querySelector('[data-testid="kcoder-account-switch"]').click()`);
    await until(() => exists('kcoder-account-confirm-logout'));
    await evaluate(`document.querySelector('[data-testid="kcoder-account-confirm-logout"]').click()`);
    await until(() => loginFormVisible(), 20000);
    await screenshot('windows-account-switch-logged-out.png');
    const testPassword = 'synthetic-windows-account-password';
    await submitLogin(accountInput.testUsername, testPassword);
    // Switching happens inside the settings page: success shows the new
    // identity there instead of returning to the workbench sidebar.
    await until(async () => {
      if (await evaluate(`Boolean(document.querySelector('[data-testid="kcoder-account-login"] [role="alert"]'))`)) throw Error('Switch login rejected');
      return (await accountLoginSection()).includes(accountInput.testUsername);
    }, 30000);
    await screenshot('windows-account-switched-in.png');

    // Failed login after leaving the old identity must not restore it.
    stage = 'account-failed-login';
    await evaluate(`document.querySelector('[data-testid="kcoder-account-logout"]').click()`);
    await until(() => exists('kcoder-account-confirm-logout'));
    await evaluate(`document.querySelector('[data-testid="kcoder-account-confirm-logout"]').click()`);
    await until(() => loginFormVisible(), 20000);
    await submitLogin(accountInput.username, 'deliberately-wrong-password');
    await until(() => evaluate(`Boolean(document.querySelector('[data-testid="kcoder-account-login"] [role="alert"]'))`), 20000);
    assert.equal(await exists('desktop-sidebar'), false);
    await screenshot('windows-account-failed-login.png');

    // A reload must not silently restore a logged-out account.
    stage = 'account-reload-anonymous';
    await reload('kcoder-account-username');
    assert.equal(await loginFormVisible(), true);
    assert.equal(await exists('desktop-sidebar'), false);
    await screenshot('windows-account-switch-flows.png');

    // Sign back in as the administrator for the final state.
    stage = 'account-login-back';
    await submitLogin(accountInput.username, accountInput.password);
    await until(async () => {
      if (await evaluate(`Boolean(document.querySelector('[data-testid="kcoder-account-login"] [role="alert"]'))`)) throw Error('Relogin rejected');
      return (await accountLoginSection()).includes(accountInput.username);
    }, 30000);
    await screenshot('windows-account-relogin.png');
    return { passed: true, actualWindowsElectron: true, installedResources, accountLogin: true,
      administratorCreatedUser: accountInput.testUsername, reloadPreservedAuthorization: true,
      switchedToCreatedUser: true, failedLoginStayedLoggedOut: true, reloadKeptLoggedOut: true,
      reLoginRestoredIdentity: true };
  }
  if (pluginsProbe) {
    stage = 'plugins-install-native-fixture';
    const plugin = path.join(root, 'plugin-source');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'skills', 'native-skill'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'hooks'));
    fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'windows-plugin-ui', version: '1.0.0', description: 'Windows native inventory fixture' }));
    fs.writeFileSync(path.join(plugin, 'skills/native-skill/SKILL.md'), '---\nname: WINDOWS_NATIVE_PLUGIN_SKILL\ndescription: Native inventory skill\n---\nUse this fixture skill.');
    fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'native-ui': { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }));
    fs.writeFileSync(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] } }));
    const id = await evaluate(`(${seedProjectHistory.toString()})(undefined, false, ${JSON.stringify(plugin)})`);
    assert.equal(id, 'windows-plugin-ui@local');
    await navigate('/plugins/manage', 'kcoder-plugin-management');
    await until(() => exists(`kcoder-plugin-row-${id}`));
    await click('kcoder-plugin-tab-skills');
    await until(() => evaluate(`document.body.innerText.includes('WINDOWS_NATIVE_PLUGIN_SKILL')`));
    await click('kcoder-plugin-tab-mcp');
    await until(() => evaluate(`document.body.innerText.includes('plugin.windows-plugin-ui@local.native-ui')`));
    await click('kcoder-plugin-tab-hooks');
    await until(() => evaluate(`document.body.innerText.includes('UserPromptSubmit')`));
    await click('kcoder-plugin-tab-plugins');
    await click(`kcoder-plugin-toggle-${id}`);
    await until(() => evaluate(`document.querySelector('[data-testid="kcoder-plugin-toggle-${id}"]')?.textContent.includes('启用')`));
    await click('kcoder-plugin-tab-skills');
    await until(async () => !(await evaluate(`document.body.innerText.includes('WINDOWS_NATIVE_PLUGIN_SKILL')`)));
    await click('kcoder-plugin-tab-plugins');
    await until(() => evaluate(`document.querySelector('[data-testid="kcoder-plugin-toggle-${id}"]')?.disabled === false`));
    await click(`kcoder-plugin-toggle-${id}`);
    await until(() => evaluate(`document.querySelector('[data-testid="kcoder-plugin-toggle-${id}"]')?.textContent.includes('停用')`));
    await until(() => evaluate(`document.querySelector('[data-testid="kcoder-plugin-uninstall-${id}"]')?.disabled === false`));
    await click(`kcoder-plugin-uninstall-${id}`);
    await click(`kcoder-plugin-confirm-uninstall-${id}`);
    await until(async () => !(await exists(`kcoder-plugin-row-${id}`)));
    await screenshot('windows-plugin-manager.png');
    const fill = async (css, value) => {
      await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(css)})) && !document.querySelector(${JSON.stringify(css)}).disabled`));
      await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(css)});const prototype=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    };
    const clickCss = async css => {
      await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(css)})) && !document.querySelector(${JSON.stringify(css)}).disabled`));
      await evaluate(`document.querySelector(${JSON.stringify(css)}).click();true`);
    };
    stage = 'standalone-skill-import';
    const skillSource = path.join(root, 'independent-skill');
    fs.mkdirSync(path.join(skillSource, 'references'), { recursive: true });
    const skillContent = '\uFEFF---\r\nname: windows-user-skill\r\ndescription: Windows user import\r\n---\r\nRead the reference.\r\n';
    fs.writeFileSync(path.join(skillSource, 'SKILL.md'), skillContent);
    fs.writeFileSync(path.join(skillSource, 'references/example.md'), 'WINDOWS_SKILL_REFERENCE');
    await click('kcoder-plugin-tab-skills');
    await fill('[data-testid="kcoder-skill-import"] input', skillSource);
    await clickCss('[data-testid="kcoder-skill-import"] button[type="submit"]');
    await until(() => exists('kcoder-skill-remove'));
    assert.equal(fs.readFileSync(path.join(profile, 'skills/windows-user-skill/SKILL.md'), 'utf8'), skillContent);
    assert.equal(fs.readFileSync(path.join(profile, 'skills/windows-user-skill/references/example.md'), 'utf8'), 'WINDOWS_SKILL_REFERENCE');
    await screenshot('windows-skill-management.png');
    await clickCss('[data-testid="kcoder-skill-remove"]');
    await clickCss('[role="alertdialog"] button:first-of-type');
    await until(async () => !(await exists('kcoder-skill-remove')));
    assert.equal(fs.existsSync(path.join(profile, 'skills/windows-user-skill')), false);
    assert.ok(fs.readdirSync(path.join(profile, 'skills/.archive')).some(name => name.startsWith('studio-')));
    stage = 'standalone-mcp-install';
    await click('kcoder-plugin-tab-mcp');
    await clickCss('[data-testid="kcoder-mcp-management"] > div > button');
    await fill('[data-testid="kcoder-mcp-install-form"] label:nth-of-type(1) input', 'windows-independent-mcp');
    await fill('[data-testid="kcoder-mcp-install-form"] label:nth-of-type(3) input', 'https://example.invalid/mcp');
    await clickCss('[data-testid="kcoder-mcp-install-form"] button[type="submit"]');
    await until(() => exists('kcoder-mcp-remove'));
    assert.ok(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).mcp_servers.some(server => server.name === 'windows-independent-mcp'));
    await screenshot('windows-mcp-management.png');
    await clickCss('[data-testid="kcoder-mcp-remove"]');
    await clickCss('[role="alertdialog"] button:first-of-type');
    await until(async () => !(await exists('kcoder-mcp-remove')));
    assert.ok(!JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).mcp_servers.some(server => server.name === 'windows-independent-mcp'));
    if (installedResources) {
      await until(() => Date.now() - appStartedAt >= 6500);
      assert.equal(await evaluate("fetch('/api/servers').then(response => response.status)"), 200,
        'Installed desktop must keep authentication alive across multiple three-second sessions');
    }
    return { passed: true, actualWindowsElectron: true, installedResources, pluginsValidated: true,
      ...(installedResources ? { shortSessionRenewalVerified: true, authSessionTtlMs: 3000 } : {}),
      nativeSkillMcpHookInventory: true, disableEnable: true, confirmedUninstall: true,
      standaloneSkillImportedAndArchived: true, standaloneMcpInstalledAndRemoved: true };
  }
  if (steerProbe) {
    await evaluate(`localStorage.setItem('wework:debug-runtime-chat-stream','1');localStorage.setItem('wework:debug-runtime','1');true`);
    stage = 'steer-seed-one-thread';
    const seed = await evaluate(`(${seedProjectHistory.toString()})(undefined, true)`);
    await reload('desktop-sidebar');
    await click(`runtime-local-task-row-kcoder:local:${seed.id}`);
    stage = 'steer-submit-parent';
    await until(() => evaluate(`document.querySelector('[data-testid="chat-message-input"]')?.getAttribute('contenteditable') === 'true'`));
    await evaluate(`document.querySelector('[data-testid="chat-message-input"]').focus();true`);
    await request('Input.insertText', { text: 'app-server-background-subagent tui-lab-targeted-subagent-steer' });
    await click('send-message-button');
    stage = 'steer-associate-two-agents';
    await until(() => steerIds.has('tui-lab-spawn-agent') && steerIds.has('tui-lab-spawn-agent-sibling') && fs.existsSync(path.join(steerGate, 'entered')), 30000);
    const targetId = steerIds.get('tui-lab-spawn-agent');
    const siblingId = steerIds.get('tui-lab-spawn-agent-sibling');
    assert.notEqual(targetId, siblingId);
    stage = 'steer-sibling-independent';
    await until(() => completions.has(siblingId), 30000);
    assert.equal(completions.has(targetId), false);
    stage = 'steer-open-panel';
    if (!(await exists('subagent-status-panel'))) await click('subagent-status-toggle-button');
    const targetSelector = `[data-testid="subagent-status-item"][data-agent-id=${JSON.stringify(targetId)}]`;
    const status = () => evaluate(`document.querySelector(${JSON.stringify(targetSelector)})?.dataset.steerStatus`);
    stage = 'steer-submit-target';
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(targetSelector)})?.querySelector('[data-testid="subagent-steer-open"]'))`));
    await evaluate(`document.querySelector(${JSON.stringify(targetSelector)}).querySelector('[data-testid="subagent-steer-open"]').click();true`);
    await until(() => exists('subagent-steer-input'));
    await evaluate(`document.querySelector('[data-testid="subagent-steer-input"]').focus();true`);
    await request('Input.insertText', { text: 'STUDIO_TARGETED_SUBAGENT_STEER_E2E' });
    await click('subagent-steer-submit');
    stage = 'steer-queued';
    await until(async () => (await status())?.startsWith('queued'));
    await screenshot('windows-steer-queued.png');
    fs.writeFileSync(path.join(steerGate, 'release'), '', { flag: 'wx' });
    stage = 'steer-applied';
    await until(async () => (await status()) === 'applied', 60000);
    await until(() => completions.has(targetId), 30000);
    assert.equal(completions.get(targetId).isError, false);
    assert.equal(completions.get(siblingId).isError, false);
    assert.match(completions.get(targetId).text, /tui-lab-child-line-180/);
    assert.match(completions.get(targetId).text, /tui-lab-targeted-steer-observed/);
    assert.doesNotMatch(completions.get(siblingId).text, /tui-lab-targeted-steer-observed/);
    assert.ok(appliedSteers.some(event => event.agentId === targetId));
    assert.ok(!appliedSteers.some(event => event.agentId === siblingId));
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-testid="message-user"]')].some(node=>node.innerText.includes('STUDIO_TARGETED_SUBAGENT_STEER_E2E'))`), false);
    await delay(500);
    assert.equal(await status(), 'applied');
    await screenshot('windows-steer-applied.png');
    return { passed: true, actualWindowsElectron: true, startupRendered: true, targetId, siblingId,
      targetQueuedThenApplied: true, siblingIndependent: true, targetLongOutput: true, parentInputNotPolluted: true,
      modelPolicy: 'deterministic protocol/UI check; not model reasoning evaluation' };
  }
  if (historyProbe) {
    await traceIpc();
    // Model-independent regression: real Windows RPC persistence and real Electron
    // projection, without copying any personal project, history or credentials.
    stage = 'history-seed';
    const seed = await evaluate(`(${seedProjectHistory.toString()})(${JSON.stringify(path.join(workspace, 'project with spaces'))})`);
    assert.ok(seed.canonical.startsWith('\\\\?\\'), 'Registry must expose a namespaced path');
    assert.ok(seed.paths.every(value => !value.startsWith('\\\\?\\')), 'History must exercise ordinary DOS paths');
    await reload('desktop-sidebar');
    const projectExpression = `[...document.querySelectorAll('[data-testid="project-item"]')].find(node => node.textContent.includes('Windows history project'))`;
    const expand = async () => {
      await until(() => evaluate(`Boolean(${projectExpression})`));
      await evaluate(`(()=>{const button=(${projectExpression}).querySelector('[data-testid="project-item-button"]');if(button.getAttribute('aria-expanded')!=='true')button.click();return true})()`);
      await evaluate(`(()=>{const button=(${projectExpression}).querySelector('[data-testid^="project-runtime-tasks-expand-"]');if(button)button.click();return true})()`);
    };
    const visibleIds = () => evaluate(`(()=>{const project=${projectExpression};return project?[...project.querySelectorAll('[data-testid^="runtime-local-task-row-"]')].filter(node=>node.getClientRects().length).map(node=>node.dataset.testid.replace('runtime-local-task-row-','')):[]})()`);
    const oldIds = seed.ids.map(id => `kcoder:local:${id}`);
    const assertHistory = async expected => {
      await until(async () => { await expand(); const ids = await visibleIds(); return ids.length === expected.length && expected.every(id => ids.includes(id)); });
    };
    stage = 'history-initial-five';
    await assertHistory(oldIds);
    if (workflowProbe) {
      const attachImage = async () => {
        await click('add-context-button');
        await choose('attach-files-button');
        await until(() => exists('attachment-badge'));
        await until(async () => !(await exists('uploading-attachment-badge')));
      };
      const waitReplies = count => until(() => evaluate(`[...document.querySelectorAll('[data-testid="message-assistant"]')].filter(node=>node.innerText.includes('WINDOWS_HISTORY_REPLY')).length===${count} && !document.querySelector('[data-testid="pause-response-button"]')`), 30000);
      stage = 'workflow-picture-first';
      await evaluate(`(${projectExpression}).querySelector('[data-testid="project-new-conversation-button"]').click();true`);
      await attachImage(); await click('send-message-button'); await waitReplies(1);
      await expand();
      const pictureId = await until(async () => (await visibleIds()).find(id => id.startsWith('kcoder:local:') && !oldIds.includes(id)));
      stage = 'workflow-picture-followup';
      await attachImage(); await click('send-message-button'); await waitReplies(2);
      assert.ok(imageRequests >= 2, 'Both attachment-only turns must carry image blocks to the HTTP provider');
      stage = 'workflow-text-after-image';
      await evaluate(`document.querySelector('[data-testid="chat-message-input"]').focus();true`);
      await request('Input.insertText', { text: 'TEXT_AFTER_ONLY_IMAGE' });
      await click('send-message-button'); await waitReplies(3);
      const address = { deviceId: 'local', workspacePath: seed.canonical, taskId: pictureId };
      const rpc = (method, params) => evaluate(`window.__TAURI_INTERNALS__.invoke('local_executor_request',${JSON.stringify({ method, params })})`);
      stage = 'workflow-goal-delete';
      for (const mode of ['standard', 'strict']) {
        await rpc('runtime.tasks.goal.set', { address, objective: 'WINDOWS_GOAL_DELETE', mode, status: 'active' });
        assert.equal((await rpc('runtime.tasks.goal.get', { address })).goal.mode, mode);
        await reload('goal-status-bar'); await click('clear-goal-button');
        await until(async () => !(await exists('goal-status-bar')));
        assert.equal((await rpc('runtime.tasks.goal.get', { address })).goal, null);
      }
      stage = 'workflow-settings-unarchive';
      await expand(); await click(`runtime-local-task-archive-${pictureId}`);
      await until(async () => (await rpc('runtime.archived_conversations.list', {})).items.some(item => item.taskId === pictureId), 30000);
      await click('settings-button'); await click('settings-menu-button'); await click('settings-nav-archived-conversations');
      await until(() => evaluate(`Boolean(document.querySelector('[data-testid^="archived-unarchive-button-"]'))`));
      await evaluate(`document.querySelector('[data-testid^="archived-unarchive-button-"]').click();true`);
      await until(() => exists('archived-unarchive-success'));
      await click('settings-back-button'); await assertHistory([...oldIds, pictureId]);
      assert.equal((await rpc('runtime.archived_conversations.list', {})).items.some(item => item.taskId === pictureId), false);
      stage = 'workflow-terminal-colors';
      await navigate('/settings/appearance', 'appearance-settings-page'); await click('appearance-mode-light');
      await evaluate(`(()=>{const e=document.querySelector('[data-testid="appearance-terminal-foreground-light"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'#123456');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      await until(() => evaluate(`document.documentElement.style.getPropertyValue('--kcoder-terminal-foreground')==='18 52 86'`));
      await reload('appearance-settings-page');
      assert.equal(await evaluate(`document.querySelector('[data-testid="appearance-terminal-foreground-light"]').value`), '#123456');
      await screenshot('windows-workflow-colors.png');
      await navigate('/', 'desktop-sidebar'); await assertHistory([...oldIds, pictureId]);
      await screenshot('windows-workflows.png');
      return { passed: true, actualWindowsElectron: true, workflowsValidated: true, imageOnlyFirst: true,
        imageOnlyFollowup: true, textAfterImage: true, goalDeleted: true, goalProDeleted: true, settingsUnarchive: true,
        terminalColorPersisted: true, imageRequests, modelRequests };
    }
    stage = 'history-create-sixth';
    await evaluate(`(${projectExpression}).querySelector('[data-testid="project-new-conversation-button"]').click();true`);
    await until(() => evaluate(`document.querySelector('[data-testid="chat-message-input"]')?.getAttribute('contenteditable') === 'true'`));
    await evaluate(`document.querySelector('[data-testid="chat-message-input"]').focus();true`);
    await request('Input.insertText', { text: 'WINDOWS_SIXTH_CONVERSATION' });
    await until(() => evaluate(`document.querySelector('[data-testid="send-message-button"]')?.disabled === false`));
    await click('send-message-button');
    stage = 'history-new-row';
    await expand();
    const newId = await until(async () => (await visibleIds()).find(id => id.startsWith('kcoder:local:') && !oldIds.includes(id)));
    stage = 'history-new-reply';
    await until(() => evaluate(`[...document.querySelectorAll('[data-testid="message-assistant"]')].some(node=>node.innerText.includes('WINDOWS_HISTORY_REPLY')) && ![...document.querySelectorAll('[data-testid="pause-response-button"]')].some(node=>node.getClientRects().length)`));
    const allIds = [...oldIds, newId];
    stage = 'history-six-visible';
    await assertHistory(allIds);
    stage = 'history-reload-six';
    await reload('desktop-sidebar');
    await assertHistory(allIds);
    stage = 'history-read-old';
    await click(`runtime-local-task-row-${oldIds[0]}`);
    await until(() => evaluate(`[...document.querySelectorAll('[data-testid="message-user"]')].some(node=>node.textContent.includes('WINDOWS_OLD_CONVERSATION_0'))`));
    stage = 'history-archive-undo';
    await click(`runtime-local-task-archive-${oldIds[0]}`);
    await click(`runtime-local-task-archive-undo-${oldIds[0]}`);
    await assertHistory(allIds);
    stage = 'history-archive-one';
    await click(`runtime-local-task-archive-${oldIds[1]}`);
    await until(() => evaluate(`window.__TAURI_INTERNALS__.invoke('local_executor_request',{method:'runtime.archived_conversations.list',params:{}}).then(result=>result.items.some(item=>item.taskId===${JSON.stringify(oldIds[1])}))`), 30000);
    await reload('desktop-sidebar');
    await assertHistory(allIds.filter(id => id !== oldIds[1]));
    await screenshot('windows-project-history.png');
    assert.ok(modelRequests >= 6, 'The deterministic HTTP provider must receive all six turns');
    return { passed: true, actualWindowsElectron: true, projectHistory: true, initialHistory: 5,
      afterCreation: 6, afterArchive: 5, oldTranscriptReadable: true, archiveUndo: true, reloadRetainsHistory: true, modelRequests };
  }
  stage = 'background';
  await navigate('/settings/appearance', 'appearance-settings-page');
  await click('appearance-mode-dark');
  await choose('appearance-background-select-button');
  await until(() => evaluate(`document.querySelector('[data-testid="appearance-background-preview"] img')?.naturalWidth > 0`));
  await evaluate(`document.querySelector('[data-testid="appearance-background-blur-slider"]').focus();true`);
  await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await until(() => evaluate(`document.querySelector('[data-testid="appearance-background-blur-slider"]').value === '20'`));
  await reload('appearance-settings-page');
  assert.equal(await evaluate(`document.querySelector('[data-testid="appearance-background-blur-slider"]').value`), '20');
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
  await screenshot('windows-appearance.png');
  stage = 'avatar';
  await navigate('/settings', 'general-settings-page');
  await choose('client-avatar-select');
  await until(() => exists('client-avatar-image'));
  await navigate('/', 'desktop-sidebar');
  await until(() => evaluate(`document.querySelector('[data-testid="sidebar-account-avatar"] img')?.naturalWidth > 0`));
  await reload('desktop-sidebar');
  await until(() => evaluate(`document.querySelector('[data-testid="sidebar-account-avatar"] img')?.naturalWidth > 0`));
  await screenshot('windows-avatar.png');
  stage = 'usage';
  await navigate('/settings/usage', 'usage-settings-page');
  await until(() => exists('usage-coverage'));
  assert.equal(await evaluate(`document.querySelector('[data-testid="usage-table"] tbody').children.length`), 30);
  await screenshot('windows-usage.png');
  stage = 'avatar-reset';
  await navigate('/settings', 'general-settings-page');
  await click('client-avatar-remove');
  await until(async () => !(await exists('client-avatar-image')));
  await navigate('/', 'desktop-sidebar');
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="sidebar-account-avatar"] img'))`), false);
  return { passed: true, actualWindowsElectron: true, backgroundSelected: true, blurPersisted: true,
    darkThemePersisted: true, avatarPersisted: true, avatarReset: true, usagePage: true };
}

async function seedProjectHistory(projectPath, steerOnly = false, pluginPath = null) {
  const connections = [];
  async function connect(workspace) {
    const url = new URL('/rpc', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('server', 'local');
    url.searchParams.set('token', document.querySelector('meta[name="kcoder-rpc-token"]').content);
    if (workspace) url.searchParams.set('workspace', workspace);
    const ws = new WebSocket(url);
    connections.push(ws);
    let next = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        message.error ? entry.reject(Error(`Fixture RPC failed: ${entry.method}`)) : entry.resolve(message.result);
      } else events.push(message);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Fixture websocket timed out')), 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('Fixture websocket failed')); }, { once: true });
    });
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Fixture RPC timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    await request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'windows-history-probe', version: '1' } });
    return { request, events };
  }
  try {
    const parent = await connect();
    if (pluginPath) return (await parent.request('plugin/install', { path: pluginPath })).plugin.id;
    if (steerOnly) {
      const id = (await parent.request('thread/start', {})).thread.id;
      await parent.request('thread/metadata/update', { threadId: id, title: 'Windows targeted steering', model: 'tui-dev-mock' });
      return { id };
    }
    const prepared = await parent.request('runtime.workspaces.prepare', { workspacePath: projectPath, action: 'create', projectId: 1, deviceId: 'local' });
    await parent.request('runtime.projects.upsert_local', { projectKey: 'windows-history', name: 'Windows history project', roots: [projectPath], deviceId: 'local' });
    const project = await connect(projectPath);
    const ids = [];
    for (let index = 0; index < 5; index++) {
      const id = (await project.request('thread/start', { cwd: projectPath })).thread.id;
      ids.push(id);
      await project.request('thread/metadata/update', { threadId: id, title: `Old conversation ${index}` });
      await project.request('turn/start', { threadId: id, input: [{ type: 'text', text: `WINDOWS_OLD_CONVERSATION_${index}` }] });
      const end = Date.now() + 10000;
      while (!project.events.some(event => event.method === 'turn/completed' && event.params.threadId === id && event.params.turn.status === 'completed')) {
        if (Date.now() > end) throw Error('Fixture turn timed out');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const listed = await project.request('thread/list', {});
    return { ids, canonical: prepared.mapping.workspacePath, paths: listed.threads.filter(thread => ids.includes(thread.id)).map(thread => thread.cwd) };
  } finally {
    for (const ws of connections) ws.close();
  }
}

(async () => {
  let result;
  try {
    if (accountsProbe) {
      let input = '';
      for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw Error('Account input too large'); }
      accountInput = JSON.parse(input);
      if (!/^[a-zA-Z0-9.-]+$/.test(accountInput.host) || !/^qa_[a-f0-9]{16}$/.test(accountInput.testUsername)) throw Error('Invalid account fixture input');
    }
    result = await main();
  }
  catch (error) {
    await captureFailure?.().catch(() => {});
    result = { passed: false, stage, error: error.message, ...(accountsProbe ? { screenText: failureText } : {}),
      diagnostics: appOutput.split('\n').filter(line => /error|fail|panic|timed out/i.test(line) || (accountsProbe && line.includes('[app-server]')))
        .map(line => line.replace(/([?&](?:token|password|key)=)[^&\s]+/gi, '$1[redacted]')).slice(-12) };
    process.exitCode = 1;
  }
  finally {
    clearTimeout(deadline);
    socket?.close();
    stopApp();
    if (app && app.exitCode === null) await new Promise(resolve => { app.once('exit', resolve); setTimeout(resolve, 5000).unref(); });
    if (modelFixture) {
      modelFixture.closeAllConnections();
      await new Promise(resolve => modelFixture.close(resolve));
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.rmSync(root, { recursive: true }); cleaned = !fs.existsSync(root); break; }
      catch { await delay(300); }
    }
    if (!cleaned) process.exitCode = 1;
  }
  console.log(JSON.stringify({ result, cleaned }));
})();
