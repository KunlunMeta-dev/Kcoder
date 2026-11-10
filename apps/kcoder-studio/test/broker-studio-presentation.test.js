import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerStudioPresentation } from '../src/broker-studio-presentation.js';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const caps = { studioWorkModesV1: true, inlineWidgetsV1: true };
const init = experimental => ({ params: { protocolVersion: '2026-07-27',
  clientInfo: { name: 'presentation-test-client', version: '1' }, capabilities: { experimental } } });
const turn = presentation => ({ method: 'turn/start', params: { threadId: 'office', clientPresentation: presentation } });

test('backend sharing never transfers opt-ins or trusts a client name', () => {
  const projection = new BrokerStudioPresentation();
  const studio = {}, cli = {};
  projection.attach(studio); projection.attach(cli);
  projection.initialize(studio, init(caps));
  projection.initialize(cli, { ...init({}), clientInfo: { name: 'kcoder-studio' } });
  const response = { result: { capabilities: { experimental: caps } } };
  assert.deepEqual(projection.project(response, studio).result.capabilities.experimental, caps);
  assert.deepEqual(projection.project(response, cli).result.capabilities.experimental,
    { studioWorkModesV1: false, inlineWidgetsV1: false });
  assert.match(projection.validate(cli, turn({ version: 1, studioWorkMode: 'kworker' }), caps, cli), /negotiation/);
  assert.equal(projection.validate(cli, { method: 'turn/start', params: { threadId: 'office' } }, caps, cli), null);
});

test('each presentation declaration checks current owner, bound mode and version', () => {
  const projection = new BrokerStudioPresentation(); const client = {}, peer = {};
  projection.attach(client); projection.initialize(client, init(caps));
  projection.response('thread/resume', { thread: { id: 'office', studioWorkMode: 'kworker' } });
  const declaration = { version: 1, studioWorkMode: 'kworker', inlineWidgets: true };
  assert.equal(projection.validate(client, turn(declaration), caps, client), null);
  assert.match(projection.validate(client, turn(declaration), caps, peer), /resumed/);
  assert.match(projection.validate(client, turn({ ...declaration, studioWorkMode: 'kcoder' }), caps, client), /creation mode/);
  assert.match(projection.validate(client, turn({ ...declaration, version: 2 }), caps, client), /version 1/);
  assert.match(projection.validate(client, turn(declaration), { studioWorkModesV1: true }, client), /inlineWidgetsV1/);
  assert.equal(projection.validate(client, { method: 'tools/catalog', params: { clientPresentation: declaration } }, caps, null), null);
});

test('reinitialization cannot escalate a connection and old thread modes default to KCoder', () => {
  const projection = new BrokerStudioPresentation(); const client = {};
  projection.attach(client); projection.initialize(client, init({ studioWorkModesV1: true }));
  projection.initialize(client, init(caps));
  assert.equal(projection.inlineWidgets(client), false);
  projection.response('thread/resume', { thread: { id: 'office' } });
  assert.match(projection.validate(client, turn({ version: 1, studioWorkMode: 'kworker' }), caps, client), /creation mode/);
});

test('script rendering requires a separate current-client capability and inline declaration', () => {
  const projection = new BrokerStudioPresentation(), native = {}, browser = {};
  const backend = { ...caps, isolatedWidgetsV1: true };
  projection.attach(native); projection.initialize(native, init(backend));
  projection.attach(browser); projection.initialize(browser, init(caps));
  const declaration = { version: 1, studioWorkMode: 'kworker', inlineWidgets: true, isolatedWidgets: true };
  assert.equal(projection.validate(native, turn(declaration), backend, native), null);
  assert.match(projection.validate(browser, turn(declaration), backend, browser), /isolatedWidgetsV1/);
  assert.match(projection.validate(native, turn({ ...declaration, inlineWidgets: false }), backend, native), /inline widgets/);
  assert.equal(projection.project({ result: { capabilities: { experimental: backend } } }, browser)
    .result.capabilities.experimental.isolatedWidgetsV1, false);
});

test('historical widgets require the current client capability and owned thread, without office-mode escalation', () => {
  const projection = new BrokerStudioPresentation(); const viewer = {}, peer = {}, legacy = {};
  projection.attach(viewer); projection.initialize(viewer, init({ inlineWidgetsV1: true }));
  projection.attach(legacy); projection.initialize(legacy, init({}));
  projection.response('thread/resume', { thread: { id: 'office', studioWorkMode: 'kworker' } });
  for (const method of ['widget/list', 'widget/read', 'widget/content/read', 'widget/render/receipt']) {
    const request = { method, params: method === 'widget/render/receipt' ? { widget: { threadId: 'office' } } : { threadId: 'office' } };
    assert.equal(projection.validate(viewer, request, caps, viewer), null);
    assert.match(projection.validate(viewer, request, caps, peer), /resumed/);
    assert.match(projection.validate(legacy, request, caps, legacy), /negotiation/);
  }
});

