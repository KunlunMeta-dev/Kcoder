import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startChromium } from '../../e2e/harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../e2e/harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../e2e/harness/renderer-build.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../e2e/harness/rpc.mjs';
import { repoRoot, requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';

const providerDoctorConsistencyOnly = process.env.KCODER_E2E_PROVIDER_DOCTOR_CONSISTENCY === '1';
const includeProviderSettingsUi = !providerDoctorConsistencyOnly
  && process.env.KCODER_E2E_PROVIDER_SETTINGS_UI !== '0';
const providerSettingsUiOnly = process.env.KCODER_E2E_PROVIDER_SETTINGS_UI === 'only';
const providerSettingsRecoveryOnly = process.env.KCODER_E2E_PROVIDER_SETTINGS_UI === 'recovery';
const runCliRouting = !providerSettingsUiOnly && !providerSettingsRecoveryOnly && !providerDoctorConsistencyOnly;
const runAppServerRouting = !providerSettingsUiOnly && !providerDoctorConsistencyOnly;
if (includeProviderSettingsUi) await assertRendererBuildFresh();

await runIntegration(import.meta.url, {
  testId: 'multi-endpoint-profile-priority-and-session-default-routing',
  tier: 'full-integration',
  retainSuccessLogs: true,
  modelPolicy: providerDoctorConsistencyOnly
    ? 'owned loopback only; synthetic minimax/kunlunmeta profiles; doctor and new headless session routing; no external inference or model-quality assertions'
    : providerSettingsRecoveryOnly
    ? 'owned loopback only; one RunContext-registered synthetic key, five absent-key profiles, no external inference or model-quality assertions'
    : 'owned loopback providers only; no API credentials, external inference, or model-quality assertions',
}, async context => {
  const binary = await requireExecutable(
    process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    'KCoder',
  );
  const binarySha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256 || null;
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'provider-routing' });
  const isolatedHome = context.pathInState('home');
  await mkdir(isolatedHome, { recursive: true });
  const isolatedTemp = context.pathInState('tmp');
  await mkdir(isolatedTemp, { recursive: true });
  const syntheticKeyEnv = 'KCODER_E2E_FIXTURE_API_KEY';
  const syntheticApiKey = providerSettingsRecoveryOnly ? `owned-loopback-${randomUUID()}` : null;
  if (syntheticApiKey) context.registerSecret(syntheticApiKey);
  const settingsFailurePrompt = 'OWNED_PROVIDER_SETTINGS_HTTP_401';
  const alpha = await startApprovalModelFixture(context, {
    ...(providerSettingsRecoveryOnly ? {
      modelList: { apiKey: syntheticApiKey, ids: ['alpha-model', 'alpha-sibling'] },
      httpErrorPrompt: settingsFailurePrompt,
      httpErrorStatus: 401,
      httpErrorMessage: 'synthetic loopback authentication failure',
      httpErrorMatchLimit: 1,
    } : {}),
    responseSteps: () => [
      { delta: { role: 'assistant', content: 'OK' } },
      { finishReason: 'stop' },
    ],
  });
  const beta = await startApprovalModelFixture(context, { responseSteps: () => [
    { delta: { role: 'assistant', content: 'OK' } },
    { finishReason: 'stop' },
  ] });

  const makeProvider = (endpoint, defaultModel, models, authentication = { mode: 'none' }, extra = {}) => ({
    api_format: 'openai_chat_completions',
    authentication,
    endpoint,
    default_model: defaultModel,
    models,
    discover_models: false,
    no_proxy: true,
    ...extra,
  });
  const model = contextWindow => ({
    context_window_tokens: contextWindow,
    output_headroom_tokens: 1024,
    max_output_tokens: 512,
    capabilities: { text: true, tools: false, vision: false, reasoning: false, structured_output: false },
  });
  const alphaConfig = makeProvider(alpha.baseUrl, 'alpha-model', {
    'alpha-model': model(16384),
    'alpha-sibling': model(16384),
  }, providerSettingsRecoveryOnly ? { mode: 'api_key' } : { mode: 'none' },
  providerSettingsRecoveryOnly ? { credential_env: [syntheticKeyEnv] } : {});
  const betaConfig = makeProvider(beta.baseUrl, 'beta-model', {
    'beta-model': model(16384),
  }, providerSettingsRecoveryOnly ? { mode: 'api_key' } : { mode: 'none' },
  providerSettingsRecoveryOnly ? { credential_env: ['KCODER_E2E_MISSING_KEY_1'] } : {});
  const noKeyConfig = makeProvider(beta.baseUrl, 'no-key-model', {
    'no-key-model': model(16384),
  }, { mode: 'api_key' },
  providerSettingsRecoveryOnly ? { credential_env: ['KCODER_E2E_MISSING_KEY_2'] } : {});
  const additionalMissingConfigs = providerSettingsRecoveryOnly
    ? Object.fromEntries([3, 4, 5].map(index => {
        const id = `fixture-no-key-${index}`;
        const modelId = `no-key-model-${index}`;
        return [id, makeProvider(beta.baseUrl, modelId, { [modelId]: model(16384) }, { mode: 'api_key' }, {
          credential_env: [`KCODER_E2E_MISSING_KEY_${index}`],
        })];
      }))
    : {};
  const settings = {
    active_provider: providerDoctorConsistencyOnly ? 'minimax' : 'fixture-alpha',
    max_retries: 0,
    memory: { observer_mode: 'disabled', structured_enabled: false, legacy_prompt_enabled: false },
    session_memory: { enabled: false },
    providers: providerDoctorConsistencyOnly
      ? { minimax: alphaConfig, kunlunmeta: betaConfig, 'fixture-alpha': alphaConfig }
      : { 'fixture-alpha': alphaConfig, 'fixture-beta': betaConfig },
  };
  const cliConfigDir = context.pathInState('cli-profile');
  await context.writeStateJson('cli-profile/settings.json', settings);
  const targetConfigDir = context.pathInState('target-profile');
  await context.writeStateJson('target-profile/settings.json', {
    ...settings,
    providers: {
      ...settings.providers,
      'fixture-no-key': noKeyConfig,
      ...additionalMissingConfigs,
    },
  });
  if (providerDoctorConsistencyOnly) {
  }

  const cliRuns = [];
  const cliEnvironment = () => context.isolatedEnvironment({
    KCODER_CONFIG_DIR: cliConfigDir,
    KCODER_HOME: isolatedHome,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: isolatedTemp,
    TMP: isolatedTemp,
    TEMP: isolatedTemp,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...(syntheticApiKey ? { [syntheticKeyEnv]: syntheticApiKey } : {}),
  });
  const runCli = async (label, flags, expectedProvider, expectedModel, expectedDestination) => {
    const destination = expectedDestination
      ?? (expectedProvider === 'fixture-alpha' ? 'alpha' : 'beta');
    const beforeAlpha = alpha.requests.length;
    const beforeBeta = beta.requests.length;
    const args = [
      ...flags,
      '--cwd', workspace,
      '--max-retries', '0',
      '--max-duration-secs', '20',
      '--training-mode',
      '--json',
      'OWNED_PROVIDER_ROUTING_CHECK: reply only OK.',
    ];
    const child = context.spawnOwned(label, binary, args, {
      cwd: workspace,
      env: cliEnvironment(),
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-40_000); });
    try {
      await waitFor(() => child.exitCode !== null || stdout.includes('"type":"assistant_message_done"'),
        30_000, `${label} model turn completion`, 50, context.abortSignal);
    } catch (error) {
      await context.writeArtifactJson(`${label}-failure-observation.json`, {
        failedPhase: 'model-turn-completion',
        eventTypes: [...stdout.matchAll(/"type":"([^"]+)"/g)].map(match => match[1]),
        alphaRequestDelta: alpha.requests.length - beforeAlpha,
        betaRequestDelta: beta.requests.length - beforeBeta,
        childExitCode: child.exitCode,
      });
      throw error;
    }
    const modelTurnCompleted = stdout.includes('"type":"assistant_message_done"');
    assert.equal(modelTurnCompleted, true, `${label} must finish the loopback model turn; inspect the owned process log`);
    await waitFor(() => child.exitCode !== null || stdout.includes('"type":"result"'),
      providerDoctorConsistencyOnly ? 90_000 : 3_000, `${label} terminal result`, 50, context.abortSignal).catch(error => {
      if (context.abortSignal.aborted) throw error;
    });
    if (providerDoctorConsistencyOnly && stdout.includes('"type":"result"') && child.exitCode === null) {
      await waitFor(() => child.exitCode !== null, 10_000, `${label} natural process exit after result`, 50,
        context.abortSignal).catch(error => {
        if (context.abortSignal.aborted) throw error;
      });
    }
    const exitCode = child.exitCode;
    const terminalResultSeen = stdout.includes('"type":"result"');
    await context.stopOwned(label);
    if (exitCode !== null) assert.equal(exitCode, 0, `${label} exited non-zero after its model turn`);
    assert.equal(alpha.requests.length - beforeAlpha, destination === 'alpha' ? 1 : 0,
      `${label} alpha destination count`);
    assert.equal(beta.requests.length - beforeBeta, destination === 'beta' ? 1 : 0,
      `${label} beta destination count`);
    const captured = destination === 'alpha' ? alpha.requests.at(-1) : beta.requests.at(-1);
    assert.equal(captured.model, expectedModel, `${label} model in captured outbound request`);
    cliRuns.push({ label, flags, exitCode, modelTurnCompleted, terminalResultSeen,
      stoppedAfterTurnByHarness: exitCode === null, outboundProvider: expectedProvider, outboundModel: captured.model,
      outboundFixture: destination, outboundEndpoint: destination === 'alpha' ? alpha.baseUrl : beta.baseUrl,
      counts: { alpha: alpha.requests.length, beta: beta.requests.length }, outputBytes: Buffer.byteLength(stdout) });
  };

  const doctorRuns = [];
  const runDoctor = async (label, flags, expectedProfile, expectedModel, expectedEndpoint) => {
    const args = [...flags, '--cwd', workspace, 'doctor'];
    const child = context.spawnOwned(label, binary, args, { cwd: workspace, env: cliEnvironment() });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-80_000); });
    child.stderr.resume();
    await waitFor(() => child.exitCode !== null, 90_000, `${label} doctor exit`, 50, context.abortSignal);
    const exitCode = child.exitCode;
    await context.stopOwned(label);
    assert.equal(exitCode, 0, `${label} doctor must exit successfully`);

    const field = name => stdout.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1]?.trim();
    const observed = {
      exitCode,
      loadedSettings: field('loaded settings'),
      settingsPaths: {
        user: field('user settings'),
        project: field('project settings'),
        local: field('local settings'),
        credentials: field('credentials'),
      },
      activeProfile: field('active profile'),
      model: field('model')?.split(' (source:')[0],
      apiFormat: field('API format'),
      endpoint: field('endpoint'),
      providerKind: field('provider'),
      executableSha256: field('executable sha256'),
      outputBytes: Buffer.byteLength(stdout),
    };
    assert.ok(binarySha256, 'doctor consistency mode requires an explicit CLI binary SHA256 pin');
    assert.equal(observed.executableSha256, binarySha256, `${label} doctor executable identity`);
    assert.equal(observed.activeProfile, expectedProfile, `${label} doctor effective active profile`);
    assert.equal(observed.model, expectedModel, `${label} doctor effective model`);
    assert.equal(observed.apiFormat, 'openai_chat_completions', `${label} doctor effective API format`);
    assert.equal(observed.endpoint, expectedEndpoint, `${label} doctor effective endpoint`);
    assert.ok(observed.loadedSettings?.split(' -> ').includes('user'), `${label} must report its loaded user settings`);
    for (const [kind, value] of Object.entries(observed.settingsPaths)) {
      assert.ok(value, `${label} doctor must report ${kind} settings path`);
      const resolvedPath = resolve(value);
      const ownedRoots = [context.stateDir, workspace].map(root => resolve(root));
      assert.ok(ownedRoots.some(root => {
        const rel = relative(root, resolvedPath);
        return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
      }), `${label} ${kind} path must remain under the owned run state/workspace: ${kind}`);
    }
    doctorRuns.push({ label, flags, expectedProfile, observed });
    return observed;
  };

  if (runCliRouting) {
    await runCli('cli-target-default-alpha', [], 'fixture-alpha', 'alpha-model');
    await runCli('cli-profile-beta', ['--profile', 'fixture-beta'], 'fixture-beta', 'beta-model');
    await runCli('cli-provider-id-beta', ['--provider', 'fixture-beta'], 'fixture-beta', 'beta-model');
    await runCli('cli-qualified-model-overrides-profile', [
      '--profile', 'fixture-alpha', '--model', 'fixture-beta::beta-model',
    ], 'fixture-beta', 'beta-model');
  }
  await context.writeArtifactJson('cli-routing-evidence.json', {
    skipped: !runCliRouting,
    settingsActiveProvider: settings.active_provider,
    cliRuns,
    capturedRequests: {
      fixtureAlpha: alpha.requests.map(body => ({ model: body.model })),
      fixtureBeta: beta.requests.map(body => ({ model: body.model })),
    },
  });

  if (providerDoctorConsistencyOnly) {
    await context.writeArtifactJson('provider-doctor-input-settings.json', settings);
    const directoryOwners = await Promise.all([
      ['state', context.stateDir], ['home', isolatedHome],
      ['cli-config', cliConfigDir], ['target-config', targetConfigDir],
    ].map(async ([label, path]) => {
      const info = await stat(path);
      return { label, path, uid: info.uid, gid: info.gid };
    }));
    const settingsFileInfo = await stat(resolve(cliConfigDir, 'settings.json'));
    directoryOwners.push({
      label: 'cli-settings-file',
      path: resolve(cliConfigDir, 'settings.json'),
      uid: settingsFileInfo.uid,
      gid: settingsFileInfo.gid,
    });
    await context.writeArtifactJson('provider-doctor-config-owners.json', directoryOwners);
    const defaultDoctor = await runDoctor(
      'doctor-legacy-minimax-settings', [], 'kunlunmeta', 'beta-model', beta.baseUrl,
    );
    await runCli('new-session-legacy-minimax-settings', [], 'kunlunmeta', 'beta-model', 'beta');
    const overrideDoctor = await runDoctor(
      'doctor-cli-profile-override-fixture-alpha', ['--profile', 'fixture-alpha'],
      'fixture-alpha', 'alpha-model', alpha.baseUrl,
    );
    await runCli('new-session-cli-profile-override-fixture-alpha', ['--profile', 'fixture-alpha'],
      'fixture-alpha', 'alpha-model', 'alpha');

    const consistencyEvidence = {
      fixtureBoundary: 'raw minimax maps to alpha and existing kunlunmeta to beta; migration rewrites the active reference to kunlunmeta and removes the legacy provider; fixture-alpha remains alpha',
      rawSettingsSnapshot: 'provider-doctor-input-settings.json',
      configDirectory: cliConfigDir,
      home: isolatedHome,
      workspace,
      rawSettings: {
        activeProvider: settings.active_provider,
        providerIds: Object.keys(settings.providers).sort(),
      },
      migrationSource: 'crates/kcoder_config/src/migrations/legacy.rs:47-58,67-80',
      expectedMigration: 'remove providers.minimax; preserve existing providers.kunlunmeta via or_insert; rewrite active_provider minimax to kunlunmeta',
      cases: [
        {
          selection: 'legacy minimax settings default after migration',
          doctor: defaultDoctor,
          newSession: cliRuns.at(-2),
          expectedEffectiveProfile: 'kunlunmeta',
          expectedEndpoint: beta.baseUrl,
          expectedModel: 'beta-model',
        },
        {
          selection: '--profile fixture-alpha after migration',
          doctor: overrideDoctor,
          newSession: cliRuns.at(-1),
          expectedEffectiveProfile: 'fixture-alpha',
          expectedEndpoint: alpha.baseUrl,
          expectedModel: 'alpha-model',
        },
      ],
      loopbackRequests: {
        alphaFixture: alpha.requests.map(body => ({ model: body.model })),
        betaFixture: beta.requests.map(body => ({ model: body.model })),
      },
    };
    await context.writeArtifactJson('provider-doctor-consistency.json', consistencyEvidence);
    return {
      providerDoctorConsistency: true,
      doctorLoadedOwnedConfig: true,
      defaultProfileMatchesNewSession: true,
      cliProfileOverrideMatchesDoctorAndNewSession: true,
      naturalTerminalExits: cliRuns.map(row => ({
        label: row.label,
        exitCode: row.exitCode,
        terminalResultSeen: row.terminalResultSeen,
        stoppedAfterTurnByHarness: row.stoppedAfterTurnByHarness,
      })),
      alphaRequests: alpha.requests.length,
      betaRequests: beta.requests.length,
    };
  }

  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Owned provider routing target', transport: 'local', command: binary, workspace,
  }]);
  const gateway = await startGateway(context, {
    label: 'provider-routing-gateway', workspace, serversFile, kcoderBin: binary,
    env: {
      KCODER_CONFIG_DIR: targetConfigDir,
      KCODER_HOME: isolatedHome,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      TMPDIR: isolatedTemp,
      TMP: isolatedTemp,
      TEMP: isolatedTemp,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      ...(syntheticApiKey ? { [syntheticKeyEnv]: syntheticApiKey } : {}),
    },
  });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token), { timeoutMs: 45_000 });
  context.addCleanup('close provider routing RPC', () => rpc.close());
  await initializeRpc(rpc, 'provider-routing-profile-priority');

  const initialList = await rpc.request('runtime.providers.list', {});
  const profile = (id, modelId) => initialList.profiles.find(row => row.id === id && row.model === modelId);
  assert.equal(profile('fixture-alpha', 'alpha-model')?.isDefault, true);
  assert.equal(profile('fixture-alpha', 'alpha-model')?.isProviderDefault, true);
  assert.equal(profile('fixture-alpha', 'alpha-sibling')?.isDefault, false);
  assert.equal(profile('fixture-alpha', 'alpha-sibling')?.isProviderDefault, false);
  assert.equal(profile('fixture-beta', 'beta-model')?.isDefault, false);
  assert.equal(profile('fixture-beta', 'beta-model')?.isProviderDefault, true);
  assert.equal(profile('fixture-no-key', 'no-key-model')?.executionReady, true);
  assert.equal(profile('fixture-no-key', 'no-key-model')?.apiKeyConfigured, false);
  if (providerSettingsRecoveryOnly) {
    const sixApiDefaultIds = [
      'fixture-alpha', 'fixture-beta', 'fixture-no-key',
      'fixture-no-key-3', 'fixture-no-key-4', 'fixture-no-key-5',
    ];
    const defaultProfiles = initialList.profiles.filter(row => row.isProviderDefault);
    assert.equal(defaultProfiles.length, 6, 'the six configured API entries each expose one profile default');
    assert.deepEqual(defaultProfiles.map(row => row.id).sort(), [...sixApiDefaultIds].sort());
    assert.equal(initialList.profiles.filter(row => row.isDefault).length, 1,
      'there is exactly one target default across the six profile defaults');
    assert.equal(defaultProfiles.filter(row => row.apiKeyConfigured).length, 1,
      'exactly one of the six profiles has a resolved credential in this owned fixture');
    assert.ok(defaultProfiles.every(row => row.executionReady),
      'executionReady reports model/profile execution limits, separately from API-key presence');
    assert.ok(defaultProfiles.filter(row => row.id !== 'fixture-alpha')
      .every(row => row.apiKeyConfigured === false), 'all other five API-key profiles have no credential');
  }

  const sendTurn = async (threadId, selectionMode) => {
    const beforeAlpha = alpha.requests.length;
    const beforeBeta = beta.requests.length;
    const started = await rpc.request('turn/start', {
      threadId,
      ...(selectionMode ? { modelSelectionMode: selectionMode } : {}),
      input: [{ type: 'text', text: 'OWNED_APP_SERVER_PROVIDER_ROUTING_CHECK: reply only OK.' }],
    });
    const completed = await rpc.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === threadId && message.params?.turnId === started.turn.id,
    30_000, 'owned app-server provider routing turn');
    assert.equal(completed.params.turn.status, 'completed');
    const deltaAlpha = alpha.requests.length - beforeAlpha;
    const deltaBeta = beta.requests.length - beforeBeta;
    assert.equal(deltaAlpha + deltaBeta, 1, 'one captured loopback provider request per accepted turn');
    return deltaAlpha ? { provider: 'fixture-alpha', model: alpha.requests.at(-1).model }
      : { provider: 'fixture-beta', model: beta.requests.at(-1).model };
  };

  let defaultThread;
  let explicitAlphaThread;
  let followThread;
  let explicitChoiceThread;
  let appServerRoutingEvidence = { skipped: !runAppServerRouting };
  let recoveryRouteRequestCount = 0;
  if (runAppServerRouting) {
    defaultThread = (await rpc.request('thread/start', { cwd: workspace })).thread;
    assert.deepEqual(await sendTurn(defaultThread.id), { provider: 'fixture-alpha', model: 'alpha-model' });
    explicitAlphaThread = (await rpc.request('thread/start', {
      cwd: workspace, model: 'fixture-alpha::alpha-model',
    })).thread;
    assert.deepEqual(await sendTurn(explicitAlphaThread.id), { provider: 'fixture-alpha', model: 'alpha-model' });
    followThread = (await rpc.request('thread/start', { cwd: workspace })).thread;
    assert.deepEqual(await sendTurn(followThread.id, 'follow_target_default'), {
      provider: 'fixture-alpha', model: 'alpha-model',
    });
    if (providerSettingsRecoveryOnly) {
      explicitChoiceThread = (await rpc.request('thread/start', {
        cwd: workspace, model: 'fixture-alpha::alpha-sibling',
      })).thread;
      assert.deepEqual(await sendTurn(explicitChoiceThread.id), {
        provider: 'fixture-alpha', model: 'alpha-sibling',
      }, 'an explicit creation choice must override the current target default');
      recoveryRouteRequestCount = 4;
      appServerRoutingEvidence = {
        targetDefaultInitially: 'fixture-alpha/alpha-model',
        explicitCreationChoiceBeforeChange: 'fixture-alpha/alpha-sibling',
        postChangeRouting: 'pending',
        capturedLoopbackRequests: recoveryRouteRequestCount,
      };
    } else {
      appServerRoutingEvidence = {
        targetDefaultInitially: 'fixture-alpha/alpha-model',
        explicitSessionAfterDefaultSwitch: 'fixture-alpha/alpha-model',
        followTargetDefaultAfterSwitch: 'fixture-beta/beta-model',
      };
    }
  }

  let rendererResult = { skipped: !includeProviderSettingsUi };
  if (includeProviderSettingsUi) {
    const chromium = await startChromium(context, { label: 'provider-routing-chromium' });
    const browserContext = await chromium.browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.addCleanup('close provider routing browser context', () => browserContext.close());
    const page = await browserContext.newPage();
    const providerUiRpc = { requests: [], responses: [] };
    page.on('websocket', socket => {
      const pending = new Map();
      socket.on('framesent', ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (!frame.method?.startsWith('runtime.providers.') || frame.id === undefined) return;
          pending.set(String(frame.id), frame.method);
          providerUiRpc.requests.push({
            method: frame.method,
            ...(frame.method === 'runtime.providers.upsert' ? {
              provider: frame.params?.id,
              model: frame.params?.model,
              makeDefault: frame.params?.makeDefault === true,
              validateConnection: frame.params?.validateConnection,
              authFieldNonempty: typeof frame.params?.apiKey === 'string' && frame.params.apiKey.length > 0,
              expectedRevisionPresent: typeof frame.params?.expectedRevision === 'string',
              syntheticParams: redactSyntheticRpcValue(frame.params),
            } : {}),
            ...(frame.method === 'runtime.providers.probe' ? {
              provider: frame.params?.id,
              model: frame.params?.model,
              expectedRevisionPresent: typeof frame.params?.expectedRevision === 'string',
            } : {}),
          });
        } catch { /* Ignore non-JSON or unrelated WebSocket frames. */ }
      });
      socket.on('framereceived', ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.id === undefined) return;
          const method = pending.get(String(frame.id));
          if (!method) return;
          pending.delete(String(frame.id));
          providerUiRpc.responses.push({
            method,
            error: frame.error ? {
              code: frame.error.code,
              kind: /provider_probe_changed|configuration changed|refresh/i.test(frame.error.message ?? '')
                ? 'revision-conflict' : 'other',
            } : undefined,
            ...(Array.isArray(frame.result?.profiles) ? {
              revision: frame.result.revision,
              savedRevision: frame.result.savedRevision,
              revisionMatchesSaved: typeof frame.result.savedRevision === 'string'
                ? frame.result.savedRevision === frame.result.revision : undefined,
              profiles: frame.result.profiles.map(profile => ({
                id: profile.id,
                model: profile.model,
                isDefault: profile.isDefault,
                isProviderDefault: profile.isProviderDefault,
                executionReady: profile.executionReady,
                hasConfiguredAuth: profile.apiKeyConfigured,
                nextTurnRevision: profile.nextTurnConfiguration?.revision,
              })),
            } : {}),
            ...(method === 'runtime.providers.upsert' && frame.result ? {
              syntheticResult: redactSyntheticRpcValue(frame.result),
            } : {}),
            ...(method === 'runtime.providers.probe' && frame.result ? {
              provider: frame.result.provider,
              model: frame.result.model,
              revision: frame.result.revision,
              configurationRevision: frame.result.configurationRevision,
              success: frame.result.success,
              errorType: frame.result.errorType,
            } : {}),
          });
        } catch { /* Ignore non-JSON or unrelated WebSocket frames. */ }
      });
    });
    await login(page, gateway);
    if (providerSettingsRecoveryOnly) {
      const project = page.locator('[data-testid="project-item"]:visible').first();
      await project.waitFor({ state: 'visible', timeout: 30_000 });
      await project.hover();
      await project.getByTestId('project-new-conversation-button').click();
      await page.getByTestId('chat-message-input').waitFor({ state: 'visible', timeout: 30_000 });
      const failureRequestCount = alpha.requests.length;
      await page.getByTestId('chat-message-input').fill(settingsFailurePrompt);
      await page.getByTestId('send-message-button').click();
      const failedCard = page.locator('[data-testid="assistant-error-card"]:visible').last();
      await failedCard.waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(alpha.requests.length, failureRequestCount + 1,
        'the owned failure task must reach exactly one alpha loopback inference request');
      assert.match(await failedCard.innerText(), /认证失败|authentication failure|authentication failed/i,
        'the real failed task must render the loopback authentication failure');
      assert.equal(alpha.requests.at(-1).model, 'alpha-model');
      const switchModelAction = failedCard.locator(
        '[data-testid="assistant-error-switch-model"], [data-testid="assistant-error-switch-model-retry"]',
      );
      await switchModelAction.waitFor({ state: 'visible', timeout: 10_000 });
      await switchModelAction.click();
      const modelControl = page.getByTestId('model-control-menu-model');
      await modelControl.waitFor({ state: 'visible', timeout: 10_000 });
      await modelControl.hover();
      const modelSelectorOption = page.locator('[data-testid^="model-option-"]').filter({ hasText: 'alpha-model' }).first();
      await modelSelectorOption.waitFor({ state: 'visible', timeout: 10_000 });
      await page.keyboard.press('Escape');

      await page.getByTestId('settings-button').click();
      await page.getByTestId('settings-menu-button').click();
      await page.getByTestId('studio-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByTestId('settings-nav-model-settings').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByTestId('settings-nav-model-settings').click();
      await page.getByTestId('kcoder-provider-settings-page').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByTestId('provider-configured-models').waitFor({ state: 'visible', timeout: 20_000 });

      const defaultRows = [
        ['fixture-alpha', 'alpha-model'],
        ['fixture-beta', 'beta-model'],
        ['fixture-no-key', 'no-key-model'],
        ['fixture-no-key-3', 'no-key-model-3'],
        ['fixture-no-key-4', 'no-key-model-4'],
        ['fixture-no-key-5', 'no-key-model-5'],
      ];
      const defaultRowTexts = [];
      for (const [id, modelId] of defaultRows) {
        const row = page.getByTestId(`provider-edit-${id}::${modelId}`);
        await row.waitFor({ state: 'visible', timeout: 20_000 });
        const text = (await row.innerText()).replace(/\s+/g, ' ').trim();
        assert.match(text, /API default model|API 默认模型/, `${id} must show its profile default`);
        if (id === 'fixture-alpha') assert.match(text, /Target default|目标默认/);
        else assert.doesNotMatch(text, /Target default|目标默认/);
        if (id !== 'fixture-alpha') {
          assert.match(text, /No key configured|未配置密钥/, `${id} must expose missing API-key state`);
          assert.doesNotMatch(text, /Setup required|Configuration required|配置未完成/,
            `${id} must not present executionReady as full credential readiness`);
        }
        defaultRowTexts.push({ id, model: modelId, text });
      }
      const alphaSiblingRow = page.getByTestId('provider-edit-fixture-alpha::alpha-sibling');
      const alphaSiblingText = (await alphaSiblingRow.innerText()).replace(/\s+/g, ' ').trim();
      assert.doesNotMatch(alphaSiblingText, /Target default|目标默认|API default model|API 默认模型/);
      assert.equal(defaultRowTexts.filter(row => /Target default|目标默认/.test(row.text)).length, 1,
        'exactly one of the six API-default rows is the target default');

      const betaNoKeyPostsBeforeProbe = beta.requests.length;
      await page.getByTestId('provider-actions-fixture-no-key::no-key-model').click();
      await page.getByTestId('provider-test-fixture-no-key::no-key-model').click();
      await page.getByTestId('provider-probe-result').waitFor({ state: 'visible', timeout: 20_000 });
      const missingKeyProbeText = await page.getByTestId('provider-probe-result').innerText();
      assert.match(missingKeyProbeText, /fixture-no-key.*no-key-model/i);
      assert.match(missingKeyProbeText, /authentication|认证|鉴权|密钥/i);
      const missingKeyProbe = providerUiRpc.responses.filter(row => row.method === 'runtime.providers.probe'
        && row.provider === 'fixture-no-key' && row.model === 'no-key-model').at(-1);
      assert.equal(missingKeyProbe?.success, false);
      assert.equal(missingKeyProbe?.errorType, 'authentication');
      assert.equal(beta.requests.length, betaNoKeyPostsBeforeProbe,
        'a profile without an API key must fail the probe before provider HTTP');

      const noKeyRow = page.getByTestId('provider-edit-fixture-no-key::no-key-model');
      await noKeyRow.click();
      await page.getByTestId('provider-form').waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('provider-authentication').inputValue(), 'api_key');
      assert.equal(await page.getByTestId('provider-model').inputValue(), 'no-key-model');
      assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '');
      assert.equal(await page.getByTestId('provider-model').isEnabled(), true,
        'the no-key profile remains editable');
      await page.getByTestId('provider-editor-close').click();
      await page.getByTestId('provider-new').click();
      await page.getByTestId('provider-form').waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('provider-id').isEnabled(), true,
        'the settings page exposes a usable Add API editor');
      await page.getByTestId('provider-editor-close').click();

      const alphaModelListStart = alpha.modelListRequests.length;
      await page.getByTestId('provider-edit-fixture-alpha::alpha-model').click();
      assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '',
        'the stored credential value is not rendered in the editor');
      await page.getByTestId('provider-discover-models').waitFor({ state: 'visible', timeout: 15_000 });
      const discoveredModelPicker = page.getByTestId('provider-discovered-model');
      await discoveredModelPicker.waitFor({ state: 'visible', timeout: 20_000 });
      await waitFor(() => alpha.modelListRequests.length > alphaModelListStart
        && alpha.modelListRequests.slice(alphaModelListStart).every(request => request.authorized),
      20_000, 'controlled API-key authorization on loopback model discovery', 50, context.abortSignal);
      const discoveredModels = await discoveredModelPicker.locator('option')
        .evaluateAll(options => options.map(option => option.value));
      assert.deepEqual(discoveredModels, ['', 'alpha-model', 'alpha-sibling']);
      const alphaModelListAuth = alpha.modelListRequests.slice(alphaModelListStart)
        .map(request => ({ path: request.path, authorized: request.authorized }));
      const screenshotPath = context.pathInArtifacts('provider-settings-recovery-list.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      rendererResult = {
        failureTask: {
          loopbackFixtureHttpStatus: 401,
          renderedAuthenticationFailureClassification: true,
          singleLoopbackInferenceRequest: true,
          modelSwitchActionOpensSelector: true,
          selectorModelVisible: true,
          settingsReachedViaVisibleMenuAndNavigation: true,
          taskIdPresent: Boolean(new URL(page.url()).searchParams.get('taskId')),
        },
        apiDefaultRows: defaultRows.map(([id, model]) => `${id}/${model}`),
        targetDefaultRow: 'fixture-alpha/alpha-model',
        apiDefaultAndTargetDefaultAreSeparate: true,
        missingCredentialProfiles: defaultRows.filter(([id]) => id !== 'fixture-alpha')
          .map(([id]) => id),
        missingKeyProbe: {
          success: missingKeyProbe.success,
          errorType: missingKeyProbe.errorType,
          providerPostDelta: beta.requests.length - betaNoKeyPostsBeforeProbe,
        },
        missingKeyEntryEditable: true,
        addApiEditorAvailable: true,
        validCredentialValueRendered: false,
        modelDiscoveryAuthorization: alphaModelListAuth,
        screenshotPath,
      };
      await context.writeArtifactJson('provider-settings-recovery.json', {
        failureTask: rendererResult.failureTask,
        providerRows: initialList.profiles.map(row => ({
          id: row.id, model: row.model, isDefault: row.isDefault,
          isProviderDefault: row.isProviderDefault, executionReady: row.executionReady,
          hasConfiguredAuth: row.apiKeyConfigured,
        })),
        domDefaultRows: defaultRows.map(([id, model]) => ({ id, model })),
        modelSwitchSelectorVisible: true,
        visibleSettingsNavigation: ['settings-menu-button', 'settings-nav-model-settings'],
        missingKeyProbe: {
          text: context.redactText(missingKeyProbeText),
          response: missingKeyProbe,
          betaInferencePostCountBefore: betaNoKeyPostsBeforeProbe,
          betaInferencePostCountAfter: beta.requests.length,
        },
        editableMissingKeyProfile: true,
        addApiEditorAvailable: true,
        modelDiscoveryAuthorization: alphaModelListAuth,
        modelDiscoveryIds: discoveredModels,
        syntheticCredential: {
          registeredWithRunContext: true,
          passedOnlyInOwnedGatewayEnvironment: true,
          valuePersistedToArtifact: false,
          authorizationAssertion: 'boolean-only',
        },
        providerUiRpc,
      });
    } else {
    await page.goto(`${gateway.baseUrl}/settings/personal/models`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('provider-configured-models').waitFor({ state: 'visible', timeout: 30_000 });
    const alphaDefaultRow = page.getByTestId('provider-edit-fixture-alpha::alpha-model');
    const alphaSiblingRow = page.getByTestId('provider-edit-fixture-alpha::alpha-sibling');
    const betaDefaultRow = page.getByTestId('provider-edit-fixture-beta::beta-model');
    const noKeyRow = page.getByTestId('provider-edit-fixture-no-key::no-key-model');
    await Promise.all([alphaDefaultRow, alphaSiblingRow, betaDefaultRow, noKeyRow]
      .map(row => row.waitFor({ state: 'visible', timeout: 30_000 })));

    const textOf = async row => (await row.innerText()).replace(/\s+/g, ' ').trim();
    const alphaDefaultText = await textOf(alphaDefaultRow);
    const alphaSiblingText = await textOf(alphaSiblingRow);
    const betaDefaultText = await textOf(betaDefaultRow);
    const noKeyText = await textOf(noKeyRow);
    assert.match(alphaDefaultText, /Target default|目标默认/);
    assert.match(alphaDefaultText, /API default model|API 默认模型/);
    assert.doesNotMatch(alphaSiblingText, /Target default|目标默认|API default model|API 默认模型/);
    assert.doesNotMatch(betaDefaultText, /Target default|目标默认/);
    assert.match(betaDefaultText, /API default model|API 默认模型/);
    assert.match(betaDefaultText, /No authentication|无需认证/);
    assert.match(noKeyText, /API default model|API 默认模型/);
    assert.match(noKeyText, /No key configured|未配置密钥/);
    assert.doesNotMatch(noKeyText, /Setup required|配置未完成/);
    await page.getByTestId('provider-actions-fixture-no-key::no-key-model').click();
    await page.getByTestId('provider-test-fixture-no-key::no-key-model').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await noKeyRow.click();
    assert.equal(await page.getByTestId('provider-model').inputValue(), 'no-key-model');
    assert.equal(await page.getByTestId('provider-apiKey').inputValue(), '');
    await page.getByTestId('provider-editor-close').click();
    await page.getByTestId('provider-new').click();
    await page.getByTestId('provider-form').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('provider-model').inputValue(), '');
    assert.equal(await page.getByTestId('provider-id').inputValue(), '');
    await page.getByTestId('provider-editor-close').click();

    const betaProbeBefore = beta.requests.length;
    const alphaProbeBefore = alpha.requests.length;
    await page.getByTestId('provider-actions-fixture-alpha::alpha-model').click();
    await page.getByTestId('provider-test-fixture-alpha::alpha-model').click();
    await page.getByTestId('provider-probe-result').waitFor({ state: 'visible', timeout: 30_000 });
    const probeText = await page.getByTestId('provider-probe-result').innerText();
    assert.match(probeText, /fixture-alpha.*alpha-model/i);
    assert.match(probeText, /Connection test passed|连接测试通过/i);
    assert.equal(alpha.requests.length, alphaProbeBefore + 1, 'the selected row probe must reach alpha loopback');
    assert.equal(beta.requests.length, betaProbeBefore, 'the alpha row probe must not reach beta loopback');

    await betaDefaultRow.click();
    await page.getByTestId('provider-default').check();
    const betaBeforeSave = beta.requests.length;
    const saveRequestCountBefore = providerUiRpc.requests.filter(row => row.method === 'runtime.providers.upsert').length;
    const saveResponseCountBefore = providerUiRpc.responses.filter(row => row.method === 'runtime.providers.upsert').length;
    const settingsPath = resolve(targetConfigDir, 'settings.json');
    const syntheticSettingsBeforeSave = await captureSyntheticSettings(settingsPath);
    await page.getByTestId('provider-save-test').click();
    const firstSaveOutcome = await waitFor(async () => {
      const error = page.getByRole('alert');
      if (await error.count()) return { error: await error.innerText() };
      const row = page.getByTestId('provider-edit-fixture-beta::beta-model');
      return /Target default|目标默认/.test(await row.innerText().catch(() => ''))
        ? { saved: true }
        : null;
    }, 30_000, 'target default badge moves to beta');
    await waitFor(() => providerUiRpc.responses.filter(row => row.method === 'runtime.providers.upsert').length > saveResponseCountBefore,
      30_000, 'synthetic provider upsert response is captured');
    const syntheticSettingsAfterSave = await captureSyntheticSettings(settingsPath);
    const syntheticUpsertRequest = providerUiRpc.requests.filter(row => row.method === 'runtime.providers.upsert')[saveRequestCountBefore];
    const syntheticUpsertResponse = providerUiRpc.responses.filter(row => row.method === 'runtime.providers.upsert')[saveResponseCountBefore];
    const providerSaveRevisionEvidence = {
      settingsFile: 'target-profile/settings.json',
      settingsBeforeSave: syntheticSettingsBeforeSave,
      settingsAfterSave: syntheticSettingsAfterSave,
      upsertRequest: syntheticUpsertRequest,
      upsertResponse: syntheticUpsertResponse,
      revisionComparison: {
        responseRevision: syntheticUpsertResponse?.revision ?? null,
        responseSavedRevision: syntheticUpsertResponse?.savedRevision ?? null,
        postSaveDocumentComputedRevision: syntheticSettingsAfterSave.computedRevision,
        responseRevisionMatchesDocument: syntheticUpsertResponse?.revision === syntheticSettingsAfterSave.computedRevision,
        savedRevisionMatchesDocument: syntheticUpsertResponse?.savedRevision === syntheticSettingsAfterSave.computedRevision,
      },
    };
    try {
      assert.equal(firstSaveOutcome.saved, true,
        'the beta target-default change must complete without a validation_changed alert');
      assert.equal(firstSaveOutcome.error, undefined,
        'Save & Test must not report validation_changed on the normal single-writer flow');
      assert.equal(syntheticUpsertResponse?.error, undefined,
        'the synthetic beta upsert must succeed');
      assert.equal(syntheticUpsertResponse?.revision, syntheticUpsertResponse?.savedRevision,
        'the post-save list revision must match the committed saved revision');
      assert.equal(syntheticUpsertResponse?.revisionMatchesSaved, true);
      assert.equal(syntheticSettingsAfterSave.computedRevision, syntheticUpsertResponse?.savedRevision,
        'the saved revision must match the owned settings document');
      assert.equal(providerSaveRevisionEvidence.revisionComparison.responseRevisionMatchesDocument, true);
      assert.equal(providerSaveRevisionEvidence.revisionComparison.savedRevisionMatchesDocument, true);
      assert.equal(providerUiRpc.requests.filter(row => row.method === 'runtime.providers.upsert').length,
        saveRequestCountBefore + 1, 'the Save & Test operation must perform one provider writer');
      await waitFor(async () => {
        const result = page.getByTestId('provider-probe-result');
        if (!(await result.count())) return false;
        const text = await result.innerText();
        return /fixture-beta.*beta-model/i.test(text)
          && /Connection test passed|连接测试通过/i.test(text);
      }, 30_000, 'beta save-and-test connection succeeds');
      assert.equal(beta.requests.length - betaBeforeSave, 1,
        'Save & Test must issue exactly one beta loopback connection probe');
      assert.equal(providerUiRpc.responses.filter(row => row.method === 'runtime.providers.probe'
        && row.provider === 'fixture-beta' && row.success === true).length, 1,
      'Save & Test must return one successful beta probe result');
    } finally {
      await context.writeArtifactJson('provider-ui-revision-recovery.json', {
        initialSaveOutcome: firstSaveOutcome,
        providerSaveRevisionEvidence,
        providerUiRpc,
      });
    }
    const updatedList = await rpc.request('runtime.providers.list', {});
    assert.equal(updatedList.profiles.find(row => row.id === 'fixture-beta' && row.model === 'beta-model')?.isDefault, true,
      'Save & Test must make beta the target default');
    assert.equal(updatedList.profiles.find(row => row.id === 'fixture-alpha' && row.model === 'alpha-model')?.isDefault, false);
    assert.equal(updatedList.profiles.find(row => row.id === 'fixture-beta' && row.model === 'beta-model')?.isDefault, true);
    assert.equal(updatedList.profiles.find(row => row.id === 'fixture-beta' && row.model === 'beta-model')?.isProviderDefault, true);
    const screenshotPath = context.pathInArtifacts('provider-settings-default-scopes.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    rendererResult = {
      actualDomLabels: true,
      apiDefaultRows: ['fixture-alpha/alpha-model', 'fixture-beta/beta-model'],
      validModelNoAuthConfigured: 'fixture-no-key/no-key-model',
      targetDefaultInitially: 'fixture-alpha/alpha-model',
      targetDefaultAfterUiSave: 'fixture-beta/beta-model',
      unconfiguredProviderEntryOpensEmptyEditor: true,
      initialSaveOutcome: 'saved',
      alphaProbeDestination: { before: alphaProbeBefore, after: alpha.requests.length },
      betaSaveAndTestDestination: { before: betaBeforeSave, after: beta.requests.length },
      screenshotPath,
    };
    }
  }

  if (providerSettingsRecoveryOnly) {
    const beforeDefaultChange = await rpc.request('runtime.providers.list', {});
    const changedDefault = await rpc.request('runtime.providers.upsert', {
      id: 'fixture-alpha', model: 'alpha-sibling',
      apiFormat: 'openai_chat_completions', authentication: { mode: 'api_key' },
      endpoint: alpha.baseUrl, contextWindowTokens: 16384, maxOutputTokens: 512,
      validateConnection: false, makeDefault: true, expectedRevision: beforeDefaultChange.revision,
    }, 30_000);
    assert.equal(changedDefault.profiles.find(row => row.id === 'fixture-alpha'
      && row.model === 'alpha-sibling')?.isDefault, true);
    assert.equal(changedDefault.profiles.find(row => row.id === 'fixture-alpha'
      && row.model === 'alpha-model')?.isDefault, false);
    assert.deepEqual(await sendTurn(explicitAlphaThread.id), {
      provider: 'fixture-alpha', model: 'alpha-model',
    }, 'a model-bound resident session must keep its prior selection after target-default change');
    assert.deepEqual(await sendTurn(followThread.id, 'follow_target_default'), {
      provider: 'fixture-alpha', model: 'alpha-sibling',
    }, 'an existing session explicitly following the target default must use the new default');
    const unboundAfterChange = (await rpc.request('thread/start', { cwd: workspace })).thread;
    assert.deepEqual(await sendTurn(unboundAfterChange.id), {
      provider: 'fixture-alpha', model: 'alpha-sibling',
    }, 'a newly created unbound session must use the current target default');
    const boundState = await rpc.request('thread/read', { threadId: explicitAlphaThread.id });
    assert.equal(boundState.thread.modelSelectionMode, 'explicit');
    assert.equal(boundState.thread.selectedModel, 'fixture-alpha::alpha-model');
    const followedState = await rpc.request('thread/read', { threadId: followThread.id });
    assert.equal(followedState.thread.modelSelectionMode, 'follow_target_default');
    recoveryRouteRequestCount += 3;
    appServerRoutingEvidence = {
      targetDefaultInitially: 'fixture-alpha/alpha-model',
      explicitCreationChoiceBeforeChange: 'fixture-alpha/alpha-sibling',
      targetDefaultAfterChange: 'fixture-alpha/alpha-sibling',
      explicitSessionAfterDefaultChange: 'fixture-alpha/alpha-model',
      existingFollowSessionAfterDefaultChange: 'fixture-alpha/alpha-sibling',
      newUnboundSessionAfterDefaultChange: 'fixture-alpha/alpha-sibling',
      capturedLoopbackRequests: recoveryRouteRequestCount,
    };
  } else if (!providerSettingsUiOnly) {
    const beforeDefaultChange = await rpc.request('runtime.providers.list', {});
    if (!includeProviderSettingsUi) {
      const upsert = await rpc.request('runtime.providers.upsert', {
        id: 'fixture-beta', model: 'beta-model', originalModel: 'beta-model',
        apiFormat: 'openai_chat_completions', authentication: { mode: 'none' },
        endpoint: beta.baseUrl, contextWindowTokens: 16384, maxOutputTokens: 512,
        validateConnection: false, makeDefault: true, expectedRevision: beforeDefaultChange.revision,
      }, 30_000);
      assert.equal(upsert.profiles.find(row => row.id === 'fixture-beta' && row.model === 'beta-model')?.isDefault, true);
    }

    assert.deepEqual(await sendTurn(explicitAlphaThread.id), { provider: 'fixture-alpha', model: 'alpha-model' },
      'an explicitly selected resident session must remain on alpha after the target default changes');
    assert.deepEqual(await sendTurn(followThread.id, 'follow_target_default'), {
      provider: 'fixture-beta', model: 'beta-model',
    }, 'a resident session explicitly following the target default must use beta after the switch');
    const explicitSelection = await rpc.request('thread/read', { threadId: explicitAlphaThread.id });
    assert.equal(explicitSelection.thread.modelSelectionMode, 'explicit');
    assert.equal(explicitSelection.thread.selectedModel, 'fixture-alpha::alpha-model');
  }

  const finalList = await rpc.request('runtime.providers.list', {});
  const finalEvidence = {
    binary: { path: binary, sha256: binarySha256 },
    cliRuns,
    initialProviderFlags: initialList.profiles.map(row => ({
      id: row.id, model: row.model, isDefault: row.isDefault, isProviderDefault: row.isProviderDefault,
      executionReady: row.executionReady, hasConfiguredAuth: row.apiKeyConfigured,
    })),
    renderer: rendererResult,
    finalProviderFlags: finalList.profiles.map(row => ({
      id: row.id, model: row.model, isDefault: row.isDefault, isProviderDefault: row.isProviderDefault,
      executionReady: row.executionReady, hasConfiguredAuth: row.apiKeyConfigured,
    })),
    capturedRequests: {
      fixtureAlpha: alpha.requests.map(body => ({ model: body.model })),
      fixtureBeta: beta.requests.map(body => ({ model: body.model })),
    },
    appServerRouting: appServerRoutingEvidence,
  };
  await context.writeArtifactJson('provider-routing-evidence.json', finalEvidence);
  const expectedAppServerRequests = providerSettingsRecoveryOnly
    ? recoveryRouteRequestCount : runAppServerRouting ? 5 : 0;
  const expectedUiInferenceRequests = includeProviderSettingsUi
    ? providerSettingsRecoveryOnly ? 1 : 2 : 0;
  assert.equal(alpha.requests.length + beta.requests.length,
    cliRuns.length + expectedAppServerRequests + expectedUiInferenceRequests,
    'all model requests must be attributable to CLI sends, app-server turns, or named UI probes');
  return {
    cliProfileAndProviderPriority: runCliRouting ? true : 'not-run',
    cliRouteCasesSkipped: !runCliRouting,
    routeCasesSkipped: !runAppServerRouting,
    separateLoopbackDestinations: true,
    explicitSessionSurvivesTargetDefaultChange: runAppServerRouting ? true : 'not-run',
    followTargetDefaultTracksTargetDefault: runAppServerRouting ? true : 'not-run',
    providerSettingsUi: rendererResult,
    alphaRequests: alpha.requests.length,
    betaRequests: beta.requests.length,
    binarySha256,
  };
});

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  if (gateway.authToken) {
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([
      page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 30_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 30_000 });
}

