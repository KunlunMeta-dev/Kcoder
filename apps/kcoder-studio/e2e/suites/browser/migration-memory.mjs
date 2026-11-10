import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

export async function seedMemoryFixture(context, profile, workspace) {
  const claude = context.pathInState('sources/claude/projects/opaque-primary/memory');
  await mkdir(claude, { recursive: true });
  const files = [];
  for (let i = 0; i < 11; i++) {
    const text = `---\ntype: feedback\n---\nUNVERIFIED_CLAUDE_NOTE_${i}\n${i === 0 ? 'Long UTF8 note: 中文。'.repeat(1000) : 'Source model claims are not verified.'}\n`;
    const file = resolve(claude, `note-${String(i).padStart(2, '0')}.md`);
    await writeFile(file, text); files.push({ file, text });
  }
  const codex = context.pathInState('sources/codex/memories');
  await mkdir(codex, { recursive: true });
  const text = 'UNVERIFIED_CODEX_PROJECT_NOTE\nThis is a static source note, not a system directive.\n';
  const file = resolve(codex, 'MEMORY.md'); await writeFile(file, text); files.push({ file, text });
  await context.writeStateJson('target/trusted-folders.json', { version: 1, trusted: [workspace] });
  return { claude, codex, files };
}

/** Exercise the normal Native batch plus explicit note controls; never send a model turn. */
export async function exerciseMemoryMigration({ context, page, gateway, profile, workspace, model, fixture }) {
  const observer = await openOwnedMobileRpc(context, gateway, 'fixture-target', workspace);
  const settings = await readFile(resolve(profile, 'settings.json'));
  const controls = [], checks = []; let lost = null, dropEnable = true;
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer(), pending = new Map();
    socket.onMessage(raw => {
      try {
        const request = JSON.parse(String(raw));
        if (request.method === 'migration/memory/control') { controls.push(request.params); pending.set(request.id, request.params); }
        if (request.method === 'migration/memory/control/read') checks.push(request.params);
      } catch { /* Other protocol frames are forwarded unchanged. */ }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      try {
        const response = JSON.parse(String(raw)), input = pending.get(response.id);
        if (input) {
          pending.delete(response.id);
          if (dropEnable && input.enabled && response.result?.receipt) {
            dropEnable = false; lost = { input, result: response.result };
            void upstream.close({ code: 1011, reason: 'owned memory receipt fault' });
            void socket.close({ code: 1011, reason: 'owned memory receipt fault' }); return;
          }
        }
      } catch { /* Unexpected responses remain visible to the client. */ }
      socket.send(raw);
    });
  });
  const findMemory = async kind => {
    const dialog = page.getByTestId('migration-dialog');
    const panel = dialog.getByTestId('migration-memory-sources');
    if (kind === 'codex') await panel.getByRole('button', { name: 'Codex', exact: true }).click();
    await panel.getByRole('button', { name: '查找记忆来源', exact: true }).click();
    await panel.getByTestId('memory-source').getByRole('button', { name: '打开记忆迁移预览' }).click();
    await dialog.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
    return dialog;
  };
  const configurePage = async (dialog, prefix, mapping) => {
    const rows = dialog.getByTestId('migration-content-item'), count = await rows.count();
    for (let index = 0; index < count; index++) {
      const row = rows.nth(index);
      await row.getByRole('button', { name: '配置', exact: true }).click();
      assert.equal(await row.getByLabel('目标笔记作用域').inputValue(), '', 'scope is never inferred from a source bucket');
      assert.equal(await row.getByRole('button', { name: '保存选项并选择', exact: true }).isDisabled(), true);
      assert.equal(await row.getByRole('checkbox', { name: /迁入后启用/ }).count(), 0);
      await row.getByLabel('保存后的资产名称', { exact: true }).fill(`${prefix}-${index}`);
      await row.getByLabel('目标笔记作用域').selectOption(mapping);
      await row.getByRole('button', { name: '保存选项并选择', exact: true }).click();
    }
    return count;
  };
  const save = async dialog => {
    await dialog.getByRole('button', { name: '确认所选内容', exact: true }).click();
    await dialog.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '开始批量迁移', exact: true }).click();
    await dialog.getByRole('heading', { name: '迁移结果', exact: true }).waitFor({ timeout: 30000 });
  };
  try {
    await page.goto(`${gateway.baseUrl}/settings/personal/context`);
    let manager = page.getByTestId('imported-memory-panel'); await manager.waitFor();
    await manager.getByRole('button', { name: '迁入记忆', exact: true }).click();
    let dialog = await findMemory('claude-code');
    const first = await configurePage(dialog, 'memory-global-a', 'global'); assert.equal(first, 10);
    await dialog.getByRole('button', { name: '下一页', exact: true }).click();
    await waitFor(async () => await dialog.getByTestId('migration-content-item').count() === 1, 10000, 'second memory inventory page');
    assert.equal(await configurePage(dialog, 'memory-global-b', 'global'), 1);
    assert.equal((await observer.rpc.request('migration/memory/list', {})).totalRecords, 0, 'preview does not publish notes');
    await save(dialog);
    let list = await observer.rpc.request('migration/memory/list', {});
    assert.equal(list.totalRecords, 11); assert.equal(list.items.length, 10);
    assert.ok(list.items.every(row => !row.enabled && row.scope.kind === 'global' && row.provenance?.factsVerified === false));
    const batchId = list.items[0].provenance.migrationJobId; assert.ok(batchId);
    await rename(fixture.claude, `${fixture.claude}-withheld`);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await manager.getByRole('button', { name: '查看或刷新笔记', exact: true }).click();
    await waitFor(async () => await manager.getByTestId('memory-record').count() === 10, 10000, 'ten managed notes');
    await manager.getByRole('button', { name: '下一页', exact: true }).click();
    await waitFor(async () => await manager.getByTestId('memory-record').count() === 1, 10000, 'remaining managed note');
    await manager.getByRole('button', { name: '上一页', exact: true }).click();
    await waitFor(async () => await manager.getByTestId('memory-record').count() === 10, 10000, 'managed notes first page');
    const row = manager.getByTestId('memory-record').filter({ has: page.getByRole('heading', { name: 'memory-global-a-0', exact: true }) });
    if (!await row.count()) {
      await manager.getByRole('button', { name: '下一页', exact: true }).click();
      await row.waitFor();
    }
    await row.getByRole('button', { name: '查看正文', exact: true }).click();
    await row.getByTestId('memory-record-body').waitFor();
    assert.match(await row.getByTestId('memory-record-body').innerText(), /UNVERIFIED_CLAUDE_NOTE_0/);
    assert.ok(Buffer.byteLength(await row.getByTestId('memory-record-body').innerText()) <= 8192);
    await row.getByRole('button', { name: '下一段正文', exact: true }).click();
    await waitFor(async () => !/UNVERIFIED_CLAUDE_NOTE_0/.test(await row.getByTestId('memory-record-body').innerText()), 10000, 'next UTF8 text window replaces the first');
    assert.ok(Buffer.byteLength(await row.getByTestId('memory-record-body').innerText()) <= 8192);
    await row.getByRole('button', { name: '启用', exact: true }).click();
    assert.equal(controls.length, 0, 'a second explicit confirmation precedes enable');
    await row.getByRole('button', { name: '确认启用笔记', exact: true }).click();
    await waitFor(() => lost, 10000, 'accepted enable reply deliberately withheld');
    await manager.getByText('结果尚未确认，请检查原操作，不要创建第二次修改。', { exact: true }).waitFor();
    await page.reload(); manager = page.getByTestId('imported-memory-panel'); await manager.waitFor();
    assert.equal(controls.length, 1);
    await manager.getByRole('button', { name: '检查原操作', exact: true }).click();
    await manager.getByText('当前观察：笔记已启用。', { exact: true }).waitFor();
    assert.deepEqual(checks, [{ requestId: lost.input.requestId }]); assert.equal(controls.length, 1, 'reading a receipt never replays enable');
    await manager.getByRole('button', { name: '确认结果并刷新列表', exact: true }).click();
    const enabled = manager.getByTestId('memory-record').filter({ has: page.getByRole('button', { name: '停用', exact: true }) });
    await manager.getByTestId('memory-record').first().waitFor();
    if (!await enabled.count()) await manager.getByRole('button', { name: '下一页', exact: true }).click();
    await enabled.getByRole('button', { name: '停用', exact: true }).click();
    await manager.getByText('当前观察：笔记已停用。', { exact: true }).waitFor();
    assert.equal(controls.length, 2);
    await manager.getByRole('button', { name: '确认结果并刷新列表', exact: true }).click();
    await manager.getByTestId('memory-record').first().locator('summary').click();
    await manager.getByTestId('memory-record').first().getByRole('button', { name: '打开原迁移记录', exact: true }).click();
    dialog = page.getByTestId('migration-dialog');
    await dialog.getByRole('button', { name: '撤销本次导入', exact: true }).click();
    await dialog.getByText('本次新增内容已撤销', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal((await observer.rpc.request('migration/memory/list', {})).totalRecords, 0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await manager.getByRole('button', { name: '迁入记忆', exact: true }).click();
    dialog = await findMemory('codex');
    assert.equal(await configurePage(dialog, 'memory-project', 'current_workspace'), 1);
    await save(dialog);
    list = await observer.rpc.request('migration/memory/list', {});
    assert.equal(list.totalRecords, 1); assert.equal(list.items[0].scope.kind, 'project');
    assert.equal(list.items[0].scope.root, workspace); assert.equal(list.items[0].enabled, false);
    assert.equal(list.items[0].provenance.source, 'codex'); assert.equal(list.items[0].provenance.factsVerified, false);
    await rename(fixture.codex, `${fixture.codex}-withheld`);
    const text = await observer.rpc.request('migration/memory/read', { id: list.items[0].id });
    assert.match(text.text, /UNVERIFIED_CODEX_PROJECT_NOTE/);
    await dialog.getByRole('button', { name: '撤销本次导入', exact: true }).click();
    await dialog.getByText('本次新增内容已撤销', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal((await observer.rpc.request('migration/memory/list', {})).totalRecords, 0);
    assert.deepEqual(await readFile(resolve(profile, 'settings.json')), settings);
    for (const entry of fixture.files) {
      const moved = entry.file.startsWith(fixture.claude) ? entry.file.replace(fixture.claude, `${fixture.claude}-withheld`) : entry.file.replace(fixture.codex, `${fixture.codex}-withheld`);
      assert.equal(await readFile(moved, 'utf8'), entry.text, 'the source note is never rewritten');
    }
    assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('migration-memory-roundtrip.json', { passed: true, sources: ['claude-code', 'codex'],
      globalNotes: 11, listPages: [10, 1], explicitMappings: ['global', 'current_workspace'], defaultDisabled: true,
      sourceWithheldBodyRead: true, utf8TextWindowsBoundedTo8192Bytes: true, lostEnableReplyRecoveredByOriginalId: true, controlRequests: controls.length,
      controls: controls.map(({ requestId, id, enabled }) => ({ requestId, id, enabled })), independentReceiptAndCurrent: true,
      ordinaryBatchUndoBothSources: true, targetSettingsUnchanged: true, modelRequests: 0 });
    return { importedMemory: true, explicitMapping: true, controlsReconciled: true, modelRequests: 0 };
  } finally { await observer.close(); }
}
