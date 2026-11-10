import assert from 'node:assert/strict';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { startMcpAppJoint } from '../../harness/mcp-app-joint.mjs';
import { startChromium } from '../../harness/chromium.mjs';

await runE2E(import.meta.url, { testId: 'real-provider-mcp-artifact-react-native-app-permissions', tier: 'manual-live',
  modelPolicy: 'model-independent actual Gateway/Rust/MCP/SSE and production React/native host; no paid model calls, typed fake receipt or direct permission replies', cleanupTimeoutMs: 15000 }, async context => {
  const fixture = await startMcpAppJoint(context);
  console.log(`NATIVE_MCP_JOINT_URL=${fixture.url}`);
  if (process.env.KCODER_E2E_MCP_JOINT_LOCAL_PROBE === '1') {
    const chromium = await startChromium(context, { label: 'mcp-joint-local-browser' });
    const page = await chromium.newPage({ viewport: { width: 1200, height: 900 } });
    let startupNetworkChanged=false;
    page.on('requestfailed',value=>{if(value.failure()?.errorText==='net::ERR_NETWORK_CHANGED')startupNetworkChanged=true;});
    await page.goto(fixture.url);
    try{await page.getByTestId('joint-begin').waitFor({timeout:5000});}catch(error){
      if(!startupNetworkChanged||fixture.begin())throw error;
      await page.reload();
    }
    await page.getByTestId('joint-begin').click();
    const card = page.getByTestId('joint-approval'); await card.waitFor();
    assert.match(await card.innerText(), /mcp__owned-server__chart/);
    await card.locator('[data-testid^="request-user-input-option-"]').first().click();
    await waitFor(async () => (await fixture.snapshot()).modelRequests === 2, 30000, 'real provider resumes after the ordinary approval UI');
    await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-testid=joint-message-statuses]').textContent).every(value=>value.status!=='streaming'));
    assert.equal(await page.getByTestId('joint-error').innerText(), '');
    const snapshot = await fixture.snapshot(); assert.equal(snapshot.chartCalls, 1); assert.equal(snapshot.refreshCalls, 0); assert.equal(snapshot.hookCalls, 0); assert.ok(snapshot.widget?.mcpApp);
    await page.getByTestId('joint-history').click();await page.getByTestId('joint-history-state').filter({hasText:'readonly-history'}).waitFor();
    assert.equal((await fixture.snapshot()).history,true);assert.equal((await fixture.snapshot()).sameBackendProcess,true);
    await context.writeArtifactJson('local-prerequisite-only.json', { normalApprovalCard: true, realMcpArtifact: true, fakePermissionResponse: false, nativeVerified: false, scope: 'Linux browser prerequisite only; the actual native App bridge is still unverified', snapshot });
    return { localPrerequisiteProbePassed: true, nativeVerified: false };
  }
  await waitFor(()=>fixture.nativeStarted(),900000,'Windows native probe start acknowledgement',100,context.abortSignal);
  await waitFor(() => fixture.finished(), 300000, 'Windows production native MCP joint report', 100, context.abortSignal);
  const snapshot = await fixture.snapshot();
  assert.equal(snapshot.modelRequests, 2); assert.equal(snapshot.chartCalls, 1); assert.equal(snapshot.refreshCalls, 1); assert.equal(snapshot.hookCalls, 1); assert.equal(snapshot.history, true); assert.equal(snapshot.sameBackendProcess, true);
  assert.ok(snapshot.rpcObservations.filter(value => value.method === 'mcp/apps/resourceContentRead').length >= 3, 'resource must cross real bounded chunks');
  await context.writeArtifactJson('real-native-backend-results.json', snapshot);
  return { nativeProbeCompleted: true, actualBackendChecked: true, modelFees: 0 };
});
