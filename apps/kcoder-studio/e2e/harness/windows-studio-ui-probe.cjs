// Runs only against a private copy of the installed Electron host and synthetic profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

const [binary, installation, overlay, artifacts] = process.argv.slice(2);
const directInstall = process.argv.includes('--direct-install');
const lifecycleSmoke = process.argv.includes('--lifecycle-smoke');
const lifecycleVerify = process.argv.includes('--lifecycle-verify');
const lifecycleCurrentFeatures = process.argv.includes('--lifecycle-current-features');
const lifecycleModelUrl = directInstall ? process.env.KCODER_E2E_LIFECYCLE_MODEL_URL : null;
if (directInstall && !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(lifecycleModelUrl || '')) throw Error('Owned loopback lifecycle fixture required');
const menuLayoutProbe = process.argv.includes('--menu-layout');
const remoteOAuthProbe = process.argv.includes('--remote-oauth');
const remoteOAuthInput = remoteOAuthProbe ? JSON.parse(fs.readFileSync(path.join(artifacts, 'remote-oauth-input.json'), 'utf8')) : null;
const remoteModelsProbe = process.argv.includes('--remote-models');
const remoteModelsInput = remoteModelsProbe ? JSON.parse(fs.readFileSync(path.join(artifacts, 'remote-models-input.json'), 'utf8')) : null;
const modelScopeProbe = process.argv.includes('--model-scope');
const nativeInputProbe = process.argv.includes('--native-input');
const workflowProbe = process.argv.includes('--workflows');
const pluginsProbe = process.argv.includes('--plugins');
const installedResources = directInstall || process.argv.includes('--installed-resources');
const accountsProbe = process.argv.includes('--accounts');
let accountInput;
const steerProbe = process.argv.includes('--steer');
const historyProbe = directInstall || process.argv.includes('--project-history') || workflowProbe || modelScopeProbe;
if (process.platform !== 'win32' || ![binary, installation, overlay, artifacts].every(Boolean))
  throw Error('An explicit Windows binary, installation, overlay and artifact directory are required');