async function captureSyntheticSettings(path) {
  const bytes = await readFile(path);
  const raw = bytes.toString('utf8');
  const document = JSON.parse(raw);
  assertCredentialFreeSyntheticSettings(document);
  const canonicalJson = JSON.stringify(sortJsonObjectKeys(document));
  return {
    raw,
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    computedRevision: `settings-v1:${createHash('sha256').update(canonicalJson).digest('hex')}`,
  };
}

function sortJsonObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJsonObjectKeys(value[key])]));
  }
  return value;
}

function assertCredentialFreeSyntheticSettings(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialFreeSyntheticSettings(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:api_?key|access_?token|token|secret|password|authorization)$/i.test(key)) {
      assert.ok(item === null || item === '' || item === false,
        `credential-like setting must be empty in the owned synthetic fixture at ${path}.${key}`);
    }
    assertCredentialFreeSyntheticSettings(item, `${path}.${key}`);
  }
}

function redactSyntheticRpcValue(value, key = '') {
  if (/^(?:api_?key|access_?token|token|secret|password|authorization)$/i.test(key)) {
    return { redacted: true, present: value !== undefined && value !== null && value !== '' };
  }
  if (Array.isArray(value)) return value.map(item => redactSyntheticRpcValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactSyntheticRpcValue(childValue, childKey),
    ]));
  }
  return value;
}
