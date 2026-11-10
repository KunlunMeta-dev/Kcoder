import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl, initializeRpc, isTurnCompletion } from './rpc.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { repoRoot, requireExecutable } from './run-context.mjs';
import { WEB_FIXTURE_BUILD_TAG } from './web-search-network-fixture.mjs';

/** Copy only an explicitly feature-gated native executable into this run's ownership. */
export async function prepareWebNativeBinary(context, build = {}) {
  const input = await requireExecutable(process.env.KCODER_E2E_SEARCH_NATIVE_BIN || resolve(repoRoot, 'target/test/web-network-fixture/debug/kcoder'), 'Feature-gated native search fixture binary');
  const identity = await webNativeBinaryIdentity(input);
  const expectedSha = process.env.KCODER_E2E_SEARCH_NATIVE_SHA256;
  const expectedCheckpoint = process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT;
  assert.equal(expectedSha !== undefined, expectedCheckpoint !== undefined, 'Supply fixture SHA and source checkpoint together');
  if (expectedSha !== undefined) { assert.match(expectedSha, /^[a-f0-9]{64}$/); assert.match(expectedCheckpoint, /^[a-f0-9]{40}$/); assert.equal(identity.sha256, expectedSha, 'Exact frozen fixture binary required'); }
  assert.ok(identity.fixtureBuild, 'UNMET_PREREQUISITE: binary must be compiled with web-network-test-fixture');
  await mkdir(context.pathInState('native'), { recursive: true, mode: 0o700 });
  const binary = context.pathInState(process.platform === 'win32' ? 'native/kcoder.exe' : 'native/kcoder');
  await copyFile(input, binary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); await chmod(binary, 0o700);
  await context.writeArtifactJson('build-identity.json', { ...identity, feature: 'web-network-test-fixture', expectedCheckpoint, ...build });
  return { binary, identity };
}
export async function webNativeBinaryIdentity(path) {
  const hash = createHash('sha256'); let tail = Buffer.alloc(0), fixtureBuild = false;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); const joined = Buffer.concat([tail, chunk]); fixtureBuild ||= joined.includes(Buffer.from(WEB_FIXTURE_BUILD_TAG)); tail = joined.subarray(Math.max(0, joined.length - 256)); }
  return { sha256: hash.digest('hex'), fixtureBuild };
}