const root = directInstall ? path.join(artifacts, 'installed-ui-profile') : fs.mkdtempSync(path.join(artifacts, 'studio-ui-'));
if (directInstall) {
  const owner = JSON.parse(fs.readFileSync(path.join(artifacts, '.owner.json'), 'utf8'));
  if (!/^[a-f0-9-]{36}$/.test(owner.owner) || !/^kc_e2e_[a-f0-9]{8}$/.test(owner.username)) throw Error('Owned installer marker required');
  if (!path.resolve(installation).toLowerCase().startsWith(path.resolve(artifacts).toLowerCase() + path.sep)) throw Error('Cannot probe a personal installation directly');
  fs.mkdirSync(root, { recursive: true });
}
let app;
let socket;
let stage = 'prepare';
let appOutput = '';
let cleaned = false;
let captureFailure;
let closeInstalledApp;
let failureText;
let modelFixture;
let modelRequests = 0;
let nativeInputObservations;
let imageRequests = 0;
const wireTrace = [];
const initializeRequests = new Set();
const negotiatedProtocols = [];
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
  const host = directInstall ? installation : path.join(root, 'app');
  const resources = path.join(host, 'resources');
  if (!directInstall) {
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
  } else {
    assert.ok(fs.readFileSync(path.join(resources, 'app.asar')).includes(Buffer.from('KCODER_STUDIO_DESKTOP_USER_DATA_DIR')), 'Installed host must support private profiles');
    assert.ok(fs.readFileSync(binary).equals(fs.readFileSync(path.join(resources, 'bin/kcoder.exe'))));
  }
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
  if (historyProbe && !directInstall) {
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
  if (!directInstall) {
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ active_provider: 'fixture',
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: historyProbe ? `http://127.0.0.1:${modelFixture.address().port}/v1` : 'http://127.0.0.1:1/v1', no_proxy: true,
      default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192 } } }));
  fs.writeFileSync(path.join(profile, 'credentials.json'), JSON.stringify(historyProbe
    ? { fixture: { type: 'api', key: 'synthetic-windows-history-fixture' } } : {}));
  } else if (lifecycleVerify) {
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(saved.providers.fixture.models?.fixture?.extra_body?.temperature ?? saved.providers.fixture.extra_body?.temperature, 0.27, 'Saved model configuration survived upgrade');
    assert.equal(saved.providers.fixture.endpoint, lifecycleModelUrl, 'Model endpoint survived installation unchanged');
  } else {
    assert.ok(!fs.existsSync(path.join(profile, 'settings.json')), 'Seed must start with a fresh owned profile');
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ providers: {} }));
    fs.writeFileSync(path.join(profile, 'credentials.json'), '{}');
  }
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
  if (remoteModelsProbe) {
    env.KCODER_STUDIO_SERVERS = JSON.stringify([...JSON.parse(env.KCODER_STUDIO_SERVERS), remoteModelsInput.server]);
    delete env.PATH;
    env.Path = path.join(artifacts, 'ssh-bin') + ';' + (process.env.Path || process.env.PATH || '');
  }
  if (remoteOAuthProbe) {
    env.KCODER_STUDIO_SERVERS = JSON.stringify([remoteOAuthInput.server]);
    delete env.PATH;
    env.Path = path.join(artifacts, 'ssh-bin') + ';' + (process.env.Path || process.env.PATH || '');
  }
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
        if (directInstall) {
          const key = `${message.params.requestId}:${frame.id}`;
          if (message.method.endsWith('Sent') && frame.method === 'initialize') initializeRequests.add(key);
          if (message.method.endsWith('Received') && initializeRequests.delete(key) && frame.result) {
            const result = frame.result;
            const experimental = Object.fromEntries(Object.entries(result.capabilities?.experimental || {})
              .filter(([name, value]) => /^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(name) && typeof value === 'boolean'));
            negotiatedProtocols.push({ protocolVersion: /^[0-9-]{10}$/.test(result.protocolVersion) ? result.protocolVersion : null,
              serverVersion: /^[0-9A-Za-z.+-]{1,64}$/.test(result.serverInfo?.version) ? result.serverInfo.version : null,
              capabilities: { approvals: result.capabilities?.approvals === true, questions: result.capabilities?.questions === true,
                threadResume: result.capabilities?.threadResume === true, experimental } });
          }
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
  if(directInstall) closeInstalledApp=async()=>{
    await evaluate(`(async()=>{const menus=await window.kcoderDesktopMenu.list('en');for(const menu of menus){const quit=menu.entries?.find(item=>item.id==='quit');if(quit){void window.kcoderDesktopMenu.invoke(menu.index,quit.position);return true}}throw Error('Quit menu unavailable')})()`);
    const end=Date.now()+15000;while(app.exitCode===null&&Date.now()<end)await delay(50);
    if(app.exitCode===null)throw Error('Normal installed application quit did not complete');
  };
  const traceIpc = () => evaluate(`(()=>{const original=window.__TAURI_INTERNALS__.invoke;const entries=[];window.__kcoderProbeIpc=entries;window.__TAURI_INTERNALS__.invoke=async function(command,args){const item={at:Date.now(),command,method:args?.method,taskId:args?.params?.address?.taskId||args?.params?.taskId,state:'pending'};entries.push(item);if(entries.length>150)entries.shift();try{const result=await original.call(this,command,args);item.state='resolved';item.ms=Date.now()-item.at;return result}catch(error){item.state='rejected';item.error=String(error.message).slice(0,180);throw error}};return true})()`);
  const selector = id => `[data-testid="${id}"]`;
  const exists = id => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector(id))}))`);
  const click = async id => {
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector(id))})) && !document.querySelector(${JSON.stringify(selector(id))}).matches(':disabled')`));
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
  if (directInstall) {
    const before = navigation;
    await request('Page.reload');
    await until(() => navigation > before);
  }
  await request('Page.bringToFront');
  await request('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => exists(accountsProbe ? 'kcoder-account-login' : 'desktop-sidebar'));
  if (directInstall) {
    await until(() => negotiatedProtocols.length > 0);
    const negotiated = negotiatedProtocols.at(-1);
    assert.equal(negotiated.protocolVersion, '2026-07-27');
    assert.equal(negotiated.capabilities.approvals, true);
    assert.equal(negotiated.capabilities.questions, true);
    if (lifecycleCurrentFeatures || lifecycleSmoke) {
      for (const capability of ['residentThreads', 'hookConfigurationV1', 'threadCreationReceiptsV1']) {
        assert.equal(negotiated.capabilities.experimental[capability], true, `Actual initialize ${capability}`);
      }
    }
    fs.writeFileSync(path.join(artifacts, 'windows-installed-negotiated-protocol.json'), JSON.stringify(negotiated));
    const evidencePath = path.join(root, 'upgrade-evidence.json');
    const fillControl = async (id, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector(id))});const prototype=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    const rpc = (method, params) => evaluate(`window.__TAURI_INTERNALS__.invoke('local_executor_request',${JSON.stringify({method,params})})`);
    const send = async (text, expectedReplies) => {
      await until(() => evaluate(`document.querySelector('[data-testid="chat-message-input"]')?.getAttribute('contenteditable')==='true'`));
      await evaluate(`document.querySelector('[data-testid="chat-message-input"]').focus();true`);
      await request('Input.insertText',{text});
      await until(()=>evaluate(`document.querySelector('[data-testid="send-message-button"]')?.disabled===false`));
      await click('send-message-button');
      await until(()=>evaluate(`[...document.querySelectorAll('[data-testid="message-assistant"]')].filter(node=>node.innerText.includes('WINDOWS_HISTORY_REPLY')).length>=${expectedReplies} && ![...document.querySelectorAll('[data-testid="pause-response-button"]')].some(node=>node.getClientRects().length)`),30000);
    };
    if (!lifecycleVerify) {
      stage='installed-create-model-without-key';
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile,'credentials.json'),'utf8')),{});
      await navigate('/settings/personal/models','provider-new');await click('provider-new');
      await until(()=>exists('provider-id'));
      await fillControl('provider-id','fixture');await fillControl('provider-model','fixture');
      await fillControl('provider-endpoint',lifecycleModelUrl);
      await fillControl('provider-format','openai_chat_completions');await fillControl('provider-authentication','none');
      await fillControl('provider-extra-body','{"temperature":0.27}');
      if(!(await evaluate(`document.querySelector('[data-testid="provider-default"]').checked`)))await click('provider-default');
      await click('provider-save');
      await until(()=>Boolean(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).providers?.fixture));
      stage='installed-two-user-turns';
      await navigate('/','project-new-conversation-button');await click('project-new-conversation-button');
      await send('INSTALL_LIFECYCLE_FIRST',1);await send('INSTALL_LIFECYCLE_SECOND',2);
      const taskId=await evaluate(`new URL(location.href).searchParams.get('taskId')`);
      assert.ok(taskId,'Created conversation must expose its durable address');
      const lifecycleRequests=(await (await fetch(lifecycleModelUrl.replace(/\/v1$/,'')+'/metrics')).json()).requests;
      assert.ok(lifecycleRequests.length>=2&&lifecycleRequests.every(body=>body.temperature===0.27),'Saved model body used by actual requests');
      if(lifecycleSmoke){
        const origin=await evaluate('location.origin');
        fs.writeFileSync(evidencePath,JSON.stringify({taskId,workspace,origin,expectedTemperature:0.27}));
        await screenshot('windows-installed-fresh-smoke.png');
        return {passed:true,actualInstalledResources:true,negotiatedProtocol:negotiated,noExistingKey:true,modelSavedThroughUI:true,twoRepliesVisible:true,smokeOnly:true};
      }
      await navigate('/settings/appearance','appearance-mode-dark');await click('appearance-mode-dark');
      await until(()=>evaluate(`document.documentElement.dataset.theme==='dark'`));
      const retainedTarget={id:'upgrade-target',label:'Upgrade retained target',description:'Owned upgrade fixture',runtime:'kcoder',transport:'local',command:path.join(resources,'bin/kcoder.exe'),workspace};
      await evaluate(`fetch('/api/servers/upgrade-target',{method:'PUT',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(retainedTarget))}}).then(async response=>{if(!response.ok)throw Error('Target save failed');return response.json()})`);
      const plugin=path.join(root,'upgrade-plugin');fs.mkdirSync(path.join(plugin,'.claude-plugin'),{recursive:true});
      fs.mkdirSync(path.join(plugin,'skills','upgrade-preserved'),{recursive:true});
      fs.writeFileSync(path.join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'upgrade-preserved',version:'1.0.0',description:'Owned upgrade retention fixture'}));
      fs.writeFileSync(path.join(plugin,'skills','upgrade-preserved','SKILL.md'),'---\nname: upgrade-preserved\ndescription: Owned upgrade fixture\n---\nPreserve this fixture.\n');
      fs.mkdirSync(path.join(plugin,'hooks'),{recursive:true});
      fs.mkdirSync(path.join(plugin,'scripts with spaces'),{recursive:true});
      fs.writeFileSync(path.join(plugin,'scripts with spaces','marker.sh'),'#!/usr/bin/env bash\nprintf x >> windows-plugin-hook-count\n');
      fs.writeFileSync(path.join(plugin,'hooks','hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'bash "${CLAUDE_PLUGIN_ROOT}/scripts with spaces/marker.sh"',timeout:15}]}]}}));
      const pluginId=await evaluate(`(${seedProjectHistory.toString()})('',false,${JSON.stringify(plugin)})`);
      const origin=await evaluate('location.origin');
      assert.equal(await evaluate(`JSON.parse(localStorage.getItem('wework.appearance')).mode`),'dark');
      fs.writeFileSync(evidencePath,JSON.stringify({taskId,workspace,pluginId,origin,targetId:'upgrade-target',expectedTemperature:0.27}));
      await navigate('/plugins/manage','kcoder-plugin-management');
      await until(()=>evaluate(`document.body.innerText.includes('upgrade-preserved')`));
      stage='installed-plugin-new-session-hook';
      await navigate('/','project-new-conversation-button');await click('project-new-conversation-button');
      await send('INSTALL_LIFECYCLE_PLUGIN_HOOK',1);
      assert.equal(fs.readFileSync(path.join(workspace,'windows-plugin-hook-count'),'utf8'),'x','Actual installed Windows Hook expands plugin root and executes a path with spaces');
      await screenshot('windows-installed-seed.png');
      return {passed:true,actualInstalledResources:true,negotiatedProtocol:negotiated,noExistingKey:true,modelSavedThroughUI:true,twoRepliesVisible:true,pluginInstalled:true,pluginHookExecuted:true,retainedTarget:true,themeSaved:true};
    }
    stage='installed-upgrade-restoration';
    const saved=JSON.parse(fs.readFileSync(evidencePath,'utf8'));
    assert.equal(await evaluate('location.origin'),saved.origin,'Desktop origin retained across restart');
      if(lifecycleSmoke){
      await navigate('/runtime-tasks?'+new URLSearchParams({deviceId:'local',taskId:saved.taskId,workspacePath:workspace}),'chat-message-input');
      await until(()=>evaluate(`[...document.querySelectorAll('[data-testid="message-user"]')].some(node=>node.innerText.includes('INSTALL_LIFECYCLE_FIRST')) && [...document.querySelectorAll('[data-testid="message-user"]')].some(node=>node.innerText.includes('INSTALL_LIFECYCLE_SECOND'))`));
      await send('INSTALL_LIFECYCLE_REOPEN',3);
      const box=await evaluate(`(()=>{const row=[...document.querySelectorAll('[data-testid^="runtime-local-task-row-"]')].find(node=>node.getClientRects().length);if(!row)return null;const r=row.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      assert.ok(box,'Owned conversation row is visible');
      await request('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});
      await delay(250);
      const geometry=await evaluate(`(()=>{const row=[...document.querySelectorAll('[data-testid^="runtime-local-task-row-"]')].find(node=>node.getClientRects().length);const title=row.firstElementChild.getBoundingClientRect(),status=row.querySelector('[role="status"]')?.getBoundingClientRect(),actions=row.querySelector('[data-testid^="runtime-local-task-hover-actions-"]')?.getBoundingClientRect(),r=row.getBoundingClientRect();return {titleRight:title.right,statusLeft:status?.left,statusRight:status?.right,actionsLeft:actions?.left,actionsRight:actions?.right,actionsWidth:actions?.width,rowRight:r.right}})()`);
      assert.ok(geometry.actionsWidth>=71 && geometry.actionsRight<=geometry.rowRight+1);
      assert.ok(geometry.titleRight<=(geometry.statusLeft??geometry.actionsLeft)+1);
      if(geometry.statusRight!==undefined)assert.ok(geometry.statusRight<=geometry.actionsLeft+1);
      fs.writeFileSync(path.join(artifacts,'windows-installed-hover-geometry.json'),JSON.stringify(geometry));
      await screenshot('windows-installed-reopened-smoke.png');
      return {passed:true,actualInstalledResources:true,negotiatedProtocol:negotiated,historyRestored:true,modelBodyRetained:true,hoverGeometryVerified:true,smokeOnly:true};
    }
    await until(()=>evaluate(`document.documentElement.dataset.theme==='dark'`));
    const targets=await evaluate(`fetch('/api/servers').then(response=>response.json()).then(value=>value.servers.map(item=>({id:item.id,label:item.label})))`);
    assert.ok(targets.some(item=>item.id===saved.targetId&&item.label==='Upgrade retained target'));
    const inventory=await rpc('runtime.plugins.request',{deviceId:'local',workspacePath:workspace,method:'plugin/list',params:{all:true}});
    assert.ok(inventory.plugins.some(plugin=>plugin.id===saved.pluginId),'Installed extension survived upgrade');
    await navigate('/runtime-tasks?'+new URLSearchParams({deviceId:'local',taskId:saved.taskId,workspacePath:workspace}),'chat-message-input');
    await until(()=>evaluate(`[...document.querySelectorAll('[data-testid="message-user"]')].some(node=>node.innerText.includes('INSTALL_LIFECYCLE_FIRST')) && [...document.querySelectorAll('[data-testid="message-user"]')].some(node=>node.innerText.includes('INSTALL_LIFECYCLE_SECOND'))`));
    await until(()=>evaluate(`[...document.querySelectorAll('[data-testid="message-assistant"]')].filter(node=>node.innerText.includes('WINDOWS_HISTORY_REPLY')).length>=2`));
    const replies=await evaluate(`[...document.querySelectorAll('[data-testid="message-assistant"]')].filter(node=>node.innerText.includes('WINDOWS_HISTORY_REPLY')).length`);
    await send('INSTALL_LIFECYCLE_AFTER_UPGRADE',replies+1);
    const restoredRequests=(await (await fetch(lifecycleModelUrl.replace(/\/v1$/,'')+'/metrics')).json()).requests;
    assert.equal(restoredRequests.at(-1).temperature,0.27,'Restored model body used after restart');
    await screenshot('windows-installed-restored.png');
    stage='installed-upgraded-plugin-new-session-hook';
    const hookCountBefore=fs.readFileSync(path.join(workspace,'windows-plugin-hook-count'),'utf8').length;
    await navigate('/','project-new-conversation-button');await click('project-new-conversation-button');
    await send('INSTALL_LIFECYCLE_RESTORED_PLUGIN_HOOK',1);
    assert.equal(fs.readFileSync(path.join(workspace,'windows-plugin-hook-count'),'utf8').length,hookCountBefore+1,'Retained plugin Hook executes exactly once in a new conversation');
    await screenshot('windows-installed-plugin-hook.png');
    if(lifecycleCurrentFeatures){
      stage='installed-windows-directory-trust';
      const trustSource=path.join(root,'windows trust market');
      const trustFile=path.join(profile,'trusted-folders.json');
      const normalizeOwnedPath=value=>path.resolve(value.startsWith('\\\\?\\')?value.slice(4):value).toLowerCase();
      const trustContains=(field)=>JSON.parse(fs.readFileSync(trustFile,'utf8'))[field]?.some(value=>normalizeOwnedPath(value)===normalizeOwnedPath(trustSource));
      if(!saved.windowsDirectoryTrustVerified){
        fs.mkdirSync(path.join(trustSource,'.claude-plugin'),{recursive:true});
        fs.writeFileSync(path.join(trustSource,'.claude-plugin','marketplace.json'),JSON.stringify({name:'windows-owned-trust',owner:{name:'Fixture'},plugins:[]}));
        const trustBefore=fs.existsSync(trustFile)?fs.readFileSync(trustFile,'utf8'):null;
        stage='installed-windows-directory-workspace-selection';
        await rpc('runtime.projects.upsert_local',{projectKey:'windows-owned-directory-selection',name:'Windows directory fixture',roots:[workspace],deviceId:'local'});
        let reloaded=false;const onReload=event=>{try{if(JSON.parse(event.data).method==='Page.loadEventFired')reloaded=true}catch{}};
        socket.addEventListener('message',onReload);
        try{await request('Page.reload');await until(()=>reloaded,30000)}finally{socket.removeEventListener('message',onReload)}
        await until(()=>exists('desktop-sidebar'));
        await navigate('/','project-work-button');await click('project-work-button');
        await until(()=>evaluate(`[...document.querySelectorAll('[data-testid^="project-option-"]')].some(button=>button.textContent.includes('Windows directory fixture'))`));
        await evaluate(`[...document.querySelectorAll('[data-testid^="project-option-"]')].find(button=>button.textContent.includes('Windows directory fixture')).click();true`);
        await until(()=>evaluate(`document.querySelector('[data-testid="project-work-button"]')?.textContent.includes('Windows directory fixture')`));
        await navigate('/plugins','plugins-marketplace-selector');
        await until(()=>evaluate(`document.querySelector('[data-testid="plugins-install-target"]')?.textContent.includes(${JSON.stringify(workspace)})`));
        stage='installed-windows-directory-browse';
        await click('plugins-add-marketplace-button');await click('plugins-add-custom-marketplace-button');
        await click('plugins-marketplace-browse-directory');await until(()=>exists('device-folder-path-input'));
        await fillControl('device-folder-path-input',root+path.sep);
        await evaluate(`(()=>{const input=document.querySelector('[data-testid="device-folder-path-input"]');input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`);
        await until(()=>evaluate(`[...document.querySelectorAll('[data-testid="device-folder-entry-button"]')].some(button=>button.textContent.trim()==='windows trust market')`));
        await evaluate(`[...document.querySelectorAll('[data-testid="device-folder-entry-button"]')].find(button=>button.textContent.trim()==='windows trust market').click();true`);
        await click('confirm-device-folder-picker-button');
        assert.equal(normalizeOwnedPath(await evaluate(`document.querySelector('[data-testid="plugins-marketplace-path-input"]').value`)),normalizeOwnedPath(trustSource));
        assert.equal(await evaluate(`document.querySelector('[data-testid="plugins-marketplace-trust-directory"]').checked`),false);
        assert.equal(fs.existsSync(trustFile)?fs.readFileSync(trustFile,'utf8'):null,trustBefore,'Directory selection alone must not authorize');
        stage='installed-windows-directory-explicit-trust';
        await click('plugins-marketplace-trust-directory');await click('plugins-marketplace-save-button');
        await until(()=>!fs.existsSync(trustFile)?false:trustContains('trusted'));
        await until(async()=>!(await exists('plugins-marketplace-config-dialog')));
        await click('plugins-trust-manage-button');await until(()=>exists('plugin-trust-manager'));
        const trustAction=async action=>{
          await until(async()=>!(await exists('plugin-trust-confirm')));
          await until(()=>evaluate(`(()=>{const button=[...document.querySelectorAll('[data-testid="plugin-trust-entry"]')].find(entry=>entry.textContent.includes('windows trust market'))?.querySelector('[data-testid="plugin-trust-${action}"]');return Boolean(button&&!button.disabled)})()`));
          await evaluate(`[...document.querySelectorAll('[data-testid="plugin-trust-entry"]')].find(entry=>entry.textContent.includes('windows trust market')).querySelector('[data-testid="plugin-trust-${action}"]').click();true`);
          await until(()=>exists('plugin-trust-confirm'));
        };
        stage='installed-windows-directory-revoke';
        const beforeRevoke=fs.readFileSync(trustFile,'utf8');await trustAction('revoke');
        assert.equal(fs.readFileSync(trustFile,'utf8'),beforeRevoke,'Trust confirmation precedes mutation');
        await click('plugin-trust-apply');await until(()=>trustContains('revoked_defaults'));
        stage='installed-windows-directory-never';await trustAction('never');await click('plugin-trust-apply');await until(()=>trustContains('never'));
        stage='installed-windows-directory-restore';await trustAction('trust');await click('plugin-trust-apply');await until(()=>trustContains('trusted')&&!trustContains('never'));
        await screenshot('windows-installed-directory-trust.png');
        saved.windowsDirectoryTrustVerified=true;fs.writeFileSync(evidencePath,JSON.stringify(saved));
      }else assert.equal(trustContains('trusted'),true,'Explicit Windows directory decision survived restart');
    }
    return {passed:true,actualInstalledResources:true,negotiatedProtocol:negotiated,historyRestored:true,modelBodyRetained:true,themeRetained:true,targetRetained:true,pluginRetained:true,pluginHookExecuted:true,...(lifecycleCurrentFeatures?{windowsDirectoryTrustVerified:true}:{})};
  }
  if (menuLayoutProbe) {
    stage = 'menu-layout';
    const geometry = await evaluate(`(()=>{const e=document.querySelector('[data-testid="desktop-menu-bar"]');return {clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,buttons:[...e.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height)}})()`);
    assert.ok(geometry.scrollHeight<=geometry.clientHeight);
    assert.ok(geometry.scrollWidth<=geometry.clientWidth);
    assert.ok(geometry.buttons.every(height=>height<=28));
    await click('chat-message-input');
    const press=async(key,code,value)=>{await request('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:value});await request('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:value});};
    await press('F10','F10',121);
    assert.equal(await evaluate('document.activeElement.dataset.testid'),'desktop-menu-0');
    await press('ArrowRight','ArrowRight',39);
    assert.equal(await evaluate('document.activeElement.dataset.testid'),'desktop-menu-1');
    await press('Escape','Escape',27);
    assert.equal(await evaluate('document.activeElement.dataset.testid'),'chat-message-input');
    await click('desktop-menu-0');
    await until(()=>evaluate(`Boolean(document.querySelector('[role="menu"]'))`));
    await screenshot('windows-menu-layout.png');
    await press('Escape','Escape',27);
    return {passed:true,menuLayout:true,geometry,keyboardFocusReturned:true};
  }
  if (remoteOAuthProbe) {
    stage = 'remote-oauth-failure';
    await navigate('/plugins/manage', 'kcoder-plugin-tab-mcp');
    await until(() => evaluate(`document.querySelector('[data-testid="plugins-install-target"]')?.textContent.includes(${JSON.stringify(remoteOAuthInput.workspace)})`));
    await click('kcoder-plugin-tab-mcp');
    await until(() => exists('kcoder-mcp-auth-action'));
    // Suppress only the user's default external opener; exercise the actual link
    // in a separate Windows Edge process with an owned browser profile below.
    await evaluate(`(()=>{const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(command,args)=>command==='plugin:opener|open_url'?Promise.resolve():original(command,args);window.open=()=>null;return true})()`);
    await click('kcoder-mcp-auth-action');
    await until(() => exists('kcoder-mcp-open-authorization'));
    const authorizationUrl = await evaluate(`document.querySelector('[data-testid="kcoder-mcp-open-authorization"]').href`);
    assert.equal(new URL(new URL(authorizationUrl).searchParams.get('redirect_uri')).origin, base, 'callback must be Windows local Gateway');
    const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync);
    assert.ok(edge, 'Windows Edge is required');
    const browser = spawnSync(edge, ['--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${path.join(root,'oauth-edge-profile')}`,'--dump-dom',authorizationUrl], {windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    assert.equal(browser.status,0,'Owned Windows browser must complete');
    assert.ok(browser.stdout.includes('credential_storage_failed'),'browser must report remote save failure');
    await until(() => evaluate(`document.querySelector('[data-testid="kcoder-mcp-management"]')?.textContent.includes('授权凭据未能保存到此目标')`));
    assert.ok(!fs.existsSync(path.join(profile,'mcp-oauth')), 'remote authorization must not write Windows credentials');
    await screenshot('windows-remote-oauth-failure.png');
    stage = 'remote-oauth-retry';
    await click('kcoder-mcp-auth-action');
    await until(() => exists('kcoder-mcp-open-authorization'));
    const retryUrl = await evaluate(`document.querySelector('[data-testid="kcoder-mcp-open-authorization"]').href`);
    assert.equal(new URL(new URL(retryUrl).searchParams.get('redirect_uri')).origin, base);
    const retryBrowser = spawnSync(edge, ['--headless=new','--disable-gpu','--no-first-run',`--user-data-dir=${path.join(root,'oauth-retry-profile')}`,'--dump-dom',retryUrl], {windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    assert.equal(retryBrowser.status,0);
    assert.ok(retryBrowser.stdout.includes('授权已保存'));
    await until(() => evaluate(`document.querySelector('[data-testid="kcoder-mcp-management"]')?.textContent.includes('注销授权')`));
    assert.ok(!fs.existsSync(path.join(profile,'mcp-oauth')));
    await screenshot('windows-remote-oauth-recovered.png');
    return {passed:true,remoteOAuthSaveFailure:true,windowsBrowser:true,callbackLocalToWindows:true,localCredentialStoreUntouched:true,retrySameRemoteTarget:true};
  }
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
  if (remoteModelsProbe) {
    const beforeLocal = fs.readFileSync(path.join(profile, 'settings.json'), 'utf8');
    const beforeCredentials = fs.readFileSync(path.join(profile, 'credentials.json'), 'utf8');
    stage = 'remote-model-settings';
    await navigate('/settings/personal/models', 'provider-target');
    await until(() => evaluate(`!document.querySelector('[data-testid="provider-target"]')?.disabled && Boolean(document.querySelector('[data-testid="provider-target"] option[value="remote-models"]')) && Boolean(document.querySelector('[data-testid^="provider-edit-fixture"]'))`));
    await evaluate(`(() => {const e=document.querySelector('[data-testid="provider-target"]');e.value='remote-models';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(() => exists('provider-edit-remote::remote-model'));
    await click('provider-edit-remote::remote-model');
    await evaluate(`(() => {const e=document.querySelector('[data-testid="provider-extra-body"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'{"temperature":0.6}');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('provider-save');
    await until(() => evaluate(`[...document.querySelectorAll('[role="status"]')].some(e=>e.textContent.includes('下一轮'))`), 30000);
    assert.equal(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'), beforeLocal);
    assert.equal(fs.readFileSync(path.join(profile, 'credentials.json'), 'utf8'), beforeCredentials);
    assert.deepEqual(JSON.parse(beforeCredentials), {}, 'Windows has no model credential');
    stage = 'remote-model-chat';
    await evaluate(`window.__TAURI_INTERNALS__.invoke('local_executor_request',{method:'runtime.projects.upsert_local',params:{deviceId:'remote-models',projectKey:'windows-remote-model',name:'WINDOWS_REMOTE_MODEL_PROJECT',roots:[${JSON.stringify(remoteModelsInput.workspace)}]}})`);
    await navigate('/', 'desktop-sidebar');
    await until(() => evaluate(`[...document.querySelectorAll('[data-testid="project-item"]')].some(e=>e.textContent.includes('WINDOWS_REMOTE_MODEL_PROJECT'))`));
    await evaluate(`[...document.querySelectorAll('[data-testid="project-item"]')].find(e=>e.textContent.includes('WINDOWS_REMOTE_MODEL_PROJECT')).querySelector('[data-testid="project-new-conversation-button"]').click()`);
    await until(() => exists('chat-message-input'));
    await click('chat-message-input');
    await request('Input.insertText', { text: 'WINDOWS_REMOTE_MODEL_MESSAGE' });
    await until(() => evaluate(`document.querySelector('[data-testid="send-message-button"]')?.disabled===false`));
    await click('send-message-button');
    await until(() => evaluate(`document.body.innerText.includes('WINDOWS_REMOTE_MODEL_DONE')`), 30000);
    assert.equal(fs.readFileSync(path.join(profile, 'credentials.json'), 'utf8'), beforeCredentials);
    await screenshot('windows-remote-model.png');
    await until(() => evaluate(`!document.querySelector('[data-testid="pause-response-button"]')`));
    await click('chat-message-input');
    const composerPoint = await evaluate(`(() => { const r=document.querySelector('[data-testid="chat-message-input"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await request('Input.dispatchMouseEvent', {type:'mousePressed',...composerPoint,button:'left',clickCount:1});
    await request('Input.dispatchMouseEvent', {type:'mouseReleased',...composerPoint,button:'left',clickCount:1});
    await request('Input.insertText', { text: 'WINDOWS_REMOTE_FAILURE' });
    await until(() => evaluate(`document.querySelector('[data-testid="send-message-button"]')?.disabled===false`));
    await click('send-message-button');
    await until(() => evaluate(`document.body.innerText.includes('HTTP 400')`), 30000);
    assert.equal(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'), beforeLocal);
    assert.equal(fs.readFileSync(path.join(profile, 'credentials.json'), 'utf8'), beforeCredentials);
    await screenshot('windows-remote-model-failure.png');
    return {passed:true, remoteFailureVisible:true, remoteSave:true, remoteConversation:true, windowsCredentialsEmpty:true, windowsSettingsUnchanged:true};
  }
  if (modelScopeProbe) {
    const fill = async (id, value) => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector(id))}); const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    const focusComposer = async () => {
      const point = await evaluate(`(() => {const e=document.querySelector('[data-testid="chat-message-input"]'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await request('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
      await request('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const native = (action, extra = []) => {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(__dirname, 'windows-owned-input.ps1'), '-ProcessId', String(app.pid), '-OwnedRoot', root,
          '-Action', action, ...extra], { encoding: 'utf8', timeout: 20000, windowsHide: true });
        if (result.status !== 0) throw new Error(`Owned native input failed (${action}): ${String(result.stderr).slice(-1000)}`);
        return JSON.parse(result.stdout.trim());
      };
    const nativeFocus = async id => {
      const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector(id))});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round((r.x+r.width/2)*devicePixelRatio),y:Math.round((r.y+r.height/2)*devicePixelRatio)};})()`);
      native('focus', ['-X',String(point.x),'-Y',String(point.y)]);
    };
    const modelBody = model => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).providers.fixture.models?.[model]?.extra_body;
    stage = 'model-scope-settings';
    await navigate('/settings/personal/models', 'provider-new');
    await until(() => evaluate(`Boolean(document.querySelector('[data-testid^="provider-edit-fixture"]'))`));
    await evaluate(`document.querySelector('[data-testid^="provider-edit-fixture"]').click()`);
    await fill('provider-extra-body', '{"temperature":0.2}');
    await click('provider-save');
    await until(() => modelBody('fixture')?.temperature === 0.2, 30000);
    await until(() => evaluate(`!document.querySelector('[data-testid="provider-save"]').disabled`));
    await click('provider-add-model-fixture');
    assert.equal(await evaluate(`document.querySelector('[data-testid="provider-extra-body"]').value`), '');
    await fill('provider-model', 'fixture-second');
    await fill('provider-extra-body', '{"temperature":0.7}');
    await click('provider-save');
    await until(() => modelBody('fixture-second')?.temperature === 0.7, 30000);
    await until(() => evaluate(`!document.querySelector('[data-testid="provider-save"]').disabled`));
    assert.equal(modelBody('fixture').temperature, 0.2);
    stage = 'model-scope-focus';
    await click('settings-back-button');
    await until(() => exists('chat-message-input'));
    if(nativeInputProbe){await request('Emulation.setFocusEmulationEnabled',{enabled:false});await nativeFocus('chat-message-input');native('text',['-Text','model scope fixture reply']);}
    else {await focusComposer();await request('Input.insertText', { text: 'model scope fixture reply' });}
    assert.ok(await evaluate(`document.querySelector('[data-testid="chat-message-input"]').innerText.includes('model scope fixture reply')`));
    if(nativeInputProbe)await nativeFocus('send-message-button');else await click('send-message-button');
    await until(() => evaluate(`document.body.innerText.includes('WINDOWS_HISTORY_REPLY')`), 30000);
    if(nativeInputProbe)await nativeFocus('chat-message-input');else await focusComposer();
    if(nativeInputProbe)native('text',['-Text','focus-after-reply']);else await request('Input.insertText', { text: 'focus-after-reply' });
    assert.ok(await evaluate(`document.querySelector('[data-testid="chat-message-input"]').innerText.includes('focus-after-reply')`));
    if (nativeInputProbe) {
      await request('Emulation.setFocusEmulationEnabled', { enabled: false });
      stage = 'model-scope-native-focus';
      const point = await evaluate(`(() => {const e=document.querySelector('[data-testid="chat-message-input"]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round((r.x+r.width/2)*devicePixelRatio),y:Math.round((r.y+r.height/2)*devicePixelRatio)};})()`);
      native('focus', ['-X',String(point.x),'-Y',String(point.y)]);
      native('text', ['-Text','native-owned-focus']);
      await until(() => evaluate(`document.querySelector('[data-testid="chat-message-input"]').innerText.includes('native-owned-focus')`));
      const beforeNativeIme = modelRequests;
      stage = 'model-scope-native-ime';
      await evaluate(`(() => {window.__nativeComposition={starts:0,ends:0,trusted:true,active:false,key229:0,trustedKey229:0,untrustedCodes:[],keyEvents:0};const editor=document.querySelector('[data-testid="chat-message-input"]');editor.addEventListener('keydown',event=>{window.__nativeComposition.keyEvents++;window.__nativeComposition.trusted&&=event.isTrusted;if(!event.isTrusted)window.__nativeComposition.untrustedCodes.push(event.keyCode);if(event.keyCode===229){window.__nativeComposition.key229++;if(event.isTrusted)window.__nativeComposition.trustedKey229++}});editor.addEventListener('compositionstart',event=>{window.__nativeComposition.starts++;window.__nativeComposition.active=true;window.__nativeComposition.trusted&&=event.isTrusted});editor.addEventListener('compositionend',event=>{window.__nativeComposition.ends++;window.__nativeComposition.active=false;window.__nativeComposition.trusted&&=event.isTrusted});})()`);
      const typeChinese = async () => {
        const beforeKeys = await evaluate(`window.__nativeComposition.keyEvents`);
        native('pinyin', ['-Text','nihao']);
        native('space');
        await until(()=>evaluate(`window.__nativeComposition.keyEvents>=${beforeKeys+6}`));
        await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        return evaluate(`/[\\u3400-\\u9fff]/.test(document.querySelector('[data-testid="chat-message-input"]').innerText)`);
      };
      stage = 'model-scope-native-chinese-commit';
      let chineseCommitted = await typeChinese();
      if(!chineseCommitted){native('backspace',['-Text','6']);native('toggle-ime');chineseCommitted=await typeChinese();}
      if(!chineseCommitted)throw new Error('Native input method did not commit Chinese: '+JSON.stringify(await evaluate(`({...window.__nativeComposition,documentFocused:document.hasFocus(),editorFocused:document.querySelector('[data-testid="chat-message-input"]').contains(document.activeElement)})`)));
      assert.equal(modelRequests,beforeNativeIme,'native candidate selection must not send');
      const beforeEnterKeys = await evaluate(`window.__nativeComposition.keyEvents`);
      native('pinyin', ['-Text','nihao']);
      await until(()=>evaluate(`window.__nativeComposition.keyEvents>=${beforeEnterKeys+5}`));
      stage = 'model-scope-native-enter-complete';
      native('enter');
      await until(()=>evaluate(`window.__nativeComposition.keyEvents>=${beforeEnterKeys+6}`));
      assert.ok(await evaluate(`window.__nativeComposition.key229>=5`),'Windows input method must handle the pinyin keys');
      nativeInputObservations=await evaluate(`window.__nativeComposition`);
      assert.ok(nativeInputObservations.trustedKey229>=5,'Native IME must produce trusted process-key events');
      assert.equal(modelRequests,beforeNativeIme,'native composition Enter must not send');
      assert.ok(await evaluate(`document.querySelector('[data-testid="chat-message-input"]').contains(document.activeElement)`));
      await screenshot('windows-model-scope-and-focus.png');
      return {passed:true,modelScopedBodies:true,focusRestored:true,compositionEnterDoesNotSubmit:true,nativeWindowsMouse:true,nativeWindowsIme:true,manualCandidateWindow:false,nativeCandidateCommit:true,nativeComposition:await evaluate(`window.__nativeComposition`),modelRequests};
    }
    stage = 'model-scope-composition';
    const requestsBeforeComposition = modelRequests;
    await request('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4,
      replacementStart: 0, replacementEnd: 'focus-after-reply'.length });
    await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await request('Input.insertText', { text: '中文输入' });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(modelRequests, requestsBeforeComposition, 'composition Enter must not submit a model request');
    assert.ok(await evaluate(`document.querySelector('[data-testid="chat-message-input"]').innerText.includes('中文输入')`));
    assert.ok(await evaluate(`document.querySelector('[data-testid="chat-message-input"]').contains(document.activeElement)`));
    await screenshot('windows-model-scope-and-focus.png');
    return { passed: true, modelScopedBodies: true, newModelStartsEmpty: true, originalModelUnchanged: true, reply: true, focusRestored: true, compositionEnterDoesNotSubmit: true, modelRequests };
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
    result = { passed: false, stage, error: error.message, ...(nativeInputObservations ? {nativeInputObservations} : {}), ...(accountsProbe ? { screenText: failureText } : {}),
      diagnostics: appOutput.split('\n').filter(line => /error|fail|panic|timed out/i.test(line) || (accountsProbe && line.includes('[app-server]')))
        .map(line => line.replace(/([?&](?:token|password|key)=)[^&\s]+/gi, '$1[redacted]')).slice(-12) };
    process.exitCode = 1;
  }
  finally {
    clearTimeout(deadline);
    if(directInstall&&result?.passed&&closeInstalledApp){try{await closeInstalledApp()}catch(error){result={...result,passed:false,shutdownError:error.message};process.exitCode=1}}
    socket?.close();
    if (nativeInputProbe && app?.pid && fs.existsSync(path.join(root, 'native-input-foreground.json'))) {
      const restored = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'windows-owned-input.ps1'), '-ProcessId', String(app.pid), '-OwnedRoot', root,
        '-Action', 'restore'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (restored.status !== 0 || JSON.parse(restored.stdout.trim() || '{}').restored !== true) { result = {...result, passed:false, error:'Native input foreground restoration failed'};process.exitCode=1; }
    }
    stopApp();
    if (app && app.exitCode === null) await new Promise(resolve => { app.once('exit', resolve); setTimeout(resolve, 5000).unref(); });
    if (modelFixture) {
      modelFixture.closeAllConnections();
      await new Promise(resolve => modelFixture.close(resolve));
    }
    if (directInstall) cleaned = !app || app.exitCode !== null;
    for (let attempt = 0; !directInstall && attempt < 10; attempt++) {
      try { fs.rmSync(root, { recursive: true }); cleaned = !fs.existsSync(root); break; }
      catch { await delay(300); }
    }
    if (!cleaned) process.exitCode = 1;
  }
  console.log(JSON.stringify({ result, cleaned, ...(directInstall ? { fixtureStateRetained: true } : {}) }));
})();
