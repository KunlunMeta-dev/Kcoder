import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startApprovalModelFixture } from './approval-model.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from './rpc.mjs';

export const widgetPresentation = Object.freeze({ version: 1, studioWorkMode: 'kworker', inlineWidgets: true });
export const widgetCaps = Object.freeze({ experimental: { studioWorkModesV1: true, inlineWidgetsV1: true } });
export const widgetSource = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 80"><rect x="10" y="10" width="100" height="50"/><text x="130" y="40">OWNED_TARGET_WIDGET</text></svg>';

export function widgetResponseSteps({ body }) {
  if ((body.messages ?? []).some(message => message.role === 'tool')) {
    return [{ delta: { role: 'assistant', content: 'Target visualization completed.' } }, { finishReason: 'stop' }];
  }
  const args = JSON.stringify({ title: 'Target proof', summary: 'Owned source read through the selected runtime', format: 'svg', widget_code: widgetSource });
  const split = args.indexOf('<text');
  const started = performance.now();
  return [
    { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'target-widget', type: 'function', function: { name: 'show_widget', arguments: args.slice(0, split) } }] } },
    { ready: () => performance.now() - started > 180, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] } },
    { finishReason: 'tool_calls' },
  ];
}
export function widgetSettings(endpoint) {
  return { active_provider: 'fixture', permission_mode: 'bypass', session_memory: { enabled: false },
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint,
      default_model: 'fixture', context_window_tokens: 128000, output_headroom_tokens: 2048,
      max_output_tokens: 2048, max_retries: 0, no_proxy: true } }, tools: { profile: 'full', luna: { allowed: ['read'] } } };
}
export async function startWidgetModelFixture(context) {
  return startApprovalModelFixture(context, { responseSteps: widgetResponseSteps });
}
export async function exerciseWidgetTarget(context, gateway, serverId, token, workspace) {
  const url = gatewayRpcUrl(gateway, serverId, token);
  const initialize = (rpc, caps) => rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-widget-target', version: '1' }, ...(caps ? { capabilities: caps } : {}) });
  const connect = async (label, caps) => { const rpc = await openRpc(url); context.addCleanup(`close ${serverId} ${label}`, () => closeRpcAndWait(rpc)); const acknowledged = await initialize(rpc, caps); return { rpc, acknowledged }; };
  // The legacy first client cannot suppress later presentation negotiation or
  // inherit it from the broker's shared backend connection.
  const { rpc: legacy } = await connect('legacy peer');
  const { rpc: owner, acknowledged } = await connect('widget owner', widgetCaps);
  const { rpc: peer } = await connect('unowned peer', widgetCaps);
  assert.equal(acknowledged.capabilities.experimental.studioWorkModesV1, true);
  assert.equal(acknowledged.capabilities.experimental.inlineWidgetsV1, true);
  const { thread } = await owner.request('thread/start', { studioWorkMode: 'kworker', cwd: workspace });
  assert.equal(thread.studioWorkMode, 'kworker');
  const catalog = await owner.request('tools/catalog', { threadId: thread.id, clientPresentation: widgetPresentation });
  assert.ok(JSON.stringify(catalog).includes('show_widget'));
  const legacyCatalog = await legacy.request('tools/catalog');
  assert.ok(!JSON.stringify(legacyCatalog).includes('show_widget'));
  const { turn } = await owner.request('turn/start', { threadId: thread.id, clientPresentation: widgetPresentation, input: [{ type: 'text', text: 'OWNED_WIDGET_TARGET_PROTOCOL' }] });
  const completedItem = await owner.waitFor(message => message.method === 'item/completed' && message.params?.threadId === thread.id && message.params?.item?.id === 'target-widget', 25000, 'owned widget result');
  const widget = completedItem.params.item.widgetRef;
  assert.equal(widget.threadId, thread.id); assert.equal(widget.turnId, turn.id); assert.equal(widget.executionMode, 'managed');
  await owner.request('widget/render/receipt', { widget: { threadId: thread.id, widgetId: widget.widgetId, revision: widget.revision }, turnId: turn.id, attemptId: widget.attemptId, toolCallId: widget.toolCallId, status: 'rendered' });
  const terminal = await owner.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === thread.id && message.params?.turnId === turn.id, 15000, 'widget turn completion');
  assert.equal(terminal.params.turn.status, 'completed');
  const bound = { threadId: thread.id, widgetId: widget.widgetId, revision: widget.revision };
  const read = await owner.request('widget/read', bound); assert.deepEqual(read.widget, widget);
  const content = await owner.request('widget/content/read', bound);
  const bytes = Buffer.from(content.dataBase64, 'base64'); assert.equal(createHash('sha256').update(bytes).digest('hex'), widget.sha256); assert.equal(bytes.toString(), widgetSource);
  const listed = await owner.request('widget/list', { threadId: thread.id }); assert.equal(listed.widgets.length, 1);
  await assert.rejects(peer.request('widget/read', bound), /own|resident|thread|owner/i);
  await assert.rejects(legacy.request('widget/read', bound), /inlineWidgetsV1|capabilit|negotiat/i);
  const previews = owner.messages().filter(message => message.method === 'item/event' && message.params?.event?.type === 'widget_input_preview');
  assert.ok(previews.length >= 1, 'real Provider deltas reach the selected target and Gateway');
  assert.equal(peer.messages().filter(message => message.params?.item?.widgetRef).length, 0, 'unowned peer does not receive trusted references');
  await closeRpcAndWait(owner);
  await peer.request('thread/resume', { threadId: thread.id });
  const recovered = await peer.request('widget/read', bound); assert.deepEqual(recovered.widget, widget);
  await closeRpcAndWait(peer); await closeRpcAndWait(legacy);
  return { serverId, sha256: widget.sha256, sourceBytes: bytes.length, streamingPreviews: previews.length,
    persistedMode: true, legacyFiltered: true, exactArtifactRead: true, crossClientRejected: true, recovered: true };
}