export function webNativeModelOnlySettings(network) {
  return { active_provider: 'owned-search-fixture', providers: { 'owned-search-fixture': {
    api_format: 'openai_chat_completions', endpoint: network.modelUrl, authentication: { mode: 'none' }, default_model: 'owned-search-model',
    context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 512, request_timeout_secs: 30, no_proxy: true,
  } } };
}
export function webNativeFixtureEnvironment(context, network, { label, configDir }) {
  return { KCODER_CONFIG_DIR: configDir, KCODER_E2E_WEB_NETWORK_FIXTURE: network.fixturePath,
    KCODER_SEARXNG_RUNTIME: context.pathInState(`${label}/missing-owned-searxng-component`),
    HTTP_PROXY: network.proxyUrl, HTTPS_PROXY: network.proxyUrl, http_proxy: network.proxyUrl, https_proxy: network.proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', SSL_CERT_FILE: network.caPath };
}

/** Model connection only: no web settings, search credentials, MCP declarations or tool overrides. */
export async function startWebNativeSession(context, { binary, network, label, extraTarget = false, allowedTools = undefined, targetId = 'main' }) {
  const rendererRoot = resolve(process.env.KCODER_E2E_RENDERER_ROOT || resolve(repoRoot, 'apps/kcoder-studio/renderer/dist'));
  const index = await stat(resolve(rendererRoot, 'index.html')).catch(() => null);
  assert.ok(index?.isFile(), 'Native Gateway fixture requires an existing frozen renderer index; set KCODER_E2E_RENDERER_ROOT before startup');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: `${label}-${network.fixtureId}` });
  const document = webNativeModelOnlySettings(network);
  if (allowedTools !== undefined) document.allowed_tools = allowedTools;
  const settingsFile = await context.writeStateJson(`${label}/config/settings.json`, document);
  const settingsBytes = await readFile(settingsFile);
  const servers = [{ id: targetId, label, transport: 'local', runtime: 'kcoder', command: binary, workspace, settingsFile }];
  if (extraTarget) {
    const other = await materializeWorkspace(context, 'minimal', { instanceId: `${label}-other-${network.fixtureId}` });
    servers.push({ id: 'other', label: `${label}-other`, transport: 'local', runtime: 'kcoder', command: binary, workspace: other.path, settingsFile });
  }
  const serversFile = await context.writeStateJson(`${label}/servers.json`, servers);
  const gateway = await startGateway(context, { label: `${label}-gateway`, workspace, kcoderBin: binary, serversFile, serversStore: context.pathInState(`${label}/servers-store.json`), auth: true,
    env: { ...webNativeFixtureEnvironment(context, network, { label, configDir: dirname(settingsFile) }), KCODER_STUDIO_WEB_ROOT: rendererRoot },
  });
  let actualChildWebRoot;
  if (process.platform === 'linux') {
    // Inspect only this owned child, retaining one public resource-path field.
    // The complete environment and its private token are never persisted.
    const environment = await readFile(`/proc/${gateway.child.pid}/environ`);
    actualChildWebRoot = environment.toString('utf8').split('\0').find(value => value.startsWith('KCODER_STUDIO_WEB_ROOT='))?.slice('KCODER_STUDIO_WEB_ROOT='.length);
    assert.equal(actualChildWebRoot, rendererRoot, 'The actual isolated Gateway child must receive the frozen web root');
  }
  await context.writeArtifactJson(`${label}/gateway-renderer-input.json`, { rendererRoot, indexExists: true, actualChildWebRoot, verification: process.platform === 'linux' ? 'owned-child-environment' : 'explicit-spawn-input' });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const connect = async (name, target = targetId, experimental = undefined) => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, target, token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${label} ${name} RPC`, () => closeRpcAndWait(rpc));
    if (experimental === undefined) await initializeRpc(rpc, `${label}-${name}`);
    else await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: `${label}-${name}`, version: '1' }, capabilities: { experimental } });
    return rpc;
  };
  return { gateway, workspace, settingsFile, connect,
    async assertSettingsUnchanged() { assert.deepEqual(await readFile(settingsFile), settingsBytes); },
    async assertModelOnlySettings() { assert.deepEqual(await readFile(settingsFile), settingsBytes); assert.deepEqual(Object.keys(document).sort(), ['active_provider', 'providers']); },
  };
}

export async function startWebNativeTurn(rpc, prompt = '请运行受控网页搜索协议验收。', existingThreadId = undefined) {
  const thread = existingThreadId ? { id: existingThreadId } : (await rpc.request('thread/start', {})).thread;
  const { turn } = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
  return { threadId: thread.id, turnId: turn.id };
}
export async function approveWebNativeSearch(rpc, turn) {
  return approveWebNativeTool(rpc, turn, 'WebSearch');
}
export async function approveWebNativeTool(rpc, turn, name) {
  const request = await rpc.waitFor(frame => frame.method === 'approval/request' && frame.params?.threadId === turn.threadId && frame.params?.turnId === turn.turnId && frame.params?.action?.type === 'tool' && frame.params.action.name === name, 30000, `actual native ${name} permission`);
  assert.equal(request.params.action.name, name);
  rpc.respond(request.id, { decision: 'accept' }); return request;
}
export async function completeWebNativeTurn(rpc, turn, timeoutMs = 45000) {
  const completed = await rpc.waitFor(frame => isTurnCompletion(frame, turn.threadId, turn.turnId), timeoutMs, 'native ordinary turn terminal outcome');
  const receipts = rpc.messages().flatMap(frame => {
    const item = frame.params?.item;
    if (frame.method !== 'item/completed' || frame.params?.threadId !== turn.threadId || frame.params?.turnId !== turn.turnId || !item?.webSources) return [];
    const receipt = item.webSources;
    assert.equal(receipt.identity.threadId, turn.threadId); assert.equal(receipt.identity.turnId, turn.turnId);
    assert.equal(receipt.identity.attemptId, frame.params.attemptId); assert.equal(receipt.toolCallId, item.id);
    return [receipt];
  });
  return { completed, receipts };
}
