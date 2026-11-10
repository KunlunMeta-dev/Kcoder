import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function exerciseMcpPrivateExtension({ page, context, profile, source, original }) {
  await page.getByRole('button', { name: '重新选择来源', exact: true }).click();
  await page.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
  await page.getByRole('button', { name: '预览所选来源', exact: true }).click();
  await page.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
  const provider = page.getByTestId('migration-content-item').filter({ has: page.getByText('anthropic', { exact: true }) });
  await provider.getByRole('button', { name: '配置', exact: true }).click();
  await page.getByLabel('保存后的连接名称').fill('BatchOfficeKey');
  await page.getByLabel('上下文额度', { exact: true }).fill('128000');
  await page.getByLabel('输出预留额度', { exact: true }).fill('8192');
  await page.getByLabel('最大输出额度', { exact: true }).fill('8192');
  await page.getByRole('button', { name: '保存选项并选择', exact: true }).click();
  const fields = page.getByTestId('migration-batch-mcp-fields');
  await fields.locator('summary').click();
  await fields.getByLabel(/UNSELECTED_INPUT/).check();
  await fields.getByLabel('我允许读取勾选的来源私有值，并保存到当前目标账户。').check();
  await page.getByRole('button', { name: '确认所选内容', exact: true }).click();
  await page.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), original);
  const before = await readFile(resolve(profile, 'credentials.json'), 'utf8');
  assert.ok(!before.includes(source.mcpServers['office-docs'].env.UNSELECTED_INPUT));
  await page.getByRole('button', { name: '开始批量迁移', exact: true }).click();
  await page.getByText('已迁入 4 / 4 项', { exact: true }).waitFor();
  await page.getByText('其中 3 项复用了已有结果，没有重复写入。', { exact: true }).waitFor();
  const settings = JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8'));
  assert.equal(settings.mcp_servers.length, original.mcp_servers.length);
  assert.notEqual(settings.mcp_servers[0].policy.credential_ref.id, original.mcp_servers[0].policy.credential_ref.id);
  assert.deepEqual(settings.mcp_disabled_servers, original.mcp_disabled_servers);
  const saved = await readFile(resolve(profile, 'credentials.json'), 'utf8');
  assert.ok(saved.includes(source.mcpServers['office-docs'].env.PRIVATE_INPUT));
  assert.ok(saved.includes(source.mcpServers['office-docs'].env.UNSELECTED_INPUT));
  for (const [name, value] of Object.entries(source.mcpServers['office-docs'].env)) {
    if (name.startsWith('UNSELECTED_EXTRA_')) assert.ok(!saved.includes(value));
  }
  const visible = await page.getByTestId('migration-dialog').textContent();
  assert.ok(!visible.includes(source.mcpServers['office-docs'].env.UNSELECTED_INPUT));
  await page.screenshot({ path: context.pathInArtifacts('migration-mcp-private-extended.png') });
  await page.getByRole('button', { name: '撤销本次导入', exact: true }).click();
  await page.getByText('本次新增内容已撤销', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), original);
  const restored = await readFile(resolve(profile, 'credentials.json'), 'utf8');
  assert.ok(restored.includes(source.mcpServers['office-docs'].env.PRIVATE_INPUT));
  assert.ok(!restored.includes(source.mcpServers['office-docs'].env.UNSELECTED_INPUT));
  await context.writeArtifactJson('migration-mcp-private-extension.json', {
    selectedNewFieldOnly: true, originalBindingPreserved: true, noDuplicateServer: true,
    noSecretInUi: true, unrelatedFieldsNotCopied: true, undoRestoresPriorBinding: true,
    scope: 'Actual Browser/Gateway/Native file-backed MCP extension; keyring is covered by Native fixture tests, not this browser run.',
  });
}