test('broadcast projections omit source previews and trusted widget metadata for legacy peers', () => {
  const projection = new BrokerStudioPresentation(), studio = {}, cli = {};
  projection.attach(studio); projection.initialize(studio, init(caps));
  projection.attach(cli); projection.initialize(cli, init({}));
  const preview = { method: 'item/event', params: { event: { type: 'widget_input_preview',
    preview: { source: '<svg>UI-only preview</svg>' } } } };
  assert.equal(projection.notification(cli, preview), null);
  assert.equal(projection.notification(studio, preview), preview);
  const completed = { method: 'item/completed', params: { item: { id: 'owned-call', type: 'toolCall',
    output: { status: 'completed' }, widgetRef: { widgetId: 'trusted-widget' } } } };
  const projected = projection.notification(cli, completed);
  assert.equal(projected.params.item.widgetRef, undefined);
  assert.deepEqual(projected.params.item.output, { status: 'completed' });
  assert.equal(projection.notification(studio, completed), completed);
  assert.equal(completed.params.item.widgetRef.widgetId, 'trusted-widget');
});

test('real broker keeps cached and pending initialization scoped and freezes only the owned turn declaration', () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const broker = new WorkspaceAppServerBroker({ child, adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }), fromUpstream: message => ({ upstream: [], client: [message] }) }, maxMessageBytes: 1_048_576,
    serverId: 'ssh-target', residentThreads: true });
  const upstream = [];
  child.stdin.on('data', chunk => upstream.push(JSON.parse(chunk.toString())));
  const client = () => ({ channel: 'runtime', messages: [], send(message) { this.messages.push(message); return true; }, pause() {}, resume() {}, close() {} });
  const studio = client(), cli = client(); broker.attach(studio); broker.attach(cli);
  const receive = (owner, message) => broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', ...message }));
  const respond = message => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  receive(studio, { id: 1, method: 'initialize', ...init(caps) });
  receive(cli, { id: 2, method: 'initialize', ...init({}) });
  assert.equal(upstream.length, 1);
  respond({ id: upstream[0].id, result: { capabilities: { experimental: { ...caps, residentThreads: true } } } });
  assert.equal(studio.messages.at(-1).result.capabilities.experimental.inlineWidgetsV1, true);
  assert.equal(cli.messages.at(-1).result.capabilities.experimental.inlineWidgetsV1, false);
  receive(studio, { id: 3, method: 'thread/start', params: { studioWorkMode: 'kworker' } });
  respond({ id: upstream.at(-1).id, result: { thread: { id: 'office', studioWorkMode: 'kworker' } } });
  const declaration = { version: 1, studioWorkMode: 'kworker', inlineWidgets: true };
  receive(cli, { id: 4, ...turn(declaration) });
  assert.match(cli.messages.at(-1).error.message, /negotiation/);
  const priorCount = upstream.length;
  receive(studio, { id: 5, ...turn(declaration) });
  assert.equal(upstream.length, priorCount + 1);
  respond({ id: upstream.at(-1).id, result: { threadId: 'office', turn: { id: 'turn-office' } } });
  assert.deepEqual(broker.activeTurns.get('office').clientPresentation, declaration);
  declaration.inlineWidgets = false;
  assert.equal(broker.activeTurns.get('office').clientPresentation.inlineWidgets, true);
  child.emit('close', 0, null);
});

test('MCP Apps never inherits a peer capability and binds every method to an owned office thread', () => {
  const projection = new BrokerStudioPresentation(), native = {}, browser = {}, peer = {};
  const backend = { ...caps, isolatedWidgetsV1: true, mcpAppsV1: true };
  projection.attach(native); projection.initialize(native, init(backend));
  projection.attach(browser); projection.initialize(browser, init({ ...backend, mcpAppsV1: false }));
  projection.response('thread/resume', { thread: { id: 'office', studioWorkMode: 'kworker' } });
  projection.response('thread/resume', { thread: { id: 'coding', studioWorkMode: 'kcoder' } });
  for (const method of ['mcp/apps/read', 'mcp/apps/resourceRead', 'mcp/apps/resourceContentRead', 'mcp/apps/toolCall', 'mcp/apps/operationRead']) {
    const request = { method, params: { threadId: 'office' } };
    assert.equal(projection.validate(native, request, backend, native), null);
    assert.match(projection.validate(browser, request, backend, browser), /current-client/);
    assert.match(projection.validate(native, request, backend, peer), /resumed/);
    assert.match(projection.validate(native, { ...request, params: { threadId: 'coding' } }, backend, native), /kworker/);
    for (const cap of Object.keys(backend)) assert.match(projection.validate(native, request, { ...backend, [cap]: false }, native), /negotiation/);
  }
  assert.match(projection.validate(native, { method: 'mcp/apps/arbitrary', params: { threadId: 'office' } }, backend, native), /Unsupported/);
  assert.equal(projection.project({ result: { capabilities: { experimental: backend } } }, browser).result.capabilities.experimental.mcpAppsV1, false);
});
