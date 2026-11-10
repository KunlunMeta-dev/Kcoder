import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

export async function seedMobileDirectory(context) {
  const root = context.pathInState('explicit-source-product');
  for (const folder of [root, resolve(root, 'skills/directory-office'), resolve(root, 'projects/opaque-directory')]) await mkdir(folder, { recursive: true, mode: 0o700 });
  const sessionId = randomUUID();
  await writeFile(resolve(root, 'settings.json'), JSON.stringify({ model: 'mobile-selected-directory-model', env: { ANTHROPIC_BASE_URL: 'https://selected-directory.example.invalid' } }), { mode: 0o600 });
  await writeFile(resolve(root, 'skills/directory-office/SKILL.md'), '---\nname: directory-office\ndescription: Review selected directory documents\n---\nMOBILE_DIRECTORY_SKILL\n', { mode: 0o600 });
  await writeFile(resolve(root, `projects/opaque-directory/${sessionId}.jsonl`), [0, 1, 2].map(index => JSON.stringify({ type: index === 1 ? 'assistant' : 'user', uuid: `directory-message-${index}`, sessionId, version: '2.1.301', message: { role: index === 1 ? 'assistant' : 'user', content: index === 0 ? 'MOBILE_SELECTED_DIRECTORY_HISTORY' : 'Static source content, never replayed.' } })).join('\n') + '\n', { mode: 0o600 });
  for (let index = 1; index <= 12; index++) {
    const file = resolve(root, `projects/opaque-directory/${sessionId}/subagents/agent-family-${index}.jsonl`);
    await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ type: 'user', uuid: `child-${index}`, sessionId, cwd: '/original-agent-worktree', version: '2.1.301', message: { role: 'user', content: `MOBILE_SELECTED_DIRECTORY_CHILD_${index}` } }) + '\n', { mode: 0o600 });
  }
  return { root };
}
/** Three real source-device directory consumers use the same Native transfer/adoption/batch chain. */
export async function exerciseMobileDirectory({ context, page, gateway, profile, workspace, fixture, model }) {
  const observer = await openOwnedMobileRpc(context, gateway, 'migration-target', workspace);
  const original = JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8'));
  const transfers = [];
  const onTransfer = request => { if (new URL(request.url()).pathname.endsWith('/api/migration/source-transfer/run')) transfers.push(request.postDataJSON()); };
  page.on('request', onTransfer);
  const requests = [], completed = []; let lost = null, dropGrant = true, checkpoint = { kind: null, stage: 'starting' };
  await page.route('**/api/migration/source-session/**', async route => {
    const body = route.request().postDataJSON(), method = new URL(route.request().url()).pathname.split('/').at(-1);
    const row = { method, kind: body.query?.kind, sessionId: body.session?.sessionId ?? body.sessionId, purpose: body.session?.purpose ?? body.purpose,
      selectionId: body.query?.kind === 'directory_select' ? body.query.params.selectionId : null };
    requests.push(row);
    if (body.query?.kind === 'directory_select' && dropGrant && body.query.params.directory === fixture.root) {
      const response = await route.fetch(); assert.equal(response.status(), 200); lost = body; dropGrant = false; row.droppedReply = true; await route.abort('failed'); return;
    }
    await route.continue();
  });
  const enabled = (value, label) => waitFor(async () => await value.count() === 1 && !await value.isDisabled(), 15000, label);
  const confirm = async keyword => { await page.getByTestId('migration-batch-confirm-input').fill(keyword); await page.getByTestId('migration-batch-confirm-submit').click(); };
  try {
    for (const kind of ['configuration', 'skill', 'history']) {
      checkpoint = { kind, stage: 'grant' };
      await page.getByTestId('migration-tab-source').click(); await page.getByTestId('migration-source-remote-mode').click(); await page.getByTestId('source-device-migration-target').click();
      const browser = page.getByTestId('migration-source-browser');
      await browser.getByTestId('source-browser-product-claude-code').click();
      if (kind === 'history') await browser.getByTestId('source-browser-mode-history').click();
      await browser.getByTestId('source-directory-explicit').click();
      const path = browser.getByTestId('source-directory-path'), find = browser.getByTestId('source-browser-discover');
      if (kind === 'configuration') {
        await path.fill(`${fixture.root}-missing`); await find.click();
        await enabled(find, 'failed directory authorization is settled'); assert.equal(await browser.locator('[data-testid^="source-browser-select-"]').count(), 0);
        assert.equal(await path.isEditable(), false, 'failed choice stays pinned until explicit release');
        assert.ok(requests.every(row => !['configuration', 'history', 'memory'].includes(row.kind)), 'failed authorization cannot scan a default home');
        await browser.getByTestId('source-browser-release').click(); await waitFor(() => path.isEditable(), 15000, 'only explicit source release permits a new choice');
      }
      await path.fill(fixture.root); await find.click();
      if (kind === 'configuration') {
        await waitFor(() => lost, 15000, 'accepted directory grant response deliberately lost'); await enabled(find, 'uncertain authorization can be explicitly reconciled');
        assert.equal(await path.isEditable(), false); assert.equal(await browser.locator('[data-testid^="source-browser-select-"]').count(), 0);
        await find.click();
      }
      await browser.locator('[data-testid^="source-browser-select-"]').first().waitFor();
      const choose = kind === 'history' ? browser.getByRole('button', { name: /MOBILE_SELECTED_DIRECTORY_HISTORY/ }) : browser.locator('[data-testid^="source-browser-row-"]').filter({ has: page.getByText(kind === 'skill' ? 'user-skills' : 'user', { exact: true }) }).locator('[data-testid^="source-browser-select-"]');
      await choose.click();
      if (kind === 'history') {
        const rows = browser.locator('[data-testid^="source-browser-select-"]');
        assert.equal(await rows.count(), 10);
        await browser.getByText('Each artifact keeps its own title and selection; selecting a parent does not select its agents or forks.', { exact: true }).waitFor();
        assert.equal(await rows.filter({ hasText: '☑' }).count(), 1, 'selecting the main row does not select its agents');
        await page.screenshot({ path: context.pathInArtifacts('mobile-history-family-first-page.png') });
        await browser.getByRole('button', { name: 'Next', exact: true }).click();
        await waitFor(async () => await rows.count() === 3, 15000, 'three remaining physical family artifacts');
        await browser.getByText('The parent is on another page or was not discovered. Select each required artifact explicitly.', { exact: true }).waitFor();
        await rows.last().click();
        await page.screenshot({ path: context.pathInArtifacts('mobile-history-family-second-page.png') });
      }
      await browser.getByTestId('source-browser-transfer').click();
      await browser.getByTestId('source-transfer-status').getByText('Sources received; not imported', { exact: true }).waitFor({ timeout: 30000 });
      if (kind === 'history') {
        const transfer = transfers.at(-1);
        assert.equal(transfer.selections.length, 2, 'both explicitly selected pages must reach the real transfer');
        assert.ok(transfer.selections.every(item => item.kind === 'history'));
        assert.equal(new Set(transfer.selections.map(item => item.sourceHandle)).size, 2);
        assert.equal(new Set(transfer.selections.map(item => item.catalogId)).size, 1);
        const manifest = JSON.parse(await readFile(resolve(profile, 'migrations/source-transfer/incoming', transfer.requestId, 'manifest.json'), 'utf8'));
        assert.equal(manifest.entries.length, 2);
        assert.ok(manifest.entries.every(item => item.content.kind === 'history'));
        assert.equal(new Set(manifest.entries.map(item => item.content.snapshot.origin.sourceArtifactId)).size, 2, 'the agent and parent remain distinct physical artifacts');
        assert.equal(manifest.entries.filter(item => item.content.snapshot.origin.parentSessionId).length, 1);
        await rename(fixture.root, `${fixture.root}-withheld`);
      }
      checkpoint.stage = 'adoption';
      const adoption = browser.getByTestId('migration-source-adoption'); await adoption.getByTestId('source-adoption-expand').click(); await adoption.locator('[data-testid^="source-adoption-select-"]').first().click(); await adoption.getByTestId('source-adoption-prepare').click();
      await adoption.getByText('Preview Ready; not saved', { exact: true }).waitFor({ timeout: 30000 });
      const open = adoption.locator('[data-testid^="source-adoption-open-"]').first(), jobId = (await open.getAttribute('data-testid')).slice('source-adoption-open-'.length); await open.click();
      checkpoint.stage = 'ordinary_batch'; await page.getByTestId('migration-batch-editor').waitFor();
      const items = await observer.rpc.request('migration/items', { jobId }), item = items.items.find(row => row.category === (kind === 'configuration' ? 'provider' : kind)); assert.ok(item);
      await page.getByTestId(`migration-item-edit-${item.id}`).click();
      if (kind !== 'history') await page.getByTestId('migration-item-name').fill(`directory-mobile-${kind}`);
      if (kind === 'configuration') { await page.getByTestId('migration-provider-context').fill('128000'); await page.getByTestId('migration-provider-headroom').fill('8192'); await page.getByTestId('migration-provider-output').fill('8192'); }
      await page.getByTestId('migration-item-save').click(); await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor();
      const plan = await observer.rpc.request('migration/batch/item/plan', { jobId, itemId: item.id });
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), original);
      await enabled(page.getByTestId('migration-batch-import'), 'the original ordinary plan is ready'); await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT');
      await waitFor(async () => { const state = await observer.rpc.request('migration/batch/read', { jobId }); return state.state.job.committedItems === 1 && !state.workerRunning; }, 30000, 'directory consumer saved');
      const saved = await observer.rpc.request('migration/batch/read', { jobId }); assert.equal(saved.state.job.hasUnconfirmedOutcomes, false);
      if (kind === 'configuration') assert.equal(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')).providers['directory-mobile-configuration'].default_model, 'mobile-selected-directory-model');
      if (kind === 'skill') { const body = await readFile(resolve(profile, 'skills', plan.item.targetName, 'SKILL.md'), 'utf8'); assert.match(body, /MOBILE_DIRECTORY_SKILL/); assert.match(body, /default_enabled: false/); }
      if (kind === 'history') assert.equal((await observer.rpc.request('migration/history/read', { jobId: plan.item.historyJobId })).job.normalization.normalizedRecords, 3);
      await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); await enabled(page.getByTestId('migration-batch-undo'), 'reopened original directory migration'); await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO');
      await waitFor(async () => (await observer.rpc.request('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'directory consumer ordinary Undo');
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), original); completed.push({ kind, jobId });
    }
    const grants = requests.filter(row => row.kind === 'directory_select');
    assert.equal(grants.length, 5); assert.equal(grants[1].selectionId, grants[2].selectionId); assert.equal(grants[1].sessionId, grants[2].sessionId); assert.notEqual(grants[0].sessionId, grants[1].sessionId);
    const granted = new Set(); for (const row of requests) { if (row.kind === 'directory_select') granted.add(row.sessionId); else if (row.kind) assert.ok(granted.has(row.sessionId), 'no source query occurs before directory authorization'); }
    assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('mobile-source-directory-roundtrip.json', { passed: true, platform: 'Mobile Web Chromium', completed, requests, failedChoiceDidNotScanHome: true, lostGrantSameChildAndSelector: true, projectConsentIndependent: true, sourceMovedAfterHistoryReceipt: true, historyFamilyPageSizes: [10, 3], noImplicitAgentSelection: true, selectedHistoryAcrossPages: 2, normalBatchReopenAndUndo: true, modelRequests: 0 });
    return { directoryConsumers: 3, modelRequests: 0 };
  } catch (error) { await context.writeArtifactJson('mobile-source-directory-checkpoint.json', { checkpoint, completed, requests, modelRequests: model.requests.length }); throw error; }
  finally { page.off('request', onTransfer); await observer.close(); }
}
