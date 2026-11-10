import { expect, test } from 'vitest'
import { marketQuickPrompts } from './marketWorkflow'
import { parseWorkflowFrontmatterMeta, splitMarkdownFrontmatter } from './workflowMarkdown'

test('source workflow output and icon precedence are retained, with six source starter cards', () => {
  const cards = marketQuickPrompts(
    '## 步骤 1：TDD 方法论与测试策略（分析层）\n- 分析需求\n输出：测试策略文档和优先级排序。\n\n## 步骤 2：检查数据\n输出物：生成覆盖率报告。'
  )
  expect(cards).toHaveLength(6)
  expect(cards[0]).toMatchObject({
    title: 'TDD 方法论与测试策略',
    description: '生成测试策略文档和优先级排序',
    icon: 'activity',
    color: '#e8f4ff',
  })
  expect(cards[1]).toMatchObject({ description: '生成覆盖率报告', icon: 'trending-up' })
  expect(cards[2]).toMatchObject({ title: '开始处理任务', color: '#e8f4ff' })
  expect(marketQuickPrompts('', 'en')[0]).toMatchObject({
    title: 'Start a task',
    description: 'Describe the goal and start now',
  })
})

test('workflow metadata stays scoped to its source YAML and the body remains inert text', () => {
  const doc = splitMarkdownFrontmatter(
    '---\nname: sample\nversion: "1.0.0"\nmetadata:\n  display_name: 测试专家\n  package_type: meta-skill\norchestration:\n  children:\n    - test-one\n    - "test-two"\n---\n# Original workflow\n'
  )
  expect(parseWorkflowFrontmatterMeta(doc.raw)).toMatchObject({
    name: 'sample',
    displayName: '测试专家',
    version: '1.0.0',
    packageType: 'meta-skill',
    children: ['test-one', 'test-two'],
  })
  expect(doc.body).toBe('# Original workflow\n')
  expect(parseWorkflowFrontmatterMeta('metadata:\nother:\n  display_name: outside')).toHaveProperty(
    'displayName',
    null
  )
})
