import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { DesktopActionReceiptLossClient, reconcileOriginalDesktopAction } from './desktop-action-receipt-loss.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const delay = () => new Promise(resolve => setTimeout(resolve, 50));
async function wait(check, timeout, label) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; assert.ok(Date.now() < deadline, label); await delay(); }
}

// This actor runs inside the existing Windows supervisor Job. Its direct native
// children inherit that owner; only acknowledged app-server cleanup permits the
// opaque fixture to close. It never opens a user's application or settings.
export async function runWindowsDesktopActionUnknown(root) {
  assert.equal(process.platform, 'win32');
  const input = JSON.parse(await readFile(join(root, 'desktop-input.json'), 'utf8'));
  const ownedFixtureInput = input.ownedFixtureInput === true;
  assert.equal(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')).owner, input.owner);
  const packageRoot = join(root, 'app');
  const binary = join(packageRoot, 'resources/bin/kcoder.exe');
  assert.equal(sha(await readFile(binary)), input.cliSha256);
  const workspace = join(root, 'workspace'), profile = join(root, 'profile'), fixtureOutput = join(root, 'fixture');
  for (const directory of [workspace, profile, fixtureOutput, join(root, 'temp')]) await mkdir(directory, { recursive: true });
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'ProgramData', 'ProgramFiles',
    'ProgramFiles(x86)', 'CommonProgramFiles', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(environment, { HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
    KCODER_CONFIG_DIR: profile, TEMP: join(root, 'temp'), TMP: join(root, 'temp'), RUST_LOG: 'error' });
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const observeOwned = ownedFixtureInput
    ? (await import('./windows-owned-desktop-observation.mjs')).observeOwnedDesktopBoundary : null;
  const ownedBoundaryObservations = [];
  let ownedBoundaryFailure;
  const expectedInput = ownedFixtureInput ? 'CU_OWNED_OK' : 'DESK02_ORIGINAL_INPUT';
  let native, client, fixture, fixtureReady, sourceDiagnostics = '', stage = 0, imageObserved = false;
  let accessibilityObserved = false, completedActions = [], closeModel;
  let ownedOriginalNotifications;
  const clickWireObservations = [];
  const model = await startApprovalModelFixture({ addCleanup: (_label, callback) => { closeModel = callback; }, registerPort: () => {} }, {
    responseSteps: ({ body, requestNumber }) => {
      assert.ok(body.messages.length < 100, 'bounded protocol fixture');
      if (ownedFixtureInput) {
        const definition = body.tools?.find(tool => tool.function?.name === 'mcp__kcoder_computer_use__Click') ?? null;
        const calls = body.messages.filter(message => message.role === 'assistant').flatMap(message =>
          (message.tool_calls ?? []).filter(call => call.function?.name === 'mcp__kcoder_computer_use__Click')
            .map(call => ({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) })));
        const receiptPath = join(fixtureOutput, 'input-result.json');
        const received = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
        clickWireObservations.push({ requestNumber, afterStage: stage, clickDefinition: definition, actualPriorAssistantCalls: calls, received });
        writeFileSync(join(root, 'owned-click-schema-and-wire.json'), JSON.stringify(clickWireObservations));
      }
      const toolResult = body.messages.filter(message => message.role === 'tool').at(-1);
      if (stage === (ownedFixtureInput ? 2 : 1)) imageObserved = body.messages.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')));
      if (!ownedFixtureInput && stage === 2) {
        accessibilityObserved = JSON.stringify(toolResult).includes('KCoderInput')
          && JSON.stringify(toolResult).includes('Verify test input');
        assert.equal(accessibilityObserved, true, 'actual UIA must identify the owned controls');
      }
      const steps = ownedFixtureInput ? [
        ['Click', { loc: fixtureReady.inputLoc, button: 'left', clicks: 1 }],
        ['Screenshot', { region: fixtureReady.region, use_annotation: false }],
        ['Type', { loc: fixtureReady.inputLoc, text: expectedInput, clear: false, press_enter: false }],
        ['Click', { loc: fixtureReady.buttonLoc, button: 'left', clicks: 1 }],
      ] : [
        ['Screenshot', {}],
        ['Snapshot', { use_vision: false, use_ui_tree: true, region: fixtureReady.region }],
        ['Type', { loc: fixtureReady.inputLoc, text: 'DESK02_ORIGINAL_INPUT', clear: true }],
        ['Click', { loc: fixtureReady.buttonLoc }],
      ];
      if (stage >= steps.length) return [{ delta: { content: 'OWNED_DESKTOP_ACTION_RETURNED' }, finishReason: 'stop' }];
      const observedStage = ownedFixtureInput ? ['focus_Click', 'Screenshot', 'Type', 'Verify_Click'][stage] : steps[stage][0];
      const observeBeforeDispatch = () => {
        try {
          ownedBoundaryObservations.push(observeOwned(powershell, fixtureReady, observedStage, environment,
            { requireForeground: stage !== 0, requireTextbox: stage !== 0 }));
          writeFileSync(join(root, 'owned-boundary-observations.json'), JSON.stringify(ownedBoundaryObservations));
        } catch (error) {
          ownedBoundaryFailure = { stage: observedStage, message: error.message.slice(0, 800), observation: error.observation ?? null };
          writeFileSync(join(root, 'owned-boundary-failure.json'), JSON.stringify(ownedBoundaryFailure));
          throw error;
        }
      };
      if (ownedFixtureInput) observeBeforeDispatch();
      const [name, args] = steps[stage++];
      return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `desk02-${stage}`,
        type: 'function', function: { name: `mcp__kcoder_computer_use__${name}`, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }];
    },
  });
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ permission_mode: 'yolo', max_retries: 0,
    active_provider: 'fixture', credential_store: 'file', mcp_servers: [], hooks: {}, plugins: { runtime: { enabled: true } },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', discover_models: false, context_window_tokens: 128000, max_output_tokens: 1024,
      output_headroom_tokens: 1024, no_proxy: true, capabilities: { text: true, tools: true, vision: true } } } }));
  const rpc = async (method, params = {}) => {
    const frame = await client.request(method, params, 60000);
    assert.equal(frame.error, undefined, `${method}: ${JSON.stringify(frame.error)}`); return frame.result;
  };
  const start = async (loss = false) => {
    native = spawn(binary, ['--cwd', workspace, 'app-server'], { cwd: workspace, env: environment,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    native.stderr.on('data', data => { sourceDiagnostics = (sourceDiagnostics + data.toString()).slice(-4096); });
    client = loss ? new DesktopActionReceiptLossClient('desktop-original', native, { notificationHistoryLimit: 128 })
      : new AppServerStdioClient('desktop-readonly-reopen', native, { notificationHistoryLimit: 128 });
    const initialized = await rpc('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'owned-desktop-action-loss', version: '1' }, capabilities: { experimental: {
        computerUseTurnV1: true, computerUseStatusV1: true, computerUseRecoveryV1: true, computerUseSessionAuthorizationV1: true,
      } } });
    assert.equal(initialized.capabilities.experimental.computerUseTurnV1, true);
  };
  const closeNative = async () => {
    if (!native) return;
    if (!native.stdin.writableEnded) native.stdin.end();
    await waitForStdioChildClose(native, 45000, 'original desktop app-server cleanup');
    client.closeReader(); native = null;
  };
  let result, failure;
  try {
    fixture = spawn(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'fixture.ps1'),
      '-OutputDirectory', fixtureOutput, '-LifetimeSeconds', '180', '-FullViewIsolation',
      ...(ownedFixtureInput ? ['-OwnedInputFocus'] : [])],
    { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    fixture.stderr.on('data', data => { sourceDiagnostics = (sourceDiagnostics + data.toString()).slice(-4096); });
    fixtureReady = await wait(async () => {
      try {
        const value = JSON.parse((await readFile(join(fixtureOutput, 'fixture-ready.json'), 'utf8')).replace(/^\uFEFF/, ''));
        if (ownedFixtureInput) {
          assert.equal(value.pid, fixture.pid);
          assert.equal(value.fullViewIsolated, true);
          const observed = observeOwned(powershell, value, 'fixture_ready', environment, { requireForeground: false });
          ownedBoundaryObservations.push(observed);
          ownedBoundaryFailure = undefined;
        }
        return value;
      } catch (error) {
        if (ownedFixtureInput && error.observation) ownedBoundaryFailure = {
          stage: 'fixture_ready', message: error.message, observation: error.observation };
        return null;
      }
    }, 15000, 'opaque native fixture not ready');
    assert.equal(fixtureReady.fullViewIsolated, true);
    assert.equal(fixtureReady.pid, fixture.pid);
    const fixtureScript = join(root, 'fixture.ps1').replaceAll("'", "''");
    const identityScript = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OwnedWindowIdentity{[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}';$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${fixture.pid}';[uint32]$windowPid=0;[void][OwnedWindowIdentity]::GetWindowThreadProcessId([IntPtr]${fixtureReady.hwnd},[ref]$windowPid);@{pid=$p.ProcessId;creationTicks=$p.CreationDate.ToUniversalTime().Ticks.ToString();windowPid=$windowPid;ownedScript=$p.CommandLine.Contains('${fixtureScript}');sessionId=$p.SessionId;hwnd=${fixtureReady.hwnd}}|ConvertTo-Json -Compress`;
    const appIdentity = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(identityScript, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
    assert.equal(appIdentity.pid, fixture.pid); assert.equal(appIdentity.windowPid, fixture.pid); assert.equal(appIdentity.ownedScript, true);
    assert.ok(appIdentity.sessionId > 0);
    await start(!ownedFixtureInput);
    await rpc('plugin/install', { marketplaceName: 'kcoder-bundled', pluginName: 'kcoder-windows-computer-use' });
    const readiness = await rpc('computerUse/status');
    assert.equal(readiness.canControl, true, `Native preflight: ${JSON.stringify(readiness)}`);
    const thread = await rpc('thread/start', {});
    const threadId = thread.thread.id;
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'OWNED_DESKTOP_UI: operate only the opaque owned fixture' }],
      computerUse: { approved: true, target: 'local_windows_desktop', useSessionAuthorization: false } });
    let clickCompleted;
    if (ownedFixtureInput) clickCompleted = await wait(() => {
      if (ownedBoundaryFailure) throw new Error(`owned boundary refused before dispatch: ${ownedBoundaryFailure.message}`);
      return client.notificationHistory.find(frame =>
      frame.method === 'item/completed' && frame.params?.item?.type === 'toolCall'
      && frame.params.item.name === 'mcp__kcoder_computer_use__Click'
      && frame.params.item.id === 'desk02-4'
      && frame.params.item.status === 'completed');
    }, 90000, 'owned Verify Click did not complete');
    else await wait(() => client.lostAction, 90000, 'real completed Click event did not reach the fault boundary');
    const lostAction = ownedFixtureInput ? null : client.lostAction;
    const actionIdentity = ownedFixtureInput ? { threadId: clickCompleted.params.threadId,
      turnId: clickCompleted.params.turnId, toolCallId: clickCompleted.params.item.id,
      tool: clickCompleted.params.item.name } : lostAction;
    assert.equal(actionIdentity.threadId, threadId);
    const originalReceipt = JSON.parse(await readFile(join(fixtureOutput, 'input-result.json'), 'utf8'));
    if (ownedFixtureInput) await writeFile(join(root, 'owned-input-observed-receipt.json'), JSON.stringify(originalReceipt));
    assert.deepEqual(originalReceipt, { text: expectedInput, clicked: true, clickCount: 1 });
    completedActions = client.notificationHistory.filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'toolCall');
    assert.equal(completedActions.some(frame => frame.params.item.id === actionIdentity.toolCallId), ownedFixtureInput);
    const screenshot = completedActions.find(frame => frame.params.item.name.endsWith('__Screenshot'))?.params.item.outputImages?.[0];
    assert.equal(screenshot?.mimeType, 'image/png');
    const screenshotBytes = Buffer.from(screenshot.data, 'base64');
    assert.ok(screenshotBytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    await writeFile(join(root, 'native-screenshot.png'), screenshotBytes);
    assert.equal(imageObserved, true);
    if (!ownedFixtureInput) assert.equal(accessibilityObserved, true);
    let explicitRevoke, originalLifecycle;
    if (ownedFixtureInput) {
      ownedBoundaryObservations.push(observeOwned(powershell, fixtureReady, 'after_Verify_before_revoke', environment));
      explicitRevoke = await rpc('computerUse/revoke', { threadId });
      assert.equal(explicitRevoke.revoked, true);
      await wait(() => client.notificationHistory.some(frame => frame.method === 'computerUse/stateChanged'
        && frame.params?.threadId === threadId && frame.params?.diagnostic?.cleanup === 'confirmed'),
      30000, 'owned original lease cleanup was not confirmed');
      originalLifecycle = client.notificationHistory.filter(frame => frame.method === 'computerUse/stateChanged')
        .map(frame => ({ threadId: frame.params.threadId, turnId: frame.params.turnId,
          state: frame.params.state, diagnostic: frame.params.diagnostic }));
      assert.ok(originalLifecycle.some(frame => frame.state === 'active' && frame.diagnostic?.hostPid > 0
        && frame.diagnostic?.workerPid > 0), 'actual broker/worker identity must be observed');
    }
    await closeNative();
    if (ownedFixtureInput) ownedOriginalNotifications = client.notificationHistory.slice();
    const requestsBeforeReopen = model.requests.length;
    await start();
    await rpc('thread/resume', { threadId });
    const originalHistory = await rpc('thread/read', { threadId, includeTurns: true });
    const authoritativeActionReceipt = reconcileOriginalDesktopAction(originalHistory, actionIdentity);
    assert.equal(model.requests.length, requestsBeforeReopen, 'read-only reconciliation cannot execute a model turn');
    const afterReopen = JSON.parse(await readFile(join(fixtureOutput, 'input-result.json'), 'utf8'));
    assert.deepEqual(afterReopen, originalReceipt, 'same original native action must not replay on reconnect');
    assert.equal(stage, 4);
    result = { passed: true, modelQualityTest: false, businessSuccess: false, paidModelCalls: 0,
      cliSha256: input.cliSha256, runtimeManifestSha256: input.runtimeManifestSha256,
      platform: 'win32', appIdentity, fullViewIsolated: true, nativeScreenshotToProvider: imageObserved,
      nativeScreenshotSha256: sha(screenshotBytes), ownedAccessibilityControlsObserved: accessibilityObserved,
      lostAction, authoritativeActionReceipt, originalReceipt, afterReopen, originalHistoryReconciled: true,
      readOnlyReopenModelRequests: model.requests.length - requestsBeforeReopen,
      deterministicProviderRequests: model.requests.length, actionNames: completedActions.map(frame => frame.params.item.name),
      localHostAuthorization: 'explicit_original_turn', sshShellAuthorizationDoesNotGrantDesktop: 'separate_transport_gate',
      brokerTransportFaultVerified: false, nativeActionVerified: true };
    if (ownedFixtureInput) Object.assign(result, { ownedFixtureInput: true, snapshotUiaVerified: false,
      ownedBoundaryObservations, explicitRevoke, originalLifecycle, nativeLeaseCleanupConfirmed: true,
      desktopActionReceiptLossVerified: false, defaultDesk02ScenePassed: false,
      clipboardUsedForInput: false, uiTreeBackgroundEnumerated: false });
  } catch (error) {
    failure = error;
    if (ownedFixtureInput && native && !native.stdin.writableEnded)
      try { ownedBoundaryFailure = { ...ownedBoundaryFailure, availabilityAfterFailure: await rpc('computerUse/status') }; } catch {}
  }
  finally {
    try { await closeNative(); } catch (error) { failure ??= error; }
    if (ownedFixtureInput) {
      const notifications = ownedOriginalNotifications ?? client?.notificationHistory ?? [];
      await writeFile(join(root, 'owned-native-progress.json'), JSON.stringify({ stage,
        tools: notifications.filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'toolCall')
          .map(frame => ({ id: frame.params.item.id, name: frame.params.item.name, status: frame.params.item.status })),
        lifecycle: notifications.filter(frame => frame.method === 'computerUse/stateChanged').map(frame => frame.params),
        ownedBoundaryObservations }));
      if (failure) {
        const image = notifications.find(frame => frame.method === 'item/completed'
          && frame.params?.item?.name === 'mcp__kcoder_computer_use__Screenshot')?.params.item.outputImages?.[0];
        if (image?.mimeType === 'image/png') await writeFile(join(root, 'native-screenshot.png'), Buffer.from(image.data, 'base64'));
      }
    }
    if (!native) {
      await writeFile(join(fixtureOutput, 'close.fixture'), '');
      if (fixture) await waitForStdioChildClose(fixture, 10000, 'owned opaque fixture cleanup').catch(error => { failure ??= error; });
    }
    await closeModel();
    if (failure) await writeFile(join(root, 'native-failure.json'), JSON.stringify({ error: failure.message, diagnostics: sourceDiagnostics,
      modelRequests: model.requests.length, stage, nativeCleanupConfirmed: native === null, fixtureClosed: fixture?.exitCode !== null,
      ...(ownedFixtureInput ? { ownedBoundaryFailure, ownedBoundaryObservations,
        actualTools: client?.notificationHistory.filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'toolCall')
          .map(frame => ({ id: frame.params.item.id, name: frame.params.item.name, status: frame.params.item.status })) } : {}) }));
  }
  if (failure) throw failure;
  return result;
}
