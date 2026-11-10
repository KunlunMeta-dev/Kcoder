import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startNativeCodeManager } from '../../harness/native-code-service.mjs';
import { registerOriginalCarrierCleanup } from '../../harness/native-systemd-carrier.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { repoRoot, runE2E, requireExecutable } from '../../harness/run-context.mjs';

process.umask(0o077);

await runE2E(import.meta.url, {
  testId: 'expert-original-kcoder-task-history-protocol', tier: 'full-integration',
  modelPolicy: 'Model-independent loopback response validates actual Native task creation, immutable instructions and history. No external model, marketplace or Feishu calls.',
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'fresh Native CLI');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'expert-original-task' });
  const model = await startApprovalModelFixture(context, { responseSteps: () => [
    { delta: { role: 'assistant', content: 'Original expert task result.' } }, { finishReason: 'stop' },
  ] });
  const profile = context.pathInState('profile');
  const policyProbe = process.env.KCODER_E2E_EXPERT_POLICY === '1';
  if (process.platform === 'linux' && process.getuid() > 0) {
    const runtimeDir = `/run/user/${process.getuid()}`;
    registerOriginalCarrierCleanup(context, { profile, workspace,
      uid: process.getuid(), gid: process.getgid(), activeManagers: new Set(),
      env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile,
        XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` }),
    }, 'expert-task-host');
  }
  const settingsFile = await context.writeStateJson('profile/settings.json', {
    active_provider: 'fixture', model: 'expert-fixture', max_retries: 0, max_tokens: 128,
    tools: { profile: policyProbe ? 'full' : 'none', ...(policyProbe ? {
      luna: { allowed: ['read', 'write', 'skill', 'DiscoverSkills'] },
      studio: { kcoder: ['read', 'write', 'skill', 'DiscoverSkills'] },
    } : {}) },
    credential_store: 'file', integrations: { office: { enabled: true }, connectivity: { enabled: true }, services: { enabled: true } }, session_memory: { enabled: false },
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'expert-fixture', authentication: { mode: 'none' }, no_proxy: true,
      context_window_tokens: policyProbe ? 128000 : 32768, output_headroom_tokens: 1024,
      max_output_tokens: 128, request_timeout_secs: 15 } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned expert tasks', transport: 'local', command: binary, workspace, settingsFile }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: binary,
    startTimeoutMs: policyProbe ? 45000 : 15000, env: { KCODER_CONFIG_DIR: profile } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const legacy = await openRpc(gatewayRpcUrl(gateway, 'local', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close legacy first expert client', () => closeRpcAndWait(legacy));
  const legacyInitialized = await legacy.request('initialize', { protocolVersion: '2026-07-27',
    clientInfo: { name: 'expert-legacy-first', version: '1' },
    capabilities: { experimental: { agentDefinitionsV1: true } } });
  assert.equal(legacyInitialized.capabilities.experimental.agentTurnConfigurationV1, false);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup('close original expert task RPC', () => closeRpcAndWait(rpc));
  const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'expert-original-task', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, officeWorkspaceV1: true, agentDefinitionsV1: true, agentTurnConfigurationV1: true, threadCreationReceiptsV1: true } } });
  assert.equal(initialized.capabilities.experimental.agentDefinitionsV1, true);
  assert.equal(initialized.capabilities.experimental.agentTurnConfigurationV1, true);
  const scope = await rpc.request('integrations/scope/read');
  let sequence = 0;
  const office = async (method, payload, mutation = {}) => {
    const reply = await rpc.request(`integrations/${method}`, { contractVersion: 'parallel-v1', requestId: `expert-task-${++sequence}`, scope, timeoutMs: 30000, payload, ...mutation });
    assert.equal(reply.status, 'completed', JSON.stringify(reply.error));
    return reply.result;
  };
  const definition = { schemaVersion: 1, id: 'personal.owned-original-task', scope: 'personal', title: 'Owned original task expert', description: 'Original task protocol', language: 'en', inputSchema: { type: 'object' }, instructions: 'ORIGINAL_EXPERT_BASE',
    skills: [{ slug: 'enabled', title: 'Enabled', description: '', content: 'ORIGINAL_ENABLED_SKILL', enabled: true }, { slug: 'disabled', title: 'Disabled', description: '', content: 'MUST_NOT_ENTER_REQUEST', enabled: false }],
    modelSelection: { kind: 'inherit_current' }, allowedTools: [], outputKinds: ['document'], acceptanceCriteria: ['Preserve original task'], externalSend: 'deny' };
  const { draft } = await office('assistant/saveDraft', { definition }, { operationId: 'original-expert-draft' });
  const { saved } = await office('assistant/saveVersion', { id: definition.id, version: '1' }, { operationId: 'original-expert-version', expectedRevision: String(draft.revision) });
  assert.equal((await rpc.request('thread/list', { limit: 10 })).threads.length, 0);
  const reference = { id: definition.id, version: saved.version, definitionSha256: saved.definitionSha256 };
  const creation = { clientRequestId: 'original-expert-task', agentDefinition: reference };
  const { thread } = await rpc.request('thread/start', creation);
  assert.equal(thread.studioWorkMode, 'kcoder');
  assert.deepEqual(thread.agentDefinition.definition, reference);
  assert.equal((await rpc.request('thread/start', creation)).thread.id, thread.id);
  const expertRead = await rpc.request('thread/expert', { threadId: thread.id });
  assert.equal(expertRead.threadId, thread.id);
  assert.deepEqual(expertRead.expert.definition, reference);
  await context.writeArtifactJson('legacy-first-expert-protocol.json', {
    legacyFirst: true, sharedBackend: true, laterClientReadSucceeded: true,
    threadId: thread.id, revision: expertRead.revision, modelCallsBeforeRead: model.requests.length,
  });
  const input = 'Original expert task input';
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, clientMessageId: 'original-expert-message', input: [{ type: 'text', text: input }] });
  const done = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 30000, 'original expert completion');
  assert.equal(done.params.turn.status, 'completed');
  assert.equal(model.requests.length, 1);
  const request = JSON.stringify(model.requests[0]);
  assert.ok(request.includes(definition.title) && request.includes('ORIGINAL_EXPERT_BASE') && request.includes('ORIGINAL_ENABLED_SKILL'));
  assert.equal(request.includes('You are KCoder,'), false, 'The selected expert owns the conversational role');
  assert.equal(request.includes('MUST_NOT_ENTER_REQUEST'), false);
  const listed = await rpc.request('thread/list', { limit: 10 });
  assert.deepEqual(listed.threads.find(value => value.id === thread.id).agentDefinition.definition, reference);
  const history = await rpc.request('thread/read', { threadId: thread.id });
  assert.ok(JSON.stringify(history).includes(input));
  assert.ok(JSON.stringify(history).includes('Original expert task result.'));
  assert.equal(model.requests.length, 1, 'reading the original task must not execute');
  await closeRpcAndWait(rpc);
  await closeRpcAndWait(legacy);
  await context.stopOwned('gateway');
  if (process.env.KCODER_E2E_EXPERT_CHANNELS === '1') {
    assert.ok(process.getuid() > 0, 'Owned Native manager requires the actual nonprivileged UID');
    await startNativeCodeManager(context, { binary, profile, workspace, uid: process.getuid(), gid: process.getgid(),
      imageSha256: createHash('sha256').update(await readFile(binary)).digest('hex'), activeManagers: new Set(),
      env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile }) }, 'owned-expert-settings-manager');
  }
  const coldGateway = await startGateway(context, { label: 'cold-gateway', auth: true, workspace, serversFile, kcoderBin: binary,
    startTimeoutMs: policyProbe ? 45000 : 15000, env: { KCODER_CONFIG_DIR: profile } });
  const coldCookie = await login(coldGateway.baseUrl, coldGateway.authToken); context.registerSecret(coldCookie);
  const cold = await openRpc(gatewayRpcUrl(coldGateway, 'local', 'cookie-auth'), { headers: { Cookie: coldCookie, Origin: coldGateway.baseUrl } });
  context.addCleanup('close cold original task RPC', () => closeRpcAndWait(cold));
  await cold.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'expert-original-task-cold', version: '1' }, capabilities: { experimental: { agentDefinitionsV1: true, integrationScopeV1: true, officeWorkspaceV1: true } } });
  const coldListed = await cold.request('thread/list', { limit: 10 });
  await context.writeArtifactJson('cold-original-task-list.json', coldListed);
  assert.deepEqual(coldListed.threads.find(value => value.id === thread.id)?.agentDefinition?.definition, reference, 'The original task must be discoverable after all prior Gateway processes exit');
  const coldHistory = await cold.request('thread/read', { threadId: thread.id });
  assert.ok(JSON.stringify(coldHistory).includes(input));
  assert.equal(model.requests.length, 1, 'Cold discovery/read never replays the original turn');
  if (process.env.KCODER_E2E_EXPERT_UI === '1') {
    const { startChromium } = await import('../../harness/chromium.mjs');
    const browser = await startChromium(context);
    const page = await browser.newPage({ viewport: { width: 1650, height: 968 } });
    await page.goto(coldGateway.baseUrl);
    await page.locator('input[name="token"]').fill(coldGateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.goto(`${coldGateway.baseUrl}/experts`);
    await page.getByTestId('expert-workspace').waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId('channels-button').count(), 1);
    assert.equal(await page.getByTestId('personalization-button').count(), 0);
    await page.locator('[data-testid="expert-workspace"] article').first().getByRole('button', {name:/^(更多操作|More actions)$/}).click();
    await page.getByRole('menuitem', {name:/^(个性化|Personalization)$/}).click();
    await page.getByTestId('expert-skills-workspace').waitFor({timeout:30000});
    const settingsUrl=new URL(page.url());
    assert.equal(settingsUrl.searchParams.get('expertId'), definition.id);
    assert.equal(settingsUrl.searchParams.get('deviceId'), 'local');
    assert.equal(settingsUrl.searchParams.get('workspacePath'), workspace);
    assert.equal(await page.getByLabel(/^(运行目标|Execution target)$/).count(),0);
    await page.reload();
    await page.getByTestId('personalization-current-expert').getByText(definition.title,{exact:true}).waitFor({timeout:30000});
    await page.locator('.octop-personalization-path-tabs').getByText(/^(通道|Channels)$/,{exact:true}).click();
    await page.waitForURL(url => url.pathname === '/channels');
    await page.getByTestId('channels-page').waitFor({timeout:30000});
    const channelUrl = new URL(page.url());
    assert.equal(channelUrl.searchParams.get('expertId'), null);
    assert.equal(channelUrl.searchParams.get('deviceId'), 'local');
    assert.equal(channelUrl.searchParams.get('workspacePath'), workspace);
    await page.screenshot({path:context.pathInArtifacts('independent-channel-settings.png'),fullPage:true});
    if(process.env.KCODER_E2E_EXPERT_CHANNELS === '1') {
      await page.getByTestId('octop-channels-workspace').waitFor({timeout:30000});
      const channelRpc=await openRpc(gatewayRpcUrl(coldGateway,'local','cookie-auth'),{headers:{Cookie:coldCookie,Origin:coldGateway.baseUrl}});
      context.addCleanup('close independent connection proof',()=>closeRpcAndWait(channelRpc));
      await channelRpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'independent-channel-owned-config',version:'1'},capabilities:{experimental:{integrationScopeV1:true,integrationTaskStateV1:true,nativeCodeServicesV1:true,officeWorkspaceV1:true,workflowCanvasV1:true,workflowRunsV1:true,workflowGraphV2:true,connectivityV1:true,nativeChannelServicesV1:true,integrationOperationReceiptsV1:true}}});
      const channelScope=await channelRpc.request('integrations/scope/read');
      const catalog=await channelRpc.request('integrations/connectivity/listConnections',{contractVersion:'parallel-v1',requestId:'owned-task-mode-feature',scope:channelScope,timeoutMs:60000,payload:{category:'channels',limit:10}},75000);
      assert.equal(catalog.status,'completed');
      const supported=catalog.result.taskFirstRoutingSupported===true;
      if(supported){
        const reply=await channelRpc.request('integrations/connectivity/prepareConnectionAction',{contractVersion:'parallel-v1',requestId:'owned-independent-channel-config',scope:channelScope,timeoutMs:60000,operationId:'owned-independent-channel-config',payload:{action:'save',connectionId:'owned-independent-feishu',kind:'feishu',label:'Owned independent channel',configuration:{appId:'owned-no-platform-app',routingMode:'task_binding_v1'},resourceGrants:[]}},75000);
        assert.equal(reply.status,'completed',JSON.stringify(reply.error));
        assert.equal(reply.result.configuration.expertRef,undefined);
        assert.equal(reply.result.configuration.routingMode,'task_binding_v1');
        assert.equal(reply.result.enabled,false);
        assert.equal(reply.result.hasCredential,false);
      }else{
        const card=page.getByRole('button',{name:/^(飞书|Feishu)$/});
        await card.click();
        await page.getByText(/此运行目标尚未提供任务绑定模式|This target does not provide task binding mode yet/).waitFor({timeout:30000});
        assert.equal((await channelRpc.request('integrations/connectivity/listConnections',{contractVersion:'parallel-v1',requestId:'owned-no-legacy-draft',scope:channelScope,timeoutMs:60000,payload:{category:'channels',limit:10}},75000)).result.items.length,0);
      }
      assert.equal((await channelRpc.request('thread/list',{limit:10})).threads.length,1);
      await context.writeArtifactJson('independent-channel-config-proof.json',{requiresExpert:false,taskModeSupported:supported,persistedNative:supported,olderTargetBlocked:!supported,accountAuthorizationCreated:false,platformSdkStarted:false,newTasksCreated:0});
    }
    assert.equal(model.requests.length,1,'Expert settings and channel configuration do not execute a task');
    await page.goto(`${coldGateway.baseUrl}/experts`);
    await page.getByTestId('expert-workspace').waitFor({timeout:30000});

    await page.getByRole('button', { name: /^(对话|Chat)$/ }).first().click();
    await page.waitForURL(url => url.pathname === '/expert-conversations');
    await page.getByTestId('message-user').filter({ hasText: input }).waitFor({ timeout: 30000 });
    const originalUrl = page.url();
    await page.goto(coldGateway.baseUrl+'/');
    const projectSection = page.getByTestId('projects-section-toggle');
    await projectSection.waitFor({timeout:30000});
    if (await projectSection.getAttribute('aria-expanded') === 'false') await projectSection.click();
    const projectButtons = page.getByTestId('project-item-button');
    await projectButtons.first().waitFor({timeout:30000});
    for (let index = 0; index < await projectButtons.count(); index++) {
      if (await projectButtons.nth(index).getAttribute('aria-expanded') === 'false') await projectButtons.nth(index).click();
    }
    const homeTask = page.getByTestId(`runtime-local-task-row-kcoder:local:${thread.id}`);
    try { await homeTask.waitFor({timeout:30000}); }
    catch(error) {
      await context.writeArtifactJson('home-index-diagnostics.json',await page.evaluate(()=>({
        sidebar:document.querySelector('[data-testid="sidebar-worklists-scroll"]')?.textContent,
        projectButtons:[...document.querySelectorAll('[data-testid="project-item-button"]')].map(row=>({text:row.textContent,expanded:row.getAttribute('aria-expanded')})),
        tasks:[...document.querySelectorAll('[data-testid^="runtime-local-task-row-"]')].map(row=>({id:row.getAttribute('data-testid'),text:row.textContent})),
      })));
      await page.screenshot({path:context.pathInArtifacts('home-index-failure.png'),fullPage:true});throw error;
    }
    assert.equal(await homeTask.count(), 1, 'The home project/task index references the same persisted expert task');
    await homeTask.click();
    await page.getByTestId('message-user').filter({hasText:input}).waitFor({timeout:30000});
    assert.equal(model.requests.length, 1, 'Opening the original expert chat and home index must not execute');
    await page.goto(originalUrl);
    await page.getByTestId('message-user').filter({hasText:input}).waitFor({timeout:30000});
    await page.screenshot({ path: context.pathInArtifacts('expert-original-conversation.png'), fullPage: true });
    await page.goto(`${coldGateway.baseUrl}/tasks`);
    await page.getByTestId('task-board-list').waitFor({ timeout: 30000 });
    await page.getByTestId('task-board-list-row').first().waitFor({timeout:30000});
    assert.equal(await page.getByTestId('task-board-list-row').count(), 1, 'The task board references the same persisted expert task');
    assert.equal(model.requests.length, 1, 'Checking the ordinary index must not execute the expert');
    await page.goto(originalUrl);
    await page.getByTestId('message-user').filter({ hasText: input }).waitFor({ timeout: 30000 });
    await page.reload();
    await page.getByTestId('message-user').filter({ hasText: input }).waitFor({ timeout: 30000 });
    assert.equal(page.url(), originalUrl);
    assert.equal(model.requests.length, 1, 'Reload must restore the same original conversation');
    await page.getByRole('button', { name: /^(新建会话|New conversation)$/ }).first().click();
    const dialog = page.getByTestId('expert-task-dialog');
    await dialog.locator('select').selectOption('1');
    await dialog.getByRole('button', { name: /^(新建任务|Prepare task)$/ }).click();
    assert.equal(model.requests.length, 1, 'Preparing an expert draft never creates a turn');
    await page.getByTestId('chat-message-input').fill('Owned browser expert input');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-assistant').filter({ hasText: 'Original expert task result.' }).waitFor({ timeout: 30000 });
    assert.equal(model.requests.length, 2);
    assert.equal(new URL(page.url()).pathname, '/expert-conversations', 'A newly submitted expert conversation must retain its dedicated page');
    await page.locator('.expert-conversation-rail').waitFor();
    await page.reload();
    await page.getByTestId('message-user').filter({ hasText: 'Owned browser expert input' }).waitFor({ timeout: 30000 });
    assert.equal(model.requests.length, 2, 'The newly created task restores without duplicate execution');
    const activeSession = page.locator('.expert-conversation-session[data-selected="true"]');
    await activeSession.getByRole('button', {name:/^(更多操作|More actions)$/}).click();
    await page.getByTestId('expert-conversation-rename').click();
    const rename = page.getByTestId('expert-conversation-rename-dialog');
    await rename.locator('input').fill('Owned renamed expert conversation');
    await rename.getByRole('button', {name:/^(保\s*存|Save)$/}).click();
    await rename.waitFor({state:'hidden'});
    await page.reload();
    await page.locator('.expert-conversation-sessions').getByText('Owned renamed expert conversation',{exact:true}).waitFor();
    await page.getByTestId('message-user').filter({hasText:'Owned browser expert input'}).waitFor({timeout:30000});
    assert.equal(model.requests.length, 2);
    await page.screenshot({ path: context.pathInArtifacts('expert-new-conversation.png'), fullPage: true });
    await page.emulateMedia({colorScheme:'dark'});
    await page.evaluate(()=>document.documentElement.classList.add('dark'));
    await page.screenshot({path:context.pathInArtifacts('expert-conversation-dark.png'),fullPage:true});
    await context.writeArtifactJson('expert-conversation-geometry.json', await page.evaluate(() => Object.fromEntries(['.expert-conversation-rail','[data-testid="project-chat-composer"]','[data-testid="chat-message-input"]'].map(selector=>{const element=document.querySelector(selector);return [selector,element?element.getBoundingClientRect().toJSON():null]}))));
    await context.writeArtifactJson('expert-conversation-browser-proof.json', { cardEntry: true, originalNativeHistory: true, originalReload: true, homeIndexIncluded: true, taskBoardIncluded: true, independentChannelEntry: true, noGhostDraft: true, realBrowserTurn: true, loopbackProtocolCalls: model.requests.length, realModelBehaviorTested: false });
  }
  if (policyProbe) {
    const policyCalls = model.requests.length;
    const changed = structuredClone(definition);
    changed.instructions = 'SAVED_POLICY_PERSONALIZATION';
    changed.allowedTools = ['read', 'write', 'skill', 'DiscoverSkills'];
    changed.skills.find(skill => skill.enabled).allowedTools = ['Read'];
    const coldScope = await cold.request('integrations/scope/read');
    const savedDraft = await cold.request('integrations/assistant/saveDraft', {
      contractVersion: 'parallel-v1', requestId: 'policy-save', scope: coldScope,
      timeoutMs: 30000, operationId: 'policy-personalization', expectedRevision: String(draft.revision),
      payload: { definition: changed },
    });
    assert.equal(savedDraft.status, 'completed', JSON.stringify(savedDraft.error));
    assert.equal(model.requests.length, policyCalls, 'Saving expert policy cannot call a model');
    await closeRpcAndWait(cold);
    await context.stopOwned('cold-gateway');
    const restoredGateway = await startGateway(context, { label: 'policy-restored-gateway', auth: true, startTimeoutMs: 45000,
      workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: profile } });
    const restoredCookie = await login(restoredGateway.baseUrl, restoredGateway.authToken);
    context.registerSecret(restoredCookie);
    const restored = await openRpc(gatewayRpcUrl(restoredGateway, 'local', 'cookie-auth'), {
      headers: { Cookie: restoredCookie, Origin: restoredGateway.baseUrl },
    });
    context.addCleanup('close restored expert policy RPC', () => closeRpcAndWait(restored));
    await restored.request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'expert-unified-policy', version: '1' }, capabilities: { experimental: {
        agentDefinitionsV1: true, agentTurnConfigurationV1: true, integrationScopeV1: true,
        officeWorkspaceV1: true, threadCreationReceiptsV1: true,
      } } });
    await restored.request('thread/resume', { threadId: thread.id });
    const configuredTurn = await restored.request('turn/start', { threadId: thread.id,
      clientMessageId: 'policy-after-restart', input: [{ type: 'text', text: 'Owned policy after restart' }] });
    const configuredDone = await restored.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === thread.id && message.params?.turnId === configuredTurn.turn.id,
    30000, 'restored expert policy completion');
    await context.writeArtifactJson('restored-expert-turn.json', configuredDone);
    assert.equal(configuredDone.params.turn.status, 'completed', JSON.stringify(configuredDone));
    const actual = model.requests.at(-1);
    const names = (actual.tools ?? []).map(tool => tool.function?.name ?? tool.name);
    assert.ok(names.includes('read') && names.includes('skill'), JSON.stringify(names));
    assert.equal(names.includes('write'), false, 'Enabled skill restrictions must narrow the real request');
    assert.ok(JSON.stringify(actual).includes('SAVED_POLICY_PERSONALIZATION'));
    assert.equal(JSON.stringify(actual).includes('ORIGINAL_EXPERT_BASE'), false);
    const trace = await restored.request('thread/expert', { threadId: thread.id });
    assert.equal(trace.turns[0].personalizationRevision, savedDraft.result.draft.revision);
    await restored.request('thread/expert', { threadId: thread.id,
      change: { expectedRevision: trace.revision, expert: null } });
    const plainTurn = await restored.request('turn/start', { threadId: thread.id,
      clientMessageId: 'policy-cleared', input: [{ type: 'text', text: 'Owned plain task after expert' }] });
    const plainDone = await restored.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === thread.id && message.params?.turnId === plainTurn.turn.id,
    30000, 'cleared expert policy completion');
    await context.writeArtifactJson('cleared-expert-turn.json', plainDone);
    assert.equal(plainDone.params.turn.status, 'completed', JSON.stringify(plainDone));
    const plain = model.requests.at(-1);
    assert.ok(plain.tools.some(tool => (tool.function?.name ?? tool.name) === 'write'));
    assert.equal(JSON.stringify(plain).includes('SAVED_POLICY_PERSONALIZATION'), false);
    assert.equal(model.requests.length, policyCalls + 2);
    const restoredHistory = await restored.request('thread/read', { threadId: thread.id });
    for (const text of [input, 'Owned policy after restart', 'Owned plain task after expert'])
      assert.ok(JSON.stringify(restoredHistory).includes(text));
    await context.writeArtifactJson('expert-policy-unification.json', { sameThreadId: thread.id,
      savedRevision: savedDraft.result.draft.revision, toolsAfterRestore: names,
      skillRestrictionApplied: true, clearRestoresTaskTools: true, originalHistoryPreserved: true,
      loopbackProtocolCalls: model.requests.length, realModelBehaviorTested: false, platformMessages: 0 });
  }
  await context.writeArtifactJson('original-expert-task-proof.json', { nativeThread: thread.id, nativeTurn: turn.id, definition: reference,
    ordinaryKcoder: true, immutableCreationReplay: true, originalHistoryRead: true, coldOriginalHistory: true, enabledSkillOnly: true, loopbackProtocolCalls: model.requests.length,
    realModelBehaviorTested: false, feishuTested: false });
});
