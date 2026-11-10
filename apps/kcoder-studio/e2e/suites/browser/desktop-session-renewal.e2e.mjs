import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { openRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'desktop-auth-renewal-and-expiry-recovery', tier: 'full-integration',
  modelPolicy: 'Real isolated Electron/Gateway session lifetime and navigation; no model calls',
}, async context => {
  const windows = process.platform === 'win32';
  if (windows) assert.notEqual(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1');
  else assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1');
  const xvfb = windows ? null : await requireExecutable('/usr/bin/xvfb-run', 'Xvfb');
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN || resolve(appRoot, 'node_modules/electron/dist/electron'), 'Electron');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'session-renewal' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {});
  const serversFile = await context.writeStateJson('servers.jsonc', [
    { id: 'local', label: 'Renewal fixture', transport: 'local', command: binary, workspace: workspace.path },
  ]);
  const environment = context.isolatedEnvironment({
      KCODER_E2E_AUTH_OBSERVE: '1',
      KCODER_CONFIG_DIR: profile, KCODER_STUDIO_SERVERS_FILE: serversFile,
      KCODER_STUDIO_WORKSPACE: workspace.path, KCODER_STUDIO_KCODER_BIN: binary,
      KCODER_STUDIO_WEB_ROOT: resolve(appRoot, 'renderer/dist'),
      KCODER_STUDIO_AUTH_SESSION_TTL_MS: windows ? '3000' : '2000',
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState('electron-profile'),
      ...(windows ? {
        APPDATA: context.pathInState('home/AppData/Roaming'),
        LOCALAPPDATA: context.pathInState('home/AppData/Local'),
        TEMP: context.pathInState('tmp'), TMP: context.pathInState('tmp'),
      } : {}),
    });
  if (windows) {
    const directories = [environment.USERPROFILE, environment.APPDATA, environment.LOCALAPPDATA,
      environment.TEMP, ...['Downloads','Desktop','Documents'].map(leaf => join(environment.USERPROFILE,leaf))];
    for (const directory of directories) await mkdir(directory,{recursive:true});
    const literal = value => "'" + value.replaceAll("'","''") + "'";
    const script = '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;@(' + directories.map(literal).join(',') + ')|ForEach-Object{@{exists=Test-Path -LiteralPath $_;ownerMatchesCurrent=((Get-Acl -LiteralPath $_).GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid);reparse=[bool]((Get-Item -LiteralPath $_).Attributes -band [IO.FileAttributes]::ReparsePoint)}}|ConvertTo-Json -Compress';
    const folderSummary = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}));
    await context.writeArtifactJson('windows-desktop-folder-owner.json',{folderSummary});
    assert.ok(folderSummary.every(item=>item.exists && item.ownerMatchesCurrent && !item.reparse));
    const files = {};
    for (const [label,file] of Object.entries({electron,main:resolve(appRoot,'desktop/main.mjs'),renewal:resolve(appRoot,'desktop/session-renewal.mjs'),binary})) {
      const hash = createHash('sha256');for await (const chunk of createReadStream(file)) hash.update(chunk);
      files[label] = hash.digest('hex');
    }
    await context.writeArtifactJson('windows-desktop-prerequisites.json',{folderSummary,files,ttlMs:3000,osSandboxRequired:true});
  }
  const draftSamples = [];
  const phases = { desktop_session: [], gateway_session: [] };
  let phaseBuffer = '', droppedPhases = 0;
  const phaseSnapshot = () => ({ phases, droppedPhases });
  context.addCleanup('persist final auth phase observations', () =>
    context.writeArtifactJsonInternal('auth-observation-phases-final.json', phaseSnapshot()));
  const collectPhase = chunk => {
    phaseBuffer = (phaseBuffer + chunk.toString()).slice(-8192);
    let end;
    while ((end = phaseBuffer.indexOf('\n')) >= 0) {
      const line = phaseBuffer.slice(0, end); phaseBuffer = phaseBuffer.slice(end + 1);
      const match = /KCODER_AUTH_OBSERVE (\{[^\r\n]*\})/.exec(line);
      if (!match) continue;
      let value; try { value = JSON.parse(match[1]); } catch { continue; }
      if (!Object.hasOwn(phases, value.component) || !/^(started|http_authenticated|cookie_installed|timer_armed|failed|stopped|read_queued|read_started|read_completed|renew_queued|renew_started|renew_completed)$/.test(value.stage)) continue;
      const safe = { component: value.component, stage: value.stage };
      for (const key of ['at','elapsedMs','delayMs','queueMs','remainingMs']) if (Number.isFinite(value[key])) safe[key] = value[key];
      for (const key of ['valid','failed']) if (typeof value[key] === 'boolean') safe[key] = value[key];
      const rows = phases[value.component]; rows.push(safe);
      if (rows.length > 256) { rows.shift(); droppedPhases++; }
    }
  };
  const child = context.spawnOwned('renewal-electron', windows ? electron : xvfb,
    [...(windows ? [] : ['-a', electron, '--no-sandbox']), '--disable-gpu', '--inspect=127.0.0.1:0',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', resolve(appRoot, 'desktop/main.mjs')],
    { cwd: appRoot, env: environment });
  let output = '';
  const collect = chunk => { output = (output + chunk).slice(-16000); };
  child.stdout.on('data', chunk => { collect(chunk); collectPhase(chunk); }); child.stderr.on('data', collect);
  try {
  const address = await waitFor(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
    30000, 'desktop CDP', 100, context.abortSignal);
  const browser = await chromium.connectOverCDP(address);
  context.registerPort('renewal-desktop-cdp', Number(new URL(address).port));
  context.addCleanup('close desktop CDP', async () => { await context.stopOwned('renewal-electron'); await browser.close(); });
  const inspectorAddress = output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
  assert.ok(inspectorAddress);
  context.registerPort('renewal-main-inspector', Number(new URL(inspectorAddress).port));
  const inspector = await openRpc(inspectorAddress);
  context.addCleanup('close main inspector', () => inspector.close());
  let sequence = 0;
  const evaluateMain = async params => {
    const id = ++sequence;
    inspector.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params }));
    const response = await inspector.waitFor(message => message.id === id, 10000, 'desktop main evaluation');
    assert.ok(!response.error && !response.result?.exceptionDetails, 'desktop main evaluation must succeed');
    return response.result;
  };
  if (windows) {
    const observed = await evaluateMain({expression: `(async()=>{const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');const app=require('electron').app;await app.whenReady();return ['home','appData','userData','downloads','documents','desktop','temp'].map(kind=>{try{const value=app.getPath(kind),home=process.env.USERPROFILE;return {kind,available:true,exists:require('node:fs').existsSync(value),insideOwnedHome:typeof home==='string'&&(value.toLowerCase()===home.toLowerCase()||value.toLowerCase().startsWith(home.toLowerCase()+require('node:path').sep))}}catch{return {kind,available:false}}})})()`,awaitPromise:true,returnByValue:true});
    await context.writeArtifactJson('windows-shell-folders.json',observed.result.value);
    assert.ok(observed.result.value.some(item=>item.kind==='downloads'&&item.available&&item.exists),'UNMET_PREREQUISITE: actual Windows Downloads KnownFolder is unavailable');
  }
  const page = await waitFor(() => browser.contexts().flatMap(value => value.pages()).find(value => value.url().startsWith('http://127.0.0.1:')),
    30000, 'desktop page', 100, context.abortSignal);
  const origin = new URL(page.url()).origin;
  const pageCdp = await page.context().newCDPSession(page);
  const selectedTarget = (await pageCdp.send('Target.getTargetInfo')).targetInfo.targetId;
  await pageCdp.detach();
  let mainObservation;
  const cookie = async (armObservation = false) => {
    const result = await evaluateMain({
      expression: `(async()=>{
        const runtime=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');
        const desktop=runtime.session.fromPartition('persist:kcoder-studio-desktop');
        const cookies=await desktop.cookies.get({name:'kcoder_studio_session'});
        if (${armObservation}) {
          const probe={started:performance.now(),timerFired:false,elapsedMs:null};
          globalThis.__kcoderRenewalUnrefObservation=probe;
          setTimeout(()=>{probe.timerFired=true;probe.elapsedMs=performance.now()-probe.started;},1500).unref();
        }
        const probe=globalThis.__kcoderRenewalUnrefObservation;
        const locationOnly=value=>{try{const url=new URL(value);return {protocol:url.protocol,pathname:['http:','https:'].includes(url.protocol)?url.pathname:'[non-http]'}}catch{return {protocol:null,pathname:null}}};
        const selected=runtime.webContents.fromDevToolsTargetId(${JSON.stringify(selectedTarget)});
        return {cookies,observation:{selectedFound:Boolean(selected),selectedWebContentsId:selected?.id??null,
          selectedDesktopPartition:selected?selected.session===desktop:null,
          windows:runtime.BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()).map(w=>({webContentsId:w.webContents.id,desktopPartition:w.webContents.session===desktop,...locationOnly(w.webContents.getURL())})),
          timer:probe?{timerFired:probe.timerFired,elapsedMs:probe.elapsedMs,observedElapsedMs:performance.now()-probe.started}:null}};
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    assert.ok(!result.exceptionDetails, 'desktop cookie inspection must succeed');
    mainObservation = result.result.value.observation;
    const item = result.result.value.cookies?.[0];
    assert.ok(item); context.registerSecret(item.value); return item.value;
  };
  const first = await cookie(true);
  const observation = {selectedPagePath:new URL(page.url()).pathname,mainAtFirstSample:mainObservation,requests:[]};
  const requests = new Map();
  const headerReads = [];
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.origin !== origin || url.pathname !== '/api/servers' || requests.size >= 32) return;
    const row = {path:'/api/servers',present:null,matchesFirst:null,status:null,elapsedMs:null};
    const started = Date.now(); requests.set(request,{row,started}); observation.requests.push(row);
    headerReads.push(request.allHeaders().then(headers => {
      const part = (headers.cookie || '').split(';').map(value=>value.trim()).find(value=>value.startsWith('kcoder_studio_session='));
      row.present = Boolean(part);
      row.matchesFirst = part ? decodeURIComponent(part.slice(part.indexOf('=')+1)) === first : false;
    }).catch(()=>{row.headerObservationUnavailable=true;}));
  };
  const onResponse = response => {
    const tracked = requests.get(response.request());
    if (tracked) { tracked.row.status=response.status(); tracked.row.elapsedMs=Date.now()-tracked.started; }
  };
  page.on('request',onRequest); page.on('response',onResponse);
  try {
    await new Promise(resolve => setTimeout(resolve, 6500));
    const second = await cookie();
    observation.mainAfter6500ms = mainObservation;
    observation.pagePathAfter6500ms = new URL(page.url()).pathname;
    assert.equal(second, first, 'renewal must preserve the live session identity');
    observation.apiStatus = await page.evaluate(async () => (await fetch('/api/servers')).status);
    assert.equal(observation.apiStatus, 200);
  } finally {
    page.off('request',onRequest); page.off('response',onResponse);
    await Promise.allSettled(headerReads);
    // Persist only explicit booleans/status/timing/path metadata, never headers or cookie identities.
    await context.writeArtifactJson('renewal-auth-observation.json',observation);
  }
  // Keep the Gateway running while desktop timers cannot execute, as during a delayed wake-up.
  await evaluateMain({
    expression: `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${windows ? 4200 : 3200})`, returnByValue: true,
  });
  await waitFor(async () => await cookie() !== first, 15000, 'expired desktop session recovery', 100, context.abortSignal);
  await page.goto(origin + '/login?returnTo=%2Fplugins%2Fmanage').catch(error => {
    if (!String(error).includes('ERR_ABORTED')) throw error;
  });
  await page.waitForURL(url => url.pathname === '/plugins/manage', { timeout: 15000 });
  assert.equal(await page.evaluate(async () => (await fetch('/api/servers')).status), 200);
  // Crash only the Gateway child owned by this isolated Electron main process.
  // Its supervisor must rotate its session and restore the same route/draft.
  await page.goto(origin + '/');
  const draftMarker = 'OWNED_UNSENT_RESTART_DRAFT';
  const sampleDraft = async stage => {
    const facts = await page.getByTestId('chat-message-input').evaluate((element, marker) => {
      const text = element.innerText ?? '';
      const value = typeof element.value === 'string' ? element.value : null;
      return { tag: element.tagName, contentEditable: element.isContentEditable,
        domLength: text.length, domOwnsMarker: text.includes(marker), domExact: text === marker,
        domEndsWithNewline: /[\r\n]$/.test(text),
        domOnlyTrailingNewlines: text.startsWith(marker) && /^[\r\n]+$/.test(text.slice(marker.length)),
        stateValuePresent: value !== null, stateLength: value?.length ?? null,
        stateOwnsMarker: value?.includes(marker) ?? false, stateExact: value === marker };
    }, draftMarker);
    const current = new URL(page.url());
    draftSamples.push({stage, path:current.pathname, originUnchanged:current.origin===origin,
      selectedDesktopPartition:mainObservation?.selectedDesktopPartition??null, ...facts});
  };
  await sampleDraft('before_fill');
  await page.getByTestId('chat-message-input').fill('OWNED_UNSENT_RESTART_DRAFT');
  await sampleDraft('after_fill');
  const beforeRestart = await cookie();
  await sampleDraft('before_restart');
  const killed = await evaluateMain({ expression:
    "(() => { const children = process._getActiveHandles().filter(h => Array.isArray(h.spawnargs) && h.spawnargs.some(a => a.replaceAll(String.fromCharCode(92), '/').endsWith('/dev-server.mjs'))); if (children.length !== 1) throw new Error('Expected one owned Gateway child'); return children[0].kill('SIGTERM'); })()",
    returnByValue: true });
  assert.equal(killed.result.value, true);
  await waitFor(async () => await cookie() !== beforeRestart, 20000, 'gateway restart rotates desktop session', 100, context.abortSignal);
  await page.getByTestId('chat-message-input').waitFor({ timeout: 20000 });
  await sampleDraft('after_restart');
  try {
    await waitFor(async () => await page.getByTestId('chat-message-input').innerText() === 'OWNED_UNSENT_RESTART_DRAFT', 15000, 'draft survives supervised Gateway restart');
  } finally { await sampleDraft('after_original_draft_assertion'); }
  if (windows) {
    const replacementCookie = await cookie();
    await new Promise(resolve => setTimeout(resolve, 6500));
    assert.equal(await cookie(), replacementCookie, 'replacement owner keeps renewing its live identity');
  }
  assert.equal(new URL(page.url()).origin, origin, 'replacement preserves the profile storage origin');
  assert.equal(await page.evaluate(async () => (await fetch('/api/servers')).status), 200);
  await context.writeArtifactJson('renewal-result.json', {
    proactiveRenewalPreservesIdentity: true, expiredSessionRecovered: true,
    loginPageRestoredRoute: true, supervisedGatewayRestart: true, rotatedSession: true, unsentDraftPreserved: true,
  });
  } finally {
    await context.writeArtifactJson('draft-restart-observation.json',{expectedTargetId:'local',expectedDesktopPartition:'persist:kcoder-studio-desktop',samples:draftSamples});
    await context.writeArtifactJson('auth-observation-phases-before-cleanup.json', phaseSnapshot());
  }

});
