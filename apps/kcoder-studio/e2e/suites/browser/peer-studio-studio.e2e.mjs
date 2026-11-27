import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { openOwnedPeerStudioPage } from '../../harness/peer-studio-browser.mjs';
import { observePeerStudioPage, seedPeerStudioPage, sendPeerStudioUi, assertPeerStudioSourceNavigation } from '../../harness/peer-studio-ui.mjs';
import { assertOrdinaryFollowupComposer } from '../../harness/ordinary-followup-composer.mjs';

const A = 'OWNED_STUDIO_A_ORIGINAL', B = 'OWNED_STUDIO_B_ORIGINAL', READY = 'OWNED_STUDIO_MATRIX_READY';
const FOLLOWUP = 'OWNED_STUDIO_A_ORDINARY_FOLLOWUP', FOLLOWUP_DONE = 'OWNED_STUDIO_A_FOLLOWUP_READY';
const TO_B = 'OWNED_STUDIO_A_PEER <b>untrusted literal</b>', TO_A = 'OWNED_STUDIO_B_PEER <img src=x onerror=alert(1)>';
process.umask(0o077);
await runE2E(import.meta.url, { testId: 'actual-two-studio-react-peer-ui-receipt-source-navigation', tier: 'full-integration',
  modelPolicy: 'Two independent real Chromium HTTP-cookie sessions and Native conversations in one owned profile/workspace. Actual React DOM two-way peer text, original receipt and navigation; deterministic Provider, no autonomous model/cross-target/Windows/Electron claim.' },
async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'frozen peer candidate');
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const historicalRendererSha = process.env.KCODER_E2E_HISTORICAL_RENDERER_SHA256;
  if (historicalRendererSha) {
    assert.match(historicalRendererSha, /^[a-f0-9]{64}$/);
    assert.ok(process.env.KCODER_E2E_RENDERER_ROOT && path.isAbsolute(process.env.KCODER_E2E_RENDERER_ROOT));
    const index = await readFile(path.join(process.env.KCODER_E2E_RENDERER_ROOT, 'index.html'));
    assert.equal(createHash('sha256').update(index).digest('hex'), historicalRendererSha);
    await context.writeArtifactJson('intentional-historical-renderer.json', { historicalReference: true,
      root: process.env.KCODER_E2E_RENDERER_ROOT, indexSha256: historicalRendererSha,
      purpose: 'Explicit immutable pre-fix regression reference; not evidence that current renderer sources passed.' });
  } else await assertRendererBuildFresh();
  const model = await startApprovalModelFixture(context, { textOnly: true,
    textOnlyResponse: ({ requestNumber }) => requestNumber === 2 ? FOLLOWUP_DONE : READY,
    delayedRequestNumber: 2, streamDelayMs: 350 });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'peer-studio-studio' });
  const profile = context.pathInState('profile');
  const settings = await context.writeStateJson('profile/settings.json', { active_provider: 'OwnedStudioPeer', credential_store: 'file',
    permission_mode: 'yolo', max_retries: 0, cross_session_messages: { enabled: true, wake_idle: false },
    auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
    providers: { OwnedStudioPeer: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'owned-studio-peer', no_proxy: true, discover_models: false, context_window_tokens: 128000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, capabilities: { text: true, tools: true, reasoning: false } } } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned Studio peer matrix', runtime: 'kcoder',
    transport: 'local', command: binary, workspace, settingsFile: settings }]);
  const gateway = await startGateway(context, { auth: true, workspace, serversFile: servers, kcoderBin: binary,
    peerNotificationDiagnostics: true, env: { KCODER_CONFIG_DIR: profile } });
  const { page: a } = await openOwnedPeerStudioPage(context, gateway, { label: 'peer-studio-a' });
  const { page: b } = await openOwnedPeerStudioPage(context, gateway, { label: 'peer-studio-b' });
  const aWire = observePeerStudioPage(a), bWire = observePeerStudioPage(b);
  try {
    const source = await seedPeerStudioPage(a, aWire, { marker: A, ready: READY, serverId: 'local' });
    const followup = await assertOrdinaryFollowupComposer(context, a, aWire, {
      threadId: source.threadId, prompt: FOLLOWUP, response: FOLLOWUP_DONE,
      expectedConfiguredModel: { model: 'owned-studio-peer', providerId: 'OwnedStudioPeer' } });
    const target = await seedPeerStudioPage(b, bWire, { marker: B, ready: READY, serverId: 'local' });
    assert.notEqual(source.threadId, target.threadId);
    const first = await sendPeerStudioUi(a, aWire, { targetTitle: B, text: TO_B });
    const bBubble = b.getByTestId('peer-agent-message').filter({ hasText: TO_B });
    await bBubble.waitFor({ timeout: 20_000 }); assert.equal(await bBubble.locator('b').count(), 0);
    assert.equal(await b.getByTestId('message-user').filter({ hasText: TO_B }).count(), 0);
    await b.screenshot({ path: context.pathInArtifacts('studio-b-peer-plain-text.png'), fullPage: true });
    assert.equal(first.settled.receipt.sourceAddress.threadId, source.threadId);
    assert.equal(first.settled.receipt.targetAddress.threadId, target.threadId);
    await assertPeerStudioSourceNavigation(b, bWire, bBubble, { sourceAddress: first.settled.receipt.sourceAddress,
      sourceMarker: A, serverId: 'local' });
    await b.screenshot({ path: context.pathInArtifacts('studio-b-original-source-navigation.png'), fullPage: true });
    await b.goto(target.url, { waitUntil: 'domcontentloaded' });
    await b.getByTestId('message-user').filter({ hasText: B }).waitFor();
    const back = await sendPeerStudioUi(b, bWire, { targetTitle: A, text: TO_A, expectedAddress: first.settled.receipt.sourceAddress });
    const aBubble = a.getByTestId('peer-agent-message').filter({ hasText: TO_A });
    await aBubble.waitFor({ timeout: 20_000 }); assert.equal(await aBubble.locator('img').count(), 0);
    assert.equal(await a.getByTestId('message-user').filter({ hasText: TO_A }).count(), 0);
    assert.equal(model.requests.length, 3, 'Two original seeds plus one explicit ordinary followup are the only Provider turns');
    await a.screenshot({ path: context.pathInArtifacts('studio-a-peer-original-receipt.png'), fullPage: true });
    await context.writeArtifactJson('actual-studio-studio-assertions.json', { actualReactChromium: true, actualHttpLogin: true,
      independentBrowserProfiles: true, independentNativeConversations: true, syntheticClientSubjects: false,
      binarySha256: sha256, source: first.settled.receipt.sourceAddress, destination: first.settled.receipt.targetAddress,
      messageIds: [first.settled.receipt.messageId, back.settled.receipt.messageId], twoOriginalReceiptsApplied: true,
      sourceNavigationReadsOriginal: true, sourceNavigationCreatesSessionOrTurn: false, peerMarkupMounted: false,
      providerRequests: model.requests.length, ordinarySameThreadFollowup: true,
      composerMaximumYShiftPx: followup.maximumYShiftPx, composerMaximumHeightShiftPx: followup.maximumHeightShiftPx,
      ordinaryFollowupQueueInsertions: followup.insertedQueueNodes.length,
      autonomousModelBehaviorProven: false, crossTargetProven: false });
    return { realStudioToStudioDom: true, originalReceiptsApplied: 2, originalSourceNavigation: true };
  } finally {
    await context.writeArtifactJson('studio-a-wire.json', aWire); await context.writeArtifactJson('studio-b-wire.json', bWire);
    await a.screenshot({ path: context.pathInArtifacts('studio-a-final.png'), fullPage: true }).catch(() => {});
    await b.screenshot({ path: context.pathInArtifacts('studio-b-final.png'), fullPage: true }).catch(() => {});
  }
});
