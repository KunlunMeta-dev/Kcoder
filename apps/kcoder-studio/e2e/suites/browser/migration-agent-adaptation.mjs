import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { waitFor } from '../../harness/run-context.mjs';

export async function seedAgentAdaptationFixture(context, claude, codex) {
  const roots = { 'claude-code': claude, codex };
  const bodies = {
    'claude-code': '---\nname: reviewer\ndescription: Review documents with native read-only tools\nmodel: source-alias\ntools: Read, Grep\ndisallowedTools: Write\nmaxTurns: 3\n---\nReview $0 literally. Preserve source documents.\n',
    codex: "name='reviewer'\ndescription='Review documents without changing sources'\nmodel='source-alias'\ndeveloper_instructions='Review $0 literally. Preserve source documents.'\n",
  };
  for (const [kind, root] of Object.entries(roots)) {
    await mkdir(resolve(root, 'agents'), { recursive: true, mode: 0o700 });
    await writeFile(resolve(root, kind === 'codex' ? 'agents/reviewer.toml' : 'agents/reviewer.md'), bodies[kind], { mode: 0o600 });
  }
  return { roots, bodies };
}

/** Only ordinary UI actions may create choices, publish, reopen and undo these Agents. */
export async function exerciseAgentAdaptationUi({ context, page, gateway, profile, workspace, fixture, model, mobile = false }) {
  const target = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, target, workspace);
  const native = (method, params) => observer.rpc.request(method, params);
  const original = await readFile(resolve(profile, 'settings.json'));
  const results = [];
  let checkpoint = { stage: 'starting' };
  const confirm = async word => {
    if (mobile) { await page.getByTestId('migration-batch-confirm-input').fill(word); await page.getByTestId('migration-batch-confirm-submit').click(); }
  };
  try {
    if (!mobile) { await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click(); }
    for (const kind of ['claude-code', 'codex']) {
      checkpoint = { kind, stage: 'discover' };
      if (mobile) await page.getByTestId('migration-tab-definitions').click();
      else {
        await page.getByTestId('general-external-content-import-button').click();
        const dialog = page.getByTestId('migration-dialog');
        await dialog.locator('#migration-target').selectOption(target);
        await selectAdvancedMigration(dialog, 'definitions');
      }
      const panel = page.getByTestId('migration-definition-sources');
      await panel.getByRole('button', { name: kind === 'codex' ? 'Codex' : 'Claude Code', exact: true }).click();
      assert.equal(await panel.getByTestId('definition-source-row').count(), 0, 'discovery requires an explicit action');
      await panel.getByTestId('definition-discover').click();
      await panel.getByTestId('definition-source-row').first().waitFor();
      const source = panel.getByTestId('definition-source-row').filter({ hasText: 'Agent' });
      assert.equal(await source.count(), 1, 'select the owned static Agent source only');
      if (mobile) await source.locator('[data-testid^="definition-select-"]').click();
      else await source.getByRole('checkbox').check();
      await panel.getByTestId('definition-prepare').click();
      const editor = mobile ? page.getByTestId('migration-batch-editor') : page.getByTestId('migration-dialog');
      if (mobile) await editor.waitFor();
      else await editor.getByRole('heading', { name: 'Select migration content', exact: true }).waitFor();
      const jobs = await native('migration/jobs/list', {});
      const jobId = jobs.jobs.find(row => row.job.status === 'ready' && row.selectedItems === 0)?.job.jobId;
      assert.ok(jobId);
      const inventory = await native('migration/items', { jobId });
      assert.equal(inventory.items.length, 1);
      const item = inventory.items[0];
      assert.equal(item.category, 'agent');
      checkpoint = { kind, stage: 'configure', jobId, itemId: item.id };
      let form;
      if (mobile) {
        await editor.getByTestId(`migration-item-edit-${item.id}`).click();
        form = page.getByTestId('migration-item-editor');
        await form.getByTestId('migration-item-name').fill(`reviewed-${kind}`);
        await form.getByTestId('migration-agent-adapt').click();
      } else {
        form = editor.getByTestId('migration-content-item').filter({ hasText: item.sourceName });
        await form.getByRole('button', { name: 'Configure', exact: true }).click();
        await form.getByLabel('Saved asset name', { exact: true }).fill(`reviewed-${kind}`);
        await form.getByTestId('migration-agent-choice').getByRole('checkbox').first().check();
      }
      const save = mobile ? form.getByTestId('migration-item-save') : form.getByRole('button', { name: 'Save options and select', exact: true });
      await waitFor(async () => !await save.isEnabled(), 10000, 'an explicit adaptation cannot save without inspection and consent');
      await form.getByTestId('migration-agent-inspect').click();
      const preview = await native('migration/agent/preview', { jobId, itemId: item.id });
      assert.equal(preview.compatibility.canAdapt, true);
      const sourceSha256 = createHash('sha256').update(fixture.bodies[kind]).digest('hex');
      assert.equal(preview.compatibility.sourceSha256, sourceSha256);
      assert.equal(preview.compatibility.sourceModelReference, true);
      if (mobile) await form.getByTestId('migration-agent-model-target').click();
      else await form.getByTestId('migration-agent-model-kind').selectOption('target');
      await form.getByTestId('migration-agent-provider').fill('fixture');
      await form.getByTestId('migration-agent-model').fill('fixture');
      for (const tool of preview.compatibility.availableTools) {
        if (tool === 'read') continue;
        if (mobile) await form.getByTestId(`migration-agent-tool-${tool}`).click();
        else await form.getByTestId('migration-agent-choice').getByRole('checkbox', { name: tool, exact: true }).uncheck();
      }
      await waitFor(async () => !await save.isEnabled(), 10000, 'model and tool choices still require explicit review');
      if (mobile) await form.getByTestId('migration-agent-confirm').click();
      else await form.getByTestId('migration-agent-confirm').check();
      await waitFor(() => save.isEnabled(), 10000, 'explicit reviewed Agent can be selected');
      await save.click();
      if (mobile) await page.getByTestId('migration-preview-plan').click();
      else await editor.getByRole('button', { name: 'Confirm selected content', exact: true }).click();
      if (mobile) await page.getByTestId('migration-batch-operation').waitFor();
      else await editor.getByRole('heading', { name: 'Confirm batch plan', exact: true }).waitFor();
      const planned = await native('migration/items', { jobId });
      assert.equal(planned.planned.length, 1); assert.equal(planned.planned[0].enabled, false);
      checkpoint.stage = 'publish';
      if (mobile) { await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT'); }
      else await editor.getByRole('button', { name: 'Start batch migration', exact: true }).click();
      await waitFor(async () => { const state = await native('migration/batch/read', { jobId }); return state.state.job.committedItems === 1 && !state.workerRunning; }, 30000, 'disabled native Agent published');
      const packageRoot = resolve(profile, 'skills', `reviewed-${kind}`);
      const agent = JSON.parse(await readFile(resolve(packageRoot, 'plugin-agent.json'), 'utf8'));
      assert.deepEqual(agent.allowed_tools, ['read']);
      assert.deepEqual(agent.imported_agent.model, { kind: 'target', provider: 'fixture', model: 'fixture' });
      assert.equal(agent.imported_agent.sourceSha256, sourceSha256);
      assert.ok(agent.instructions.includes('$0 literally'));
      assert.match(await readFile(resolve(packageRoot, 'SKILL.md'), 'utf8'), /default_enabled: false/);
      assert.deepEqual(await readFile(resolve(profile, 'settings.json')), original);
      await rename(fixture.roots[kind], `${fixture.roots[kind]}-withheld`);
      checkpoint.stage = 'reopen-without-source';
      if (mobile) { await page.getByTestId('migration-tab-records').click(); }
      else {
        await editor.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByTestId('general-external-content-import-button').click();
        await editor.locator('#migration-target').selectOption(target);
        await editor.getByRole('button', { name: 'Migration records', exact: true }).click();
      }
      await page.getByTestId(`migration-batch-record-${jobId}`).click();
      if (mobile) await page.getByTestId('migration-batch-operation').waitFor();
      const body = await native('migration/definitions/body', { jobId, itemId: item.id });
      assert.equal(body.text, fixture.bodies[kind]); assert.equal(body.sha256, sourceSha256);
      checkpoint.stage = 'original-undo';
      if (mobile) { await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO'); }
      else await editor.getByRole('button', { name: 'Undo this import', exact: true }).click();
      await waitFor(async () => (await native('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'original Agent publication undone');
      assert.equal(await access(packageRoot).then(() => true, () => false), false);
      assert.deepEqual(await readFile(resolve(profile, 'settings.json')), original);
      results.push({ kind, jobId, sourceSha256, explicitNativeModelMapping: true, readOnlyTools: true, disabledByDefault: true, literalInstructions: true, sourceAbsentReopen: true, originalUndo: true });
      if (!mobile) await editor.getByRole('button', { name: 'Close', exact: true }).click();
    }
    assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('agent-adaptation-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio Web Chromium', results, settingsUnchanged: true, modelRequests: 0, runtimeExecutionTested: false, desktopInstallerTested: false });
    return { vendors: results.length, originalUndo: true, modelRequests: 0 };
  } catch (error) {
    await context.writeArtifactJson('agent-adaptation-checkpoint.json', { checkpoint, results });
    throw error;
  } finally { await observer.close(); }
}
