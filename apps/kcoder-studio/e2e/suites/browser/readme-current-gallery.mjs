import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { waitForSelectedModel } from '../../harness/model-selector.mjs';

/** Capture real UI with owned sample records, without executing tasks or connecting platforms. */
export async function captureCurrentReadmeGallery({ context, page, rpc, origin, graph, sourceText }) {
  const output = context.pathInArtifacts('readme');
  await mkdir(output, { recursive: true });
  const images = [];
  const capture = async name => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(output, name), animations: 'disabled' });
    images.push(name);
    console.log(`README_SCREENSHOT ${join(output, name)}`);
  };
  const navigate = path => page.evaluate(value => {
    window.history.pushState({}, '', value);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, new URL(path, origin).href);
  const scope = await rpc.request('integrations/scope/read');
  let sequence = 0;
  const expertRequest = async (method, payload, mutation = {}) => {
    const reply = await rpc.request(`integrations/${method}`, {
      contractVersion: 'parallel-v1', requestId: `readme-expert-${++sequence}`,
      scope, timeoutMs: 30000, payload, ...mutation,
    });
    assert.equal(reply.status, 'completed', JSON.stringify(reply.error));
    return reply.result;
  };
  for (const [slug, title, description] of [
    ['review', '代码审查专家', '阅读项目代码，梳理风险与改进建议，并说明需要核对的测试。'],
    ['research', '资料研究专家', '整理资料与来源，形成有引用、便于复核的研究提纲。'],
  ]) {
    const definition = {
      schemaVersion: 1, id: `personal.readme-${slug}`, scope: 'personal', title,
      description, language: 'zh-CN', instructions: description,
      inputSchema: { type: 'object', 'x-kcoder-expert': { avatarPreset: 'generic', enabled: true } },
      modelSelection: { kind: 'inherit_current' }, allowedTools: null,
      outputKinds: ['document'], acceptanceCriteria: ['说明来源和待确认事项'], externalSend: 'deny',
    };
    const { draft } = await expertRequest('assistant/saveDraft', { definition }, { operationId: `readme-create-${slug}` });
    await expertRequest('assistant/saveVersion', { id: definition.id, version: '1.0.0' }, {
      operationId: `readme-version-${slug}`, expectedRevision: String(draft.revision),
    });
  }
  await navigate('/');
  await waitForSelectedModel(page, '示例模型');
  await expect(page.getByTestId('task-expert-control')).toContainText('专家选择');
  await capture('readme-studio-home.png');
  await page.getByRole('button', { name: 'KWorker', exact: true }).click();
  await expect(page.getByRole('button', { name: 'KWorker', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await capture('readme-kworker-home.png');
  await page.getByRole('button', { name: 'KCoder', exact: true }).click();

  await navigate('/experts');
  await expect(page.getByTestId('expert-card')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: '我的专家', exact: true })).toHaveAttribute('aria-selected', 'true');
  await capture('readme-experts.png');
  await navigate('/');
  await page.getByTestId('task-expert-control').getByRole('button').click();
  const picker = page.getByTestId('expert-task-dialog');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('expert-task-version-select')).toHaveCount(0);
  await picker.getByTestId('expert-task-expert-select').selectOption('expert:personal.readme-review');
  const version = picker.getByTestId('expert-task-version-select');
  await expect(version.locator('option[value="1.0.0"]')).toHaveCount(1);
  await version.selectOption('1.0.0');
  await expect(picker.getByRole('button', { name: '使用所选版本', exact: true })).toBeEnabled();
  await capture('readme-expert-selection.png');
  await page.keyboard.press('Escape');

  // Preserve actual empty task state; a gallery must never manufacture completed work.
  await navigate('/tasks');
  await expect(page.getByTestId('task-board-list')).toBeVisible();
  await capture('readme-task-board.png');

  await navigate('/experts');
  await expect(page.getByTestId('expert-card')).toHaveCount(2);
  await expect(page.getByTestId('expert-catalog-content')).toBeVisible();

  await navigate('/workflows');
  await page.getByTestId(`workflow-library-${graph.id}`).click();
  await expect(page.getByTestId('workflow-node-result')).toBeVisible();
  await page.getByTestId('workflow-fit').click();
  await capture('readme-workflow.png');

  await rpc.request('knowledge/create', { idempotencyKey: 'readme-library', name: '团队工作资料（示例）', purpose: '保存项目约定、会议纪要和资料来源。' }).then(async library => {
    await rpc.request('knowledge/source/importText', {
      libraryId: library.id, idempotencyKey: 'readme-source', title: '工作台使用说明.md', text: sourceText,
    });
  });
  await navigate('/knowledge');
  await expect(page.getByTestId('knowledge-space-hero')).toBeVisible();
  await page.locator('#wiki-tab-sources').click();
  await expect(page.getByText('工作台使用说明.md', { exact: true })).toBeVisible();
  await capture('readme-wiki.png');

  for (const path of ['/workflows', '/knowledge', '/channels']) {
    await navigate(path);
    const ready = path === '/workflows' ? `workflow-library-${graph.id}`
      : 'knowledge-space-hero';
    if (path === '/channels')
      await expect(page.getByRole('button', { name: '启用通讯渠道', exact: true })).toBeVisible();
    else await expect(page.getByTestId(ready)).toBeVisible();
    await navigate('/experts');
    await expect(page.getByTestId('expert-catalog-content')).toBeVisible();
    await expect(page.getByTestId('expert-card')).toHaveCount(2);
    await expect(page.getByTestId('experts-page').getByRole('alert')).toHaveCount(0);
  }
  return images;
}
