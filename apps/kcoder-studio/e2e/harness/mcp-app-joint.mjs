import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { openRpc, gatewayRpcUrl, closeRpcAndWait } from './rpc.mjs';
import { appRoot, repoRoot, waitFor } from './run-context.mjs';
import { createWidgetSandboxRoute } from '../../src/widget-sandbox-route.js';

const methods = new Set(['widget/list', 'widget/read', 'widget/content/read', 'widget/render/receipt', 'mcp/apps/read', 'mcp/apps/resourceRead', 'mcp/apps/resourceContentRead', 'mcp/apps/toolCall', 'mcp/apps/operationRead']);
const caps = { experimental: { studioWorkModesV1: true, inlineWidgetsV1: true, isolatedWidgetsV1: true, mcpAppsV1: true, interactionBindingV1: true } };
const presentation = { version: 1, studioWorkMode: 'kworker', inlineWidgets: true, isolatedWidgets: true };
export function validateJointRequest(value, threadId, widget) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(methods.has(value.method), 'unsupported joint adapter method');
  const params = value.params ?? {};
  assert.ok(params && typeof params === 'object' && !Array.isArray(params));
  assert.equal(params.threadId ?? params.widget?.threadId, threadId, 'foreign thread');
  if (value.method !== 'widget/list') {
    assert.ok(widget, 'no authoritative widget yet');
    assert.equal(params.widgetId ?? params.widget?.widgetId, widget.widgetId, 'foreign artifact');
    assert.equal(params.revision ?? params.widget?.revision, widget.revision, 'foreign revision');
    if (value.method.startsWith('mcp/apps/')) assert.equal(params.connectionId, widget.mcpApp.connectionId, 'foreign original connection');
  }
  return value;
}
async function jsonBody(request) {
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; assert.ok(length <= 128 * 1024, 'adapter request exceeds budget'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function startMcpAppJoint(context) {
  const sourceFiles=['renderer/src/components/chat/widgets/McpAppWidget.tsx','renderer/src/components/chat/widgets/mcpAppDispatcher.ts','renderer/src/features/widgets/IsolatedHtmlWidgetHost.tsx','renderer/src/kcoder/gateway/runtime/interactions.ts','renderer/src/features/workbench/runtimePaneMessages.ts'];
  const hashes=async()=>Promise.all(sourceFiles.map(async file=>({file,sha256:createHash('sha256').update(await readFile(resolve(appRoot,file))).digest('hex')})));
  const sourceIdentity=await hashes();
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'mcp-joint' });
  const mcpDirectory = context.pathInState('mcp'); await mkdir(mcpDirectory);
  const hookPath = context.pathInState('post-tool-hook.log');
  let widget;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    if ((body.messages ?? []).some(message => message.role === 'tool')) {
      assert.ok(widget, 'final response must reference actual trusted execution metadata');
      return [{ delta: { role: 'assistant', content: `真实 MCP App 已生成。\n\n::kcoder-widget{widget_id="${widget.widgetId}" revision=${widget.revision}}` } }, { finishReason: 'stop' }];
    }
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'joint-chart', type: 'function', function: { name: 'mcp__owned-server__chart', arguments: '{"value":7}' } }] } }, { finishReason: 'tool_calls' }];
  } });
  const settings = await context.writeStateJson('settings.json', { active_provider: 'fixture', permission_mode: 'ask', session_memory: { enabled: false },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 2048, max_retries: 0, no_proxy: true } },
    tools: { profile: 'full', luna: { allowed: ['mcp__owned-server__chart', 'mcp__owned-server__refresh'] } },
    mcp_servers: [{ name: 'owned-server', transport: 'stdio', command: 'python3', args: [resolve(repoRoot, 'crates/kcoder_mcp/tests/fixtures/apps_server.py'), 'joint', mcpDirectory] }] });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await context.writeStateJson('config/settings.json', { hooks: { PostToolUse: [{ matcher: 'mcp__owned-server__refresh', hooks: [{ type: 'command', command: `printf 'hook\\n' >> ${quote(hookPath)}` }] }] } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'joint', label: 'Owned real MCP joint runtime', transport: 'local', command: binary, workspace, settingsFile: settings }]);
  const gateway = await startGateway(context, { label: 'mcp-joint-gateway', workspace, serversFile: servers, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('config'), XDG_CONFIG_HOME: context.pathInState('config') } });
  const rpcUrl = gatewayRpcUrl(gateway, 'joint', await waitForGatewayRpcToken(context, gateway));
  const connect = async label => { const rpc = await openRpc(rpcUrl); context.addCleanup(`close joint ${label}`, () => closeRpcAndWait(rpc)); const acknowledged = await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: label, version: '1' }, capabilities: caps }); return { rpc, acknowledged }; };
  let { rpc: owner, acknowledged } = await connect('native UI owner');
  const { rpc: observer } = await connect('shared broker observer');
  const { thread } = await owner.request('thread/start', { studioWorkMode: 'kworker', cwd: workspace });
  const actualProcessId = (await owner.request('server/resources/read')).processId;
  assert.equal((await observer.request('server/resources/read')).processId, actualProcessId);
  const frames = []; const approvals = new Map(); const rpcObservations = []; let eventSequence = 0, began = false, history = false, finished = false,nativeStarted=false;
  const capture = event => {
    const frame = JSON.parse(event.data);
    if (!frame.method || frame.params?.threadId !== thread.id) return;
    if (frame.method === 'item/completed' && frame.params.item?.id === 'joint-chart') { assert.ok(frame.params.item.widgetRef?.mcpApp); widget = frame.params.item.widgetRef; }
    if (frame.method === 'approval/request') approvals.set(frame.id, frame.params);
    if (frame.method === 'approval/resolved') approvals.delete(frame.params.requestId);
    frames.push({ sequence: ++eventSequence, frame }); assert.ok(frames.length <= 1024, 'joint event budget exceeded');
  };
  owner.socket.addEventListener('message', capture);
  const snapshot = async () => {
    const log = await readFile(resolve(mcpDirectory, 'messages.jsonl'), 'utf8').catch(() => '');
    const requests = log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const calls = requests.filter(request => request.method === 'tools/call');
    const hooks = await readFile(hookPath, 'utf8').catch(() => '');
    return { modelRequests: model.requests.length, chartCalls: calls.filter(call => call.params.name === 'chart').length,
      refreshCalls: calls.filter(call => call.params.name === 'refresh').length, hookCalls: hooks.trim().split('\n').filter(Boolean).length,
      pendingApprovals: [...approvals.values()].map(value => ({ approvalId: value.approvalId, turnId: value.turnId })),
      rpcObservations, widget, history, sameBackendProcess: (await observer.request('server/resources/read')).processId === actualProcessId };
  };
  const renderer = resolve(appRoot, 'renderer'); const require = createRequire(resolve(renderer, 'package.json'));
  const { createServer: createViteServer } = require('vite');
  const reactModule=require('@vitejs/plugin-react');
  const react=reactModule.default??reactModule;
  const version=JSON.parse(await readFile(resolve(renderer,'package.json'),'utf8')).version;
  const tailwindConfig=require('tailwindcss/loadConfig')(resolve(renderer,'tailwind.config.js'));
  const tailwind=require('tailwindcss')({...tailwindConfig,content:[resolve(renderer,'src/**/*.{ts,tsx}'),resolve(renderer,'e2e/fixtures/*.{ts,tsx}'),resolve(renderer,'node_modules/streamdown/dist/*.js')]});
  // Use the production source/React transform without the unrelated file-viewer
  // packaging plugin, which copies generated assets outside a RunContext.
  const vite = await createViteServer({ root: renderer, configFile:false,plugins:[react()],css:{postcss:{plugins:[tailwind,require('autoprefixer')()]}},define:{__KCODER_STUDIO_APP_VERSION__:JSON.stringify(version)},resolve:{alias:{'@':resolve(renderer,'src'),'@xmldom/xmldom':resolve(renderer,'src/lib/browser-dom-parser.ts'),'@wecode':resolve(renderer,'wecode'),'@extensions':resolve(renderer,'src/extensions')}},cacheDir: context.pathInState('vite-cache'), appType: 'mpa', logLevel: 'error', server: { middlewareMode: true, hmr: false } });
  context.addCleanup('close owned joint Vite middleware', () => vite.close());
  const sandbox = createWidgetSandboxRoute({ roots: [resolve(renderer, 'public')] });
  const server = createServer((request, response) => {
    const handle = async () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (await sandbox(request, response, url.pathname)) return;
      if (!url.pathname.startsWith('/__mcp_joint/')) { vite.middlewares(request, response, () => { response.writeHead(404); response.end(); }); return; }
      const host = request.headers.host ?? '';
      assert.match(host, /^(127\.0\.0\.1|localhost):\d+$/);
      assert.equal(request.headers['x-kcoder-joint'], '1', 'owned adapter header required');
      if (request.headers.origin) assert.equal(request.headers.origin, `http://${host}`, 'foreign adapter origin');
      const send = value => { const body = JSON.stringify(value); assert.ok(Buffer.byteLength(body) <= 1024 * 1024, 'adapter response exceeds budget'); response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body); };
      if (request.method === 'GET' && url.pathname === '/__mcp_joint/bootstrap') return send({ thread, widget, workspace, serverId: 'joint', taskId: `kcoder:joint:${thread.id}`, acknowledged, began, history });
      if (request.method === 'GET' && url.pathname === '/__mcp_joint/events') {
        const after = Number(url.searchParams.get('after') ?? 0); assert.ok(Number.isSafeInteger(after) && after >= 0);
        return send({ frames: frames.filter(value => value.sequence > after && (!history || value.frame.id === undefined)).slice(0, 32) });
      }
      if (request.method === 'GET' && url.pathname === '/__mcp_joint/snapshot') return send(await snapshot());
      assert.equal(request.method, 'POST'); const value = await jsonBody(request);
      if(url.pathname==='/__mcp_joint/native-start'){assert.equal(value.platform,'win32');nativeStarted=true;return send({started:true});}
      if (url.pathname === '/__mcp_joint/begin') {
        assert.equal(began, false, 'generation is never replayed'); began = true;
        return send(await owner.request('turn/start', { threadId: thread.id, clientPresentation: presentation, input: [{ type: 'text', text: 'Create the controlled real MCP App' }] }));
      }
      if (url.pathname === '/__mcp_joint/rpc') {
        validateJointRequest(value, thread.id, widget);
        const result = await owner.request(value.method, value.params);
        rpcObservations.push({ method: value.method, operationId: value.params?.operationId, status: result?.status, nextOffset: result?.nextOffset }); assert.ok(rpcObservations.length <= 512);
        return send(result);
      }
      if (url.pathname === '/__mcp_joint/approval') {
        const pending = approvals.get(value.id); assert.ok(pending, 'no original pending approval'); assert.equal(value.result?.approvalId, pending.approvalId); assert.equal(value.result?.threadId, thread.id); assert.equal(value.result?.turnId, pending.turnId); assert.ok(['accept', 'decline'].includes(value.result?.decision)); owner.respond(value.id, value.result); return send({ submitted: true });
      }
      if (url.pathname === '/__mcp_joint/history') {
        assert.ok(widget); await closeRpcAndWait(owner); await observer.request('thread/resume', { threadId: thread.id });
        const read = await observer.request('mcp/apps/read', { threadId: thread.id, widgetId: widget.widgetId, revision: widget.revision, connectionId: widget.mcpApp.connectionId }); assert.equal(read.live, false, 'detached owner cannot leave a live connection in a shared broker');
        owner = observer; history = true; return send({ history: true });
      }
      if (url.pathname === '/__mcp_joint/finish') {
        const report=value.nativeReport;
        assert.equal(report?.platform,'win32');assert.equal(report.electron,'42.3.3');assert.match(report.chromium,/^148\./);assert.equal(report.noSandboxSwitch,false);assert.equal(report.capability?.isolatedHtml,true);
        assert.notEqual(report.processIds?.parent,report.processIds?.app);assert.equal(report.widgetSha256,widget.sha256);assert.equal(report.failure,null);
        for(const key of ['actualProductionController','actualProductionPreload','permissionCardVisible','originalInputAndMeta','resourceRead','declineVerified','acceptVerified','ledgerExactlyOnce','approvalRowsSettled','sameBackendProcess','historyReadonly','allOwnedLeasesReleased','childHasNoNativeApi','parentDomBlocked'])assert.equal(report[key],true,key);
        assert.deepEqual(await hashes(),sourceIdentity,'production React source changed during joint verification');
        await context.writeArtifactJson('native-react-mcp-report.json',{report,sourceIdentity});
        const result=await snapshot();finished=true;return send(result);
      }
      throw new Error('unsupported owned adapter route');
    };
    handle().catch(error => { if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: String(error.message) })); });
  });
  context.addCleanup('close owned MCP joint HTTP adapter', () => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen)); context.registerPort('mcp-joint-native-ui', server.address().port);
  const origin = `http://127.0.0.1:${server.address().port}`; const url = `${origin}/e2e/fixtures/mcp-app-joint.html`;
  await context.writeArtifactJson('native-ready.json', { url, origin, threadId: thread.id, sourceIdentity, ownedActualGateway: true, actualRustMcpArtifact: true, nativeVerified: false });
  return { url, origin, thread, snapshot, finished: () => finished,nativeStarted:()=>nativeStarted, gateway, begin: () => began };
}
