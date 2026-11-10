import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMigrationGuideDialog } from '../../harness/migration-guide-dialog.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { waitFor } from '../../harness/run-context.mjs';

/** A real local guide creates only the original project inventory. The Web UI plans and publishes it. */
export async function seedProjectMcpFixture(context, profile, workspace, binary) {
  const settings = JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8'));
  const canary = 'SYNTHETIC_PROJECT_MCP_UI_INHERITED_PRIVATE_VALUE';
  context.registerSecret(canary);
  settings.mcp_servers = Array.from({ length: 13 }, (_, index) => ({ name: `kept-${String(index).padStart(2, '0')}`, command: 'NEVER_EXECUTE_INHERITED_UI_MCP', env: { TOKEN: canary } }));
  settings.mcp_disabled_servers = settings.mcp_servers.map(row => row.name);
  await writeFile(resolve(profile, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  const jobs = [];
  for (const kind of ['claude-code', 'codex']) {
    const home = context.pathInState(`project-mcp-source-${kind}`);
    const product = resolve(home, kind === 'codex' ? '.codex' : '.claude');
    await mkdir(product, { recursive: true, mode: 0o700 });
    const file = resolve(product, kind === 'codex' ? 'config.toml' : 'settings.json');
    const text = kind === 'codex' ? '[mcp_servers.docs]\ncommand="NEVER_EXECUTE_SOURCE_UI_MCP"\n' : JSON.stringify({ mcpServers: { docs: { command: 'NEVER_EXECUTE_SOURCE_UI_MCP' } } });
    await writeFile(file, text, { mode: 0o600 });
    let jobId;
    await runMigrationGuideDialog({ context, binary, workspace, label: `project-mcp-create-${kind}`,
      localArgs: ['--target-profile', profile, '--source', kind, '--source-home', home, '--target-scope', 'current-workspace'],
      observe: frame => { if (frame.type === 'state') jobId = frame.result?.job?.jobId; },
      answer: frame => { assert.equal(frame.code, 'menu'); assert.ok(jobId); return 'quit'; },
    });
    assert.ok(jobId); jobs.push({ kind, jobId, file, text });
  }
  return { jobs, canary, originalSettings: await readFile(resolve(profile, 'settings.json')) };
}

export async function exerciseProjectMcpUi({ context, page, gateway, profile, workspace, fixture, model, mobile = false }) {
  const device = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, device, workspace);
  const outcomes = [];
  const confirm = async keyword => { if (mobile) { await page.getByTestId('migration-batch-confirm-input').fill(keyword); await page.getByTestId('migration-batch-confirm-submit').click(); } };
  const openRecords = async () => {
    if (mobile) await page.getByTestId('migration-tab-records').click();
    else {
      await page.goto(`${gateway.baseUrl}/settings/general`);
      await page.getByTestId('general-language-en-button').click();
      await page.getByTestId('general-external-content-import-button').click();
      await page.locator('#migration-target').selectOption(device);
      await page.getByRole('button', { name: 'Migration records', exact: true }).click();
    }
  };
  try {
    for (const [index, job] of fixture.jobs.entries()) {
      await openRecords();
      await page.getByTestId(`migration-batch-record-${job.jobId}`).click();
      if (mobile) await page.getByTestId('migration-batch-editor').waitFor();
      const items = await observer.rpc.request('migration/items', { jobId: job.jobId });
      const item = items.items.find(row => row.category === 'mcp'); assert.ok(item);
      const name = `ProjectMcp${index}`;
      if (mobile) {
        await page.getByTestId(`migration-item-edit-${item.id}`).click();
        await page.getByTestId('migration-item-name').fill(name);
        await page.getByTestId('migration-item-save').click();
      } else {
        const row = page.getByTestId('migration-content-item').filter({ has: page.getByRole('checkbox', { name: `Select ${item.sourceName}`, exact: true }) });
        await row.getByRole('button', { name: 'Configure', exact: true }).click();
        await row.getByLabel('Imported connection name', { exact: true }).fill(name);
        await row.getByRole('button', { name: 'Save options and select', exact: true }).click();
      }
      const picker = mobile ? page.getByTestId('migration-project-mcp-picker') : page.getByRole('region', { name: 'Keep inherited MCP servers', exact: true });
      await picker.waitFor();
      if (mobile) {
        await picker.getByTestId('migration-project-mcp-name-kept-00').click();
        await picker.getByRole('button', { name: 'Next', exact: true }).click();
        await picker.getByTestId('migration-project-mcp-name-kept-11').click();
        await picker.getByTestId('migration-project-mcp-confirm').click();
        await page.getByTestId('migration-preview-plan').click();
        await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT');
      } else {
        assert.equal(await picker.getByRole('checkbox').count(), 11);
        await picker.getByRole('checkbox', { name: 'kept-00', exact: true }).check();
        await picker.getByRole('button', { name: 'Next', exact: true }).click();
        await picker.getByRole('checkbox', { name: 'kept-11', exact: true }).waitFor();
        assert.equal(await picker.getByRole('checkbox').count(), 4);
        await picker.getByRole('checkbox', { name: 'kept-11', exact: true }).check();
        await picker.getByRole('checkbox', { name: /I confirm this selection/ }).check();
        await page.getByRole('button', { name: 'Confirm selected content', exact: true }).click();
        await page.getByRole('button', { name: 'Start batch migration', exact: true }).click();
      }
      await waitFor(async () => (await observer.rpc.request('migration/batch/read', { jobId: job.jobId })).state.job.committedItems === 1, 30000, 'MCP declaration published');
      const document = JSON.parse(await readFile(resolve(workspace, '.kcoder/settings.json'), 'utf8'));
      assert.deepEqual(document.mcp_inherited_servers, ['kept-00', 'kept-11']);
      assert.equal(document.mcp_servers[0].name, name); assert.equal(document.mcp_servers.length, 1);
      assert.ok(document.mcp_disabled_servers.includes(name));
      assert.ok(!JSON.stringify(document).includes(fixture.canary));
      assert.deepEqual(await readFile(resolve(profile, 'settings.json')), fixture.originalSettings);
      await rename(job.file, `${job.file}.withheld`);
      await openRecords(); await page.getByTestId(`migration-batch-record-${job.jobId}`).click();
      if (mobile) { await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO'); }
      else await page.getByRole('button', { name: 'Undo this import', exact: true }).click();
      await waitFor(async () => (await observer.rpc.request('migration/batch/read', { jobId: job.jobId })).state.job.status === 'rolled_back', 30000, 'Original project batch undone');
      assert.deepEqual(await readFile(resolve(profile, 'settings.json')), fixture.originalSettings);
      assert.equal(await readFile(`${job.file}.withheld`, 'utf8'), job.text);
      assert.ok(!(await page.locator('body').innerText()).includes(fixture.canary));
      outcomes.push({ kind: job.kind, jobId: job.jobId, pages: [10, 3], selected: ['kept-00', 'kept-11'], sourceGoneBeforeReopen: true, disabled: true, undo: true });
    }
    assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('project-mcp-inheritance-ui.json', { passed: true, outcomes, modelRequests: 0, scope: mobile ? 'Actual Mobile Web public catalog and ordinary Native project batch; native desktop and installer remain unverified.' : 'Actual Studio Web public catalog and ordinary Native project batch; native desktop and installer remain unverified.' });
  } finally { await observer.close(); }
}
