import i18n from '@/i18n'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToolBlocksDisplay } from './ToolBlocksDisplay'
import type { ProcessingBlock } from '@/types/workbench'

const completedCommandBlock: ProcessingBlock = {
  id: 'call-1',
  subtaskId: 1,
  type: 'tool',
  toolName: 'bash',
  toolInput: { command: 'pwd' },
  toolOutput: '/workspace/project\n',
  status: 'done',
  createdAt: 1770000000000,
}

const completedWebSearchBlocks: ProcessingBlock[] = [
  {
    id: 'web-search-1',
    subtaskId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'search',
      query: 'Beijing weather today June 17 2026 temperature rain',
      queries: [
        'Beijing weather today June 17 2026 temperature rain',
        'Beijing China current weather forecast today AccuWeather',
      ],
    },
    status: 'done',
    createdAt: 1770000000000,
  },
  {
    id: 'web-search-2',
    subtaskId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'search',
      query: 'site:weather.com weather today Beijing China',
    },
    status: 'done',
    createdAt: 1770000001000,
  },
  {
    id: 'web-open-1',
    subtaskId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'open_page',
      url: 'https://www.weather.com/weather/today/l/Beijing+China',
    },
    status: 'done',
    createdAt: 1770000002000,
  },
  {
    id: 'web-open-2',
    subtaskId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'openPage',
      url: 'https://docs.wegent.ai/guide',
    },
    status: 'done',
    createdAt: 1770000003000,
  },
  {
    id: 'web-find-1',
    subtaskId: 1,
    type: 'tool',
    toolName: 'web_search',
    toolInput: {
      type: 'findInPage',
      url: 'https://docs.wegent.ai/guide',
      pattern: 'install',
    },
    status: 'done',
    createdAt: 1770000004000,
  },
]

const completedFileChangesBlock: ProcessingBlock = {
  id: 'file-changes-1',
  subtaskId: 1,
  type: 'file_changes',
  status: 'done',
  createdAt: 1770000003000,
  fileChanges: {
    version: 1,
    status: 'active',
    artifact_id: 'artifact-1',
    device_id: 'device-1',
    workspace_path: '/tmp/project',
    file_count: 1,
    additions: 2,
    deletions: 1,
    files: [
      {
        path: 'scripts/env',
        change_type: 'modified',
        additions: 2,
        deletions: 1,
        binary: false,
      },
    ],
    reverted_at: null,
    revertible: false,
    diff: [
      'diff --git a/scripts/env b/scripts/env',
      '--- a/scripts/env',
      '+++ b/scripts/env',
      '@@ -8,2 +8,3 @@',
      '-OLD_ENV=remote',
      '+OLD_ENV=local',
      '+BACKEND_URL=127.0.0.1',
    ].join('\n'),
  },
}

const completedGuidanceBlock: ProcessingBlock = {
  id: 'guidance-1',
  subtaskId: 1,
  type: 'tool',
  toolName: 'conversation_guidance',
  toolInput: { message: '继续分析 package.json' },
  status: 'done',
  createdAt: 1770000004000,
}

const completedContextCompactionBlock: ProcessingBlock = {
  id: 'ctx-1',
  subtaskId: 1,
  type: 'tool',
  toolName: 'context_compaction',
  status: 'done',
  createdAt: 1770000004500,
}

describe('ToolBlocksDisplay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('renders concrete tool rows without a second aggregation inside the summary', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('运行 pwd')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('hides zero-second duration while restoring a completed transcript', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={false} />)

    expect(screen.queryByText('已处理 0 秒')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '调用 1 个工具 已处理' })).toBeInTheDocument()
  })

  test('renders completed conversation guidance as a static activity label', () => {
    render(<ToolBlocksDisplay blocks={[completedGuidanceBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('引导对话')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('renders context compaction independently between flat tool rows', () => {
    const completedSearchBlock: ProcessingBlock = {
      id: 'search-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: "/bin/zsh -lc 'rg -n context .'" },
      status: 'done',
      createdAt: 1770000005000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock, completedContextCompactionBlock, completedSearchBlock]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByTestId('context-compaction-indicator')).toHaveTextContent('上下文已自动压缩')
    expect(screen.getByText('运行 pwd')).toBeInTheDocument()
    expect(screen.getByText('搜索代码')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('renders running context compaction status without the generic thinking placeholder', () => {
    render(
      <ToolBlocksDisplay
        blocks={[{ ...completedContextCompactionBlock, status: 'streaming' }]}
        isStreaming={true}
      />
    )

    expect(screen.getByTestId('context-compaction-indicator')).toHaveTextContent(
      '正在自动压缩上下文'
    )
    expect(screen.getByText('正在自动压缩上下文')).toHaveClass('waiting-thinking-text')
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('keeps completed context compaction status static', () => {
    render(<ToolBlocksDisplay blocks={[completedContextCompactionBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('上下文已自动压缩')).not.toHaveClass('waiting-thinking-text')
  })

  test('renders completed web search tools as a web search activity', () => {
    render(<ToolBlocksDisplay blocks={completedWebSearchBlocks} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getAllByText('搜索网页')).toHaveLength(completedWebSearchBlocks.length)
    expect(screen.queryByText('运行 web_search')).not.toBeInTheDocument()

    screen.getAllByRole('button', { name: '搜索网页' }).forEach(button => {
      fireEvent.click(button)
    })

    const resultText = screen
      .getAllByTestId('web-search-activity-results')
      .map(result => result.textContent)
      .join(' ')
    expect(resultText).toContain('Beijing weather today June 17 2026 temperature rain')
    expect(resultText).toContain('https://www.weather.com/weather/today/l/Beijing+China')
    expect(resultText).toContain('https://docs.wegent.ai/guide')
    expect(screen.getByText('https://docs.wegent.ai/guide')).toBeInTheDocument()
    expect(resultText).toContain("'install' in https://docs.wegent.ai/guide")
    expect(resultText).toContain('weather today Beijing China | weather.com')
    expect(
      screen.queryByText('Beijing China current weather forecast today AccuWeather')
    ).toBeNull()
    expect(screen.getAllByText('Beijing weather today June 17 2026 temperature rain')).toHaveLength(
      1
    )
    screen.getAllByTestId('web-search-activity-results').forEach(result => {
      expect(result.parentElement).not.toHaveClass('border-l')
    })
    expect(screen.getAllByTestId('web-search-source-icon').length).toBeGreaterThanOrEqual(2)
  })

  test('renders read file activity details as file rows instead of shell commands', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'read-command-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: 'nl -ba renderer/src/components/chat/blocks/toolBlockActivity.ts',
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          {
            id: 'read-command-2',
            subtaskId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command:
                "/bin/zsh -lc \"sed -n '1,120p' renderer/src/components/chat/blocks/toolBlockKinds.ts\nsed -n '180,220p' renderer/src/components/chat/blocks/toolBlockKinds.ts\"",
            },
            status: 'done',
            createdAt: 1770000000001,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    expect(screen.getByText('读取 toolBlockActivity.ts')).toBeInTheDocument()
    expect(screen.getByText('读取 toolBlockKinds.ts')).toBeInTheDocument()
    expect(screen.queryByText('Read sed')).not.toBeInTheDocument()
    expect(screen.queryByText('Read 180,220p')).not.toBeInTheDocument()
    expect(screen.queryByText(/运行 nl -ba/)).not.toBeInTheDocument()
  })

  test('renders code search activity details as search summaries instead of shell commands', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'rg-command-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command:
                '/bin/zsh -lc "rg -n \'ToolBlockItem|toolBlock|file_changes|renderPayload|read.*file|command\'"',
              workdir: '/Users/dev/dev/git/Wegent/renderer/src/components/chat/blocks',
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          {
            id: 'rg-command-2',
            subtaskId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: "rg -n '编辑|edited|edited_file|edit.*file' wework",
            },
            status: 'done',
            createdAt: 1770000000001,
          },
          {
            id: 'git-command-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: 'git diff --name-only',
            },
            status: 'done',
            createdAt: 1770000000002,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getAllByText('搜索代码')).toHaveLength(2)
    expect(screen.getByText('运行 git diff --name-only')).toBeInTheDocument()
    expect(screen.queryByText(/运行 rg -n/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('renders mixed code search and read file activity with specialized rows', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'rg-command-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: 'rg -n "toolBlock" renderer/src/components/chat/blocks',
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          {
            id: 'read-command-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'bash',
            toolInput: {
              command: "sed -n '1,220p' renderer/src/components/chat/blocks/toolBlockActivity.ts",
            },
            status: 'done',
            createdAt: 1770000000001,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    expect(screen.getByText('搜索代码')).toBeInTheDocument()
    expect(screen.getByText('读取 toolBlockActivity.ts')).toBeInTheDocument()
    expect(screen.queryByText(/运行 sed -n/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('hides internal stdin polling tools from completed activity', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          completedGuidanceBlock,
          {
            id: 'stdin-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'write_stdin',
            toolInput: { session_id: 90870, chars: '' },
            status: 'done',
            createdAt: 1770000000001,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('引导对话')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /执行 1 个工具/ })).not.toBeInTheDocument()
    expect(screen.queryByText('执行')).not.toBeInTheDocument()
  })

  test('renders file changes inside completed processing details', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<ToolBlocksDisplay blocks={[completedFileChangesBlock]} isStreaming={false} />)

    expect(screen.getByRole('button', { name: /编辑 1 个文件 已处理/ })).toBeInTheDocument()
    expect(screen.getByLabelText('编辑 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('编辑 env')).toBeInTheDocument()
    expect(screen.getByTestId('file-change-line-stats')).toHaveTextContent('+2')
    expect(screen.getByTestId('file-change-line-stats')).toHaveTextContent('-1')

    fireEvent.click(screen.getByRole('button', { name: /编辑 env/ }))

    const diff = screen.getByTestId('process-file-change-diff')
    expect(diff).toHaveClass('max-h-[16rem]', 'select-text', 'overscroll-contain')
    expect(diff).toHaveTextContent('OLD_ENV=remote')
    expect(screen.getByTestId('process-file-change-diff')).toHaveTextContent(
      'BACKEND_URL=127.0.0.1'
    )

    const headerContent = screen.getByTestId('process-file-change-diff-header-content')
    const copyButton = screen.getByTestId('copy-process-file-change-diff-button')
    expect(headerContent).toHaveTextContent(/env.*\+2.*-1/)
    expect(
      headerContent.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(copyButton).toHaveAttribute('title', '复制代码')

    fireEvent.click(copyButton)
    expect(writeText).toHaveBeenCalledWith(
      ['-OLD_ENV=remote', '+OLD_ENV=local', '+BACKEND_URL=127.0.0.1'].join('\n')
    )
    expect(
      await screen.findByTestId('process-file-change-diff-copy-success-icon')
    ).toBeInTheDocument()
  })

  test('shows each file change duration from its matching edit tool', () => {
    const firstEdit: ProcessingBlock = {
      id: 'edit-first',
      subtaskId: 1,
      type: 'tool',
      toolName: 'apply_patch',
      toolInput: {
        patch: '*** Begin Patch\n*** Update File: scripts/env\n*** End Patch',
      },
      status: 'done',
      createdAt: 1770000000000,
      completedAt: 1770000004250,
    }
    const secondEdit: ProcessingBlock = {
      id: 'edit-second',
      subtaskId: 1,
      type: 'tool',
      toolName: 'apply_patch',
      toolInput: {
        patch: '*** Begin Patch\n*** Update File: /tmp/project/src/main.ts\n*** End Patch',
      },
      status: 'done',
      createdAt: 1770000005000,
      completedAt: 1770000011750,
    }
    const fileChanges: ProcessingBlock = {
      ...completedFileChangesBlock,
      fileChanges: {
        ...completedFileChangesBlock.fileChanges,
        file_count: 2,
        files: [
          completedFileChangesBlock.fileChanges.files[0],
          {
            path: 'src/main.ts',
            change_type: 'modified',
            additions: 1,
            deletions: 0,
            binary: false,
          },
        ],
      },
    }

    render(<ToolBlocksDisplay blocks={[firstEdit, secondEdit, fileChanges]} isStreaming={false} />)
    fireEvent.click(screen.getByRole('button', { name: /编辑 2 个文件 已处理/ }))

    expect(screen.getByRole('button', { name: /编辑 env/ })).toHaveTextContent('4.3s')
    expect(screen.getByRole('button', { name: /编辑 main.ts/ })).toHaveTextContent('6.8s')
    expect(screen.queryByText('0.0s')).not.toBeInTheDocument()
  })

  test('counts edited files separately from tool calls', () => {
    const multiFileChangesBlock: ProcessingBlock = {
      ...completedFileChangesBlock,
      fileChanges: {
        ...completedFileChangesBlock.fileChanges,
        file_count: 3,
        files: Array.from({ length: 3 }, (_, index) => ({
          path: `src/file-${index + 1}.ts`,
          change_type: 'modified' as const,
          additions: 1,
          deletions: 0,
          binary: false,
        })),
      },
    }

    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock, multiFileChangesBlock]}
        isStreaming={false}
      />
    )

    expect(
      screen.getByRole('button', { name: /调用 1 个工具，编辑 3 个文件 已处理/ })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('命令 1')).toBeInTheDocument()
    expect(screen.getByLabelText('编辑 3')).toBeInTheDocument()
  })

  test('pluralizes English tool and edited file counts independently', () => {
    const toolSummary = i18n.t('tool_activity.summary', {
      ns: 'chat',
      lng: 'en',
      count: 1,
    })

    expect(toolSummary).toBe('Called 1 tool')
    expect(
      i18n.t('tool_activity.mixed_summary', {
        ns: 'chat',
        lng: 'en',
        count: 1,
        toolSummary,
      })
    ).toBe('Called 1 tool, edited 1 file')
  })

  test('merges consecutive file change blocks into one activity row', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          completedFileChangesBlock,
          {
            ...completedFileChangesBlock,
            id: 'file-changes-2',
            createdAt: 1770000003001,
            fileChanges: {
              ...completedFileChangesBlock.fileChanges,
              artifact_id: 'artifact-2',
              additions: 3,
              deletions: 0,
              files: [
                {
                  path: 'scripts/env',
                  change_type: 'modified',
                  additions: 3,
                  deletions: 0,
                  binary: false,
                },
              ],
            },
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    const fileChangeBlocks = screen.getAllByTestId('process-file-changes-block')
    expect(fileChangeBlocks).toHaveLength(1)
    expect(fileChangeBlocks[0]).toHaveTextContent('编辑 env')
    expect(fileChangeBlocks[0]).toHaveTextContent('+5')
    expect(fileChangeBlocks[0]).toHaveTextContent('-1')
  })

  test('renders historical file changes directly without an intermediate summary row', () => {
    render(<ToolBlocksDisplay blocks={[completedFileChangesBlock]} isStreaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('编辑 env')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^编辑 1 个文件$/ })).not.toBeInTheDocument()
  })

  test('replaces streaming file rows with the final file rows', () => {
    const streamingSummaryBlock: ProcessingBlock = {
      ...completedFileChangesBlock,
      status: 'streaming',
      fileChanges: {
        ...completedFileChangesBlock.fileChanges,
        artifact_id: 'same-artifact',
        additions: 1,
        deletions: 0,
        file_count: 1,
        files: [
          {
            path: 'src/streaming.ts',
            change_type: 'modified',
            additions: 1,
            deletions: 0,
            binary: false,
          },
        ],
      },
    }
    const updatedStreamingSummaryBlock: ProcessingBlock = {
      ...streamingSummaryBlock,
      fileChanges: {
        ...streamingSummaryBlock.fileChanges,
        additions: 5,
        file_count: 5,
        files: Array.from({ length: 5 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          change_type: 'modified' as const,
          additions: 1,
          deletions: 0,
          binary: false,
        })),
      },
    }
    const finalSummaryBlock: ProcessingBlock = {
      ...updatedStreamingSummaryBlock,
      status: 'done',
      fileChanges: {
        ...updatedStreamingSummaryBlock.fileChanges,
        additions: 4,
        deletions: 0,
        file_count: 1,
        files: [
          {
            path: 'src/final.ts',
            change_type: 'modified',
            additions: 4,
            deletions: 0,
            binary: false,
          },
        ],
      },
    }

    const { rerender } = render(
      <ToolBlocksDisplay blocks={[streamingSummaryBlock]} isStreaming={false} forceExpanded />
    )

    expect(screen.getByText('正在编辑 streaming.ts')).toBeInTheDocument()

    rerender(
      <ToolBlocksDisplay blocks={[updatedStreamingSummaryBlock]} isStreaming={true} forceExpanded />
    )

    expect(screen.getAllByText(/正在编辑 file-/)).toHaveLength(5)

    rerender(<ToolBlocksDisplay blocks={[finalSummaryBlock]} isStreaming={false} forceExpanded />)

    expect(screen.getByText('编辑 final.ts')).toBeInTheDocument()
    expect(screen.queryByText('正在编辑 streaming.ts')).not.toBeInTheDocument()
  })

  test('keeps each streaming file duration anchored and animates line deltas across chunks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'))
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        return window.setTimeout(() => callback(performance.now()), 16)
      })

    const startedAt = Date.now()
    const streamingSummaryBlock: ProcessingBlock = {
      ...completedFileChangesBlock,
      status: 'streaming',
      createdAt: startedAt,
    }
    const { rerender } = render(
      <ToolBlocksDisplay blocks={[streamingSummaryBlock]} isStreaming={true} forceExpanded />
    )

    act(() => vi.advanceTimersByTime(1500))

    rerender(
      <ToolBlocksDisplay
        blocks={[
          {
            ...streamingSummaryBlock,
            createdAt: Date.now(),
            fileChanges: {
              ...streamingSummaryBlock.fileChanges,
              additions: 25,
              deletions: 11,
              files: streamingSummaryBlock.fileChanges.files.map(file => ({
                ...file,
                additions: 25,
                deletions: 11,
              })),
            },
          },
        ]}
        isStreaming={true}
        forceExpanded
      />
    )
    act(() => vi.advanceTimersByTime(20))

    expect(screen.getByText('1.5s')).toBeInTheDocument()
    expect(screen.getByText(/正在编辑/)).toHaveClass('tool-activity-shimmer')
    expect(screen.getByTestId('file-change-line-stats')).toHaveTextContent('+25')
    expect(document.querySelector('.file-change-rolling-value.is-rolling')).not.toBeNull()
    expect(document.querySelector('.file-change-stat-block')).not.toBeNull()
    animationFrame.mockRestore()
  })

  test('uses the first chunk time when consecutive file change chunks are merged', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:02.000Z'))

    const firstChunk: ProcessingBlock = {
      ...completedFileChangesBlock,
      id: 'file-changes-first',
      status: 'streaming',
      createdAt: Date.now() - 2000,
    }
    const latestChunk: ProcessingBlock = {
      ...firstChunk,
      id: 'file-changes-latest',
      createdAt: Date.now(),
      fileChanges: {
        ...firstChunk.fileChanges,
        additions: 2,
      },
    }

    render(
      <ToolBlocksDisplay blocks={[firstChunk, latestChunk]} isStreaming={true} forceExpanded />
    )

    expect(screen.getByText('2.0s')).toBeInTheDocument()
  })

  test('uses the latest matching edit tool for a repeated file path', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:10.000Z'))

    const oldEdit: ProcessingBlock = {
      id: 'old-edit',
      subtaskId: 1,
      type: 'tool',
      toolName: 'apply_patch',
      toolInput: { input: '*** Update File: src/example.ts' },
      status: 'done',
      createdAt: Date.now() - 9000,
      completedAt: Date.now() - 8000,
    }
    const currentEdit: ProcessingBlock = {
      ...oldEdit,
      id: 'current-edit',
      status: 'streaming',
      createdAt: Date.now() - 1000,
      completedAt: undefined,
    }
    const streamingFileChanges: ProcessingBlock = {
      ...completedFileChangesBlock,
      status: 'streaming',
      createdAt: Date.now() - 800,
    }

    render(
      <ToolBlocksDisplay
        blocks={[oldEdit, currentEdit, streamingFileChanges]}
        isStreaming={true}
        forceExpanded
      />
    )

    expect(screen.getByText('1.0s')).toBeInTheDocument()
    expect(screen.queryByText('9.0s')).not.toBeInTheDocument()
  })

  test('keeps an earlier edit completed when the same file is edited again after a command', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T00:00:10.000Z'))

    const firstEdit: ProcessingBlock = {
      id: 'first-edit',
      subtaskId: 1,
      type: 'tool',
      toolName: 'apply_patch',
      toolInput: { input: '*** Update File: src/example.ts' },
      status: 'done',
      createdAt: Date.now() - 9000,
      completedAt: Date.now() - 8000,
    }
    const firstFileChanges: ProcessingBlock = {
      ...completedFileChangesBlock,
      id: 'first-file-changes',
      createdAt: Date.now() - 7900,
      fileChanges: {
        ...completedFileChangesBlock.fileChanges,
        artifact_id: 'first-artifact',
        files: [
          {
            path: 'src/example.ts',
            change_type: 'modified',
            additions: 2,
            deletions: 1,
            binary: false,
          },
        ],
      },
    }
    const command: ProcessingBlock = {
      ...completedCommandBlock,
      id: 'interleaved-command',
      createdAt: Date.now() - 5000,
      completedAt: Date.now() - 4000,
    }
    const secondEdit: ProcessingBlock = {
      ...firstEdit,
      id: 'second-edit',
      status: 'streaming',
      createdAt: Date.now() - 1000,
      completedAt: undefined,
    }
    const secondFileChanges: ProcessingBlock = {
      ...firstFileChanges,
      id: 'second-file-changes',
      status: 'streaming',
      createdAt: Date.now() - 800,
      fileChanges: {
        ...firstFileChanges.fileChanges,
        artifact_id: 'second-artifact',
        additions: 4,
        deletions: 0,
        files: [
          {
            path: 'src/example.ts',
            change_type: 'modified',
            additions: 4,
            deletions: 0,
            binary: false,
          },
        ],
      },
    }

    render(
      <ToolBlocksDisplay
        blocks={[firstEdit, firstFileChanges, command, secondEdit, secondFileChanges]}
        isStreaming={true}
        forceExpanded
      />
    )

    const fileChangeRows = screen.getAllByTestId('process-file-changes-block')
    expect(fileChangeRows).toHaveLength(2)
    expect(within(fileChangeRows[0]).getByText('1.0s')).toBeInTheDocument()
    expect(within(fileChangeRows[1]).getByText('1.0s')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2000))

    expect(within(fileChangeRows[0]).getByText('1.0s')).toBeInTheDocument()
    expect(within(fileChangeRows[1]).getByText('3.0s')).toBeInTheDocument()
  })

  test('uses edit timing from the full message across narrative segment boundaries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:10.000Z'))

    const completedEdit: ProcessingBlock = {
      id: 'completed-edit',
      subtaskId: 1,
      type: 'tool',
      toolName: 'apply_patch',
      toolInput: { input: '*** Update File: scripts/env' },
      status: 'done',
      createdAt: Date.now() - 4000,
      completedAt: Date.now() - 1500,
    }
    const interleavedText: ProcessingBlock = {
      id: 'process-text',
      subtaskId: 1,
      type: 'text',
      content: '继续处理文件。',
      status: 'done',
      createdAt: Date.now() - 2000,
    }
    const streamingFileChanges: ProcessingBlock = {
      ...completedFileChangesBlock,
      status: 'streaming',
      createdAt: Date.now() - 500,
    }

    render(
      <ToolBlocksDisplay
        blocks={[streamingFileChanges]}
        fileEditDurationBlocks={[completedEdit, interleavedText, streamingFileChanges]}
        isStreaming={true}
        forceExpanded
      />
    )

    expect(screen.getByText('2.5s')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText('2.5s')).toBeInTheDocument()
    expect(screen.queryByText('7.0s')).not.toBeInTheDocument()
  })

  test('renders completed edit tools as flat concrete rows', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'patch-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'apply_patch',
            toolInput: {
              input: [
                '*** Begin Patch',
                '*** Update File: /workspace/project/executor/src/server/mod.rs',
                '@@',
                '-old',
                '+new',
                '*** End Patch',
              ].join('\n'),
            },
            status: 'done',
            createdAt: 1770000000000,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.getByText('编辑 mod.rs')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
  })

  test('hides redundant apply_patch activity when file changes are already rendered', () => {
    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'patch-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'apply_patch',
            toolInput: {
              input: [
                '*** Begin Patch',
                '*** Update File: /tmp/project/scripts/env',
                '@@',
                '-OLD_ENV=remote',
                '+BACKEND_URL=127.0.0.1',
                '*** End Patch',
              ].join('\n'),
            },
            status: 'done',
            createdAt: 1770000000000,
          },
          completedFileChangesBlock,
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))

    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('process-file-changes-block')).toHaveTextContent('编辑 env')
  })

  test('only persists the top-level processing expansion state', () => {
    const { unmount } = render(
      <ToolBlocksDisplay
        blocks={[completedFileChangesBlock]}
        isStreaming={false}
        stateKey="file-changes-local-expansion"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
    expect(screen.getByText('编辑 env')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /编辑 env/ }))
    expect(screen.getByTestId('process-file-change-diff')).toBeInTheDocument()

    unmount()
    render(
      <ToolBlocksDisplay
        blocks={[completedFileChangesBlock]}
        isStreaming={false}
        stateKey="file-changes-local-expansion"
      />
    )

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.getByTestId('process-file-changes-block')).toHaveTextContent('编辑 env')
    expect(screen.queryByTestId('process-file-change-diff')).not.toBeInTheDocument()
  })

  test('uses the same tool list for completed and streaming processing', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={false} />)

    const toggle = screen.getByRole('button', { name: /已处理/ })
    const collapseContent = screen.getByTestId('processing-collapse-content')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()

    fireEvent.click(toggle)

    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('processing-live-preview')).toHaveTextContent('运行 pwd')
    expect(screen.getByTestId('processing-live-preview-scroll')).toHaveStyle({
      maxHeight: '8rem',
      overflowY: 'auto',
    })
  })

  test('keeps live duration when the run finishes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const { rerender } = render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    rerender(
      <ToolBlocksDisplay blocks={[{ ...runningBlock, status: 'done' }]} isStreaming={false} />
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(screen.getByRole('button', { name: /已处理 3 秒/ })).toBeInTheDocument()
  })

  test('uses restored block timestamps for completed historical duration', () => {
    const turnStart = new Date('2026-06-05T00:00:00.000Z').getTime()
    const completedHistoricalBlock: ProcessingBlock = {
      ...completedCommandBlock,
      createdAt: turnStart + 368000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[completedHistoricalBlock]}
        isStreaming={false}
        startedAt={turnStart}
      />
    )

    expect(screen.getByRole('button', { name: /已处理 6 分 8 秒/ })).toBeInTheDocument()
  })

  test('formats live duration with minutes and seconds after one minute', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }

    render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(62000)
    })

    expect(screen.getByText('1 分 2 秒')).toBeInTheDocument()
  })

  test('formats exactly one minute with zero remaining seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }

    render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(60000)
    })

    expect(screen.getByText('1 分 0 秒')).toBeInTheDocument()
  })

  test('keeps the segment ticking but shows waiting after all tool blocks are done', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    // Tool completion alone does not establish that the provider is reasoning.
    // The segment timer must keep advancing while waiting for the next event.
    const doneBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'done',
      createdAt: Date.now(),
    }

    render(<ToolBlocksDisplay blocks={[doneBlock]} isStreaming={true} />)

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(screen.getByText('5 秒')).toBeInTheDocument()
    expect(screen.queryByText('5.0s')).not.toBeInTheDocument()
    expect(screen.getByTestId('tool-block-waiting')).toHaveTextContent('等待响应')
  })

  test('stops the tool duration and shows waiting while awaiting the next event', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const { rerender } = render(
      <ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} startedAt={Date.now()} />
    )

    act(() => vi.advanceTimersByTime(1200))
    rerender(
      <ToolBlocksDisplay
        blocks={[{ ...runningBlock, status: 'done' }]}
        isStreaming={true}
        startedAt={runningBlock.createdAt}
      />
    )
    act(() => vi.advanceTimersByTime(2300))

    expect(screen.getByText('3 秒')).toBeInTheDocument()
    expect(screen.getByText('1.2s')).toBeInTheDocument()
    expect(screen.getByTestId('tool-block-waiting')).toHaveTextContent('等待响应')
    expect(screen.getByText('等待响应')).toHaveClass('waiting-thinking-text')
  })

  test('stops ticking once a streaming tool segment becomes intermediate', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'))

    const { rerender } = render(
      <ToolBlocksDisplay
        blocks={[{ ...completedCommandBlock, createdAt: Date.now() }]}
        isStreaming={true}
      />
    )

    act(() => vi.advanceTimersByTime(2300))
    rerender(
      <ToolBlocksDisplay
        blocks={[{ ...completedCommandBlock, createdAt: Date.now() - 2300 }]}
        isStreaming={true}
        processingPhase="intermediate"
      />
    )
    act(() => vi.advanceTimersByTime(5000))

    expect(screen.getByText('2 秒')).toBeInTheDocument()
    expect(screen.queryByText('7 秒')).not.toBeInTheDocument()
  })

  test('does not insert waiting into a tool segment that precedes later output', () => {
    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock]}
        isStreaming={true}
        processingPhase="intermediate"
      />
    )

    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-block-waiting')).not.toBeInTheDocument()
  })

  test('uses the sum of concrete tool durations for the segment duration', () => {
    const firstBlock: ProcessingBlock = {
      ...completedCommandBlock,
      completedAt: completedCommandBlock.createdAt + 1200,
    }
    const secondBlock: ProcessingBlock = {
      ...completedCommandBlock,
      id: 'call-2',
      createdAt: completedCommandBlock.createdAt + 1200,
      completedAt: completedCommandBlock.createdAt + 3500,
      toolInput: { command: 'git status' },
    }

    render(
      <ToolBlocksDisplay
        blocks={[firstBlock, secondBlock]}
        isStreaming={false}
        startedAt={firstBlock.createdAt}
      />
    )

    expect(screen.getByText('3 秒')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('processing-summary-toggle'))
    expect(screen.getByText('1.2s')).toBeInTheDocument()
    expect(screen.getByText('2.3s')).toBeInTheDocument()
  })

  test('does not include the gap before the next tool in the previous tool duration', () => {
    const firstBlock: ProcessingBlock = {
      ...completedCommandBlock,
      completedAt: completedCommandBlock.createdAt + 1200,
    }
    const secondBlock: ProcessingBlock = {
      ...completedCommandBlock,
      id: 'call-2',
      createdAt: completedCommandBlock.createdAt + 5000,
      completedAt: completedCommandBlock.createdAt + 7300,
      toolInput: { command: 'git status' },
    }

    render(<ToolBlocksDisplay blocks={[firstBlock, secondBlock]} isStreaming={false} />)
    fireEvent.click(screen.getByTestId('processing-summary-toggle'))

    expect(screen.getByText('1.2s')).toBeInTheDocument()
    expect(screen.getByText('2.3s')).toBeInTheDocument()
    expect(screen.queryByText('5.0s')).not.toBeInTheDocument()
  })

  test('keeps a compact live preview with full processing details collapsed', async () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={true} />)

    const collapseContent = screen.getByTestId('processing-collapse-content')
    expect(collapseContent).toHaveAttribute('aria-hidden', 'true')
    const toggle = screen.getByRole('button', { name: /已处理/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const preview = screen.getByTestId('processing-live-preview')
    expect(preview).toBeInTheDocument()
    expect(preview.querySelector('.bg-gradient-to-b')).toBeNull()
    expect(preview).toHaveClass('ml-2', 'border-l', 'border-border', 'pl-3')
    expect(screen.getByText('运行 pwd')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/project')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-live-preview-scroll')).toHaveStyle({
      maxHeight: '8rem',
      overflowY: 'auto',
    })
    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))
    expect(screen.getByText('/workspace/project')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('processing-live-preview-scroll')).toHaveStyle({
        maxHeight: 'none',
        overflowY: 'visible',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '收起工具详情' }))
    await waitFor(() =>
      expect(screen.getByTestId('processing-live-preview-scroll')).toHaveStyle({
        maxHeight: '8rem',
        overflowY: 'auto',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))
    const initialRow = preview.querySelector('[data-processing-block-id="call-1"]')
    expect(initialRow).not.toBeNull()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('processing-live-preview')).not.toBeInTheDocument()
    expect(initialRow?.isConnected).toBe(false)

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const remountedPreview = screen.getByTestId('processing-live-preview')
    const remountedRow = remountedPreview.querySelector('[data-processing-block-id="call-1"]')
    expect(remountedRow).not.toBe(initialRow)
    expect(remountedRow?.isConnected).toBe(true)
  })

  test('keeps view_image as an expandable tool instead of flattening it to a file row', () => {
    const imageUrl = 'data:image/png;base64,aW1hZ2U='

    render(
      <ToolBlocksDisplay
        blocks={[
          {
            id: 'view-image-1',
            subtaskId: 1,
            type: 'tool',
            toolName: 'view_image',
            toolInput: { path: '/tmp/screenshot.png' },
            toolOutput: { image_url: imageUrl },
            status: 'done',
            createdAt: 1770000000000,
          },
        ]}
        isStreaming={false}
      />
    )

    fireEvent.click(screen.getByTestId('processing-summary-toggle'))

    expect(screen.getByText('查看 screenshot.png')).toBeInTheDocument()
    expect(screen.queryByTestId('file-read-activity-row')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))

    expect(screen.getByTestId('image-view-preview')).toHaveAttribute('src', imageUrl)
  })

  test('leaves generic thinking placeholders to the message list', () => {
    render(<ToolBlocksDisplay blocks={[completedCommandBlock]} isStreaming={true} />)

    expect(screen.getByTestId('processing-collapse-content')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('leaves final message collapsing to the message-level shell', () => {
    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock]}
        isStreaming={true}
        processingPhase="final"
      />
    )

    expect(screen.queryByTestId('final-processing-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-summary-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  test('keeps active tools expanded when streamed text is visible', () => {
    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
    }

    render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} processingPhase="final" />)

    expect(screen.getByTestId('processing-live-preview')).toHaveTextContent('正在运行 pwd')
    expect(screen.queryByTestId('processing-summary-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-summary-chevron')).not.toHaveClass('-rotate-90')
  })

  test('keeps completed and running tools as flat preview rows', () => {
    const completedSearchBlock: ProcessingBlock = {
      id: 'search-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: "/bin/zsh -lc 'rg -n paas-context .'" },
      status: 'done',
      createdAt: 1770000001000,
    }
    const runningBlock: ProcessingBlock = {
      id: 'running-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'bin/paas-context --help' },
      status: 'streaming',
      createdAt: 1770000002000,
    }

    render(
      <ToolBlocksDisplay
        blocks={[completedCommandBlock, completedSearchBlock, runningBlock]}
        isStreaming={true}
      />
    )

    const preview = screen.getByTestId('processing-live-preview')
    expect(preview).toHaveTextContent('运行 pwd')
    expect(preview).toHaveTextContent('搜索代码')
    expect(preview).toHaveTextContent('正在运行 bin/paas-context --help')
    expect(screen.getByLabelText('命令 2')).toBeInTheDocument()
    expect(screen.getByLabelText('搜索 1')).toBeInTheDocument()
    expect(screen.queryByText(/运行 \/bin\/zsh/)).not.toBeInTheDocument()
    expect(screen.queryByText('/workspace/project')).not.toBeInTheDocument()

    expect(screen.queryByTestId('processing-activity-group-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-live-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('processing-summary-toggle')).not.toBeInTheDocument()
    expect(screen.getByText('正在运行 bin/paas-context --help')).toHaveClass(
      'tool-activity-shimmer'
    )
  })

  test('shimmers the waiting row instead of a completed tool in a live segment', () => {
    const latestBlock: ProcessingBlock = {
      ...completedCommandBlock,
      id: 'call-2',
      toolInput: { command: 'git status --short' },
      createdAt: 1770000001000,
    }

    render(<ToolBlocksDisplay blocks={[completedCommandBlock, latestBlock]} isStreaming={true} />)

    expect(screen.getByText('运行 pwd')).not.toHaveClass('tool-activity-shimmer')
    expect(screen.getByText('运行 git status --short')).not.toHaveClass('tool-activity-shimmer')
    expect(screen.getByText('等待响应')).toHaveClass('waiting-thinking-text')
  })

  test('preserves user scroll position until the user returns to the bottom', () => {
    const blocks: ProcessingBlock[] = Array.from({ length: 8 }, (_, index) => ({
      ...completedCommandBlock,
      id: `scroll-${index}`,
      status: 'streaming',
    }))
    const { rerender } = render(<ToolBlocksDisplay blocks={blocks} isStreaming />)
    const scroll = screen.getByTestId('processing-live-preview-scroll')
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 128 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 256 })
    scroll.scrollTop = 40
    fireEvent.scroll(scroll)
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 288 })
    const more = [...blocks, { ...blocks[0], id: 'scroll-next' }]
    rerender(<ToolBlocksDisplay blocks={more} isStreaming />)
    expect(scroll.scrollTop).toBe(40)
    fireEvent.click(screen.getAllByRole('button', { name: '展开工具详情' })[0])
    scroll.scrollTop = 0
    fireEvent.scroll(scroll)
    fireEvent.click(screen.getByRole('button', { name: '收起工具详情' }))
    expect(scroll.scrollTop).toBe(40)
    scroll.scrollTop = 160
    fireEvent.scroll(scroll)
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 320 })
    rerender(
      <ToolBlocksDisplay blocks={[...more, { ...blocks[0], id: 'scroll-last' }]} isStreaming />
    )
    expect(scroll.scrollTop).toBe(320)
    expect(scroll).toHaveClass('pr-3')
    expect(scroll).toHaveStyle({ scrollbarGutter: 'stable', maxHeight: '8rem' })
  })

  test('updates parallel tool results in place instead of sorting by completion', () => {
    const first = { ...completedCommandBlock, id: 'parallel-first', status: 'streaming' as const }
    const second = { ...first, id: 'parallel-second', createdAt: first.createdAt + 1 }
    const { container, rerender } = render(
      <ToolBlocksDisplay blocks={[first, second]} isStreaming />
    )
    const originalRows = [...container.querySelectorAll('[data-processing-block-id]')]
    rerender(<ToolBlocksDisplay blocks={[first, { ...second, status: 'done' }]} isStreaming />)
    expect([...container.querySelectorAll('[data-processing-block-id]')]).toEqual(originalRows)
    rerender(
      <ToolBlocksDisplay
        blocks={[
          { ...first, status: 'done' },
          { ...second, status: 'done' },
        ]}
        isStreaming
      />
    )
    expect([...container.querySelectorAll('[data-processing-block-id]')]).toEqual(originalRows)
  })

  test('keeps all live rows in a scroll area sized for four rows', () => {
    const runningBlocks: ProcessingBlock[] = Array.from({ length: 4 }, (_, index) => ({
      id: `running-${index + 1}`,
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: `command-${index + 1}` },
      status: 'streaming',
      createdAt: Date.now() + index,
    }))

    const { rerender } = render(<ToolBlocksDisplay blocks={runningBlocks} isStreaming={true} />)

    const preview = screen.getByTestId('processing-live-preview')
    const scrollArea = screen.getByTestId('processing-live-preview-scroll')
    expect(scrollArea).toHaveStyle({ maxHeight: '8rem', overflowY: 'auto' })
    expect(preview.querySelector('[data-processing-block-id="running-1"]')).not.toBeNull()
    expect(preview.querySelector('[data-processing-block-id="running-2"]')).not.toBeNull()
    expect(preview.querySelector('[data-processing-block-id="running-3"]')).not.toBeNull()
    expect(preview.querySelector('[data-processing-block-id="running-4"]')).not.toBeNull()
    preview.querySelectorAll('[data-processing-block-id]').forEach(row => {
      expect(row).toHaveClass('overflow-x-clip')
      expect(row).not.toHaveClass('overflow-x-hidden', 'overflow-y-auto')
    })

    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 160 })
    rerender(
      <ToolBlocksDisplay
        blocks={[
          ...runningBlocks,
          {
            ...runningBlocks[0],
            id: 'running-5',
            toolInput: { command: 'command-5' },
          },
        ]}
        isStreaming={true}
      />
    )
    expect(scrollArea.scrollTop).toBe(160)
  })

  test('scrolls the live preview when the waiting row appears without a new tool row', () => {
    const runningBlocks: ProcessingBlock[] = Array.from({ length: 4 }, (_, index) => ({
      id: `running-${index + 1}`,
      subtaskId: 1,
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: `command-${index + 1}` },
      status: 'streaming',
      createdAt: Date.now() + index,
    }))

    const { rerender } = render(<ToolBlocksDisplay blocks={runningBlocks} isStreaming={true} />)
    const scrollArea = screen.getByTestId('processing-live-preview-scroll')
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 192 })
    scrollArea.scrollTop = 0

    rerender(
      <ToolBlocksDisplay
        blocks={runningBlocks.map(block => ({ ...block, status: 'done' }))}
        isStreaming={true}
      />
    )

    expect(screen.getByTestId('tool-block-waiting')).toBeInTheDocument()
    expect(scrollArea.scrollTop).toBe(192)
  })

  test('anchors the running duration to the turn start, surviving a refresh', () => {
    vi.useFakeTimers()
    // The page was refreshed 10s into a still-running turn.
    vi.setSystemTime(new Date('2026-06-05T00:00:10.000Z'))

    // After a refresh the in-progress blocks are re-streamed with fresh client
    // timestamps (createdAt === now), so anchoring to the first block would
    // restart the timer. The turn actually started 10s ago.
    const restreamedBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
      createdAt: Date.now(),
    }
    const turnStart = new Date('2026-06-05T00:00:00.000Z').getTime()

    render(
      <ToolBlocksDisplay blocks={[restreamedBlock]} isStreaming={true} startedAt={turnStart} />
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(screen.getByText('10 秒')).toBeInTheDocument()
  })

  test('renders the running header as a non-collapsible summary', () => {
    const runningBlock: ProcessingBlock = {
      ...completedCommandBlock,
      status: 'streaming',
    }

    render(<ToolBlocksDisplay blocks={[runningBlock]} isStreaming={true} />)

    expect(screen.queryByTestId('processing-summary-toggle')).not.toBeInTheDocument()
    expect(screen.getByText(/\d+ 秒/)).toBeInTheDocument()
  })

  test('shows reconnecting, recovered and failed states without leaving a stale shimmer', () => {
    const reconnectingBlock: ProcessingBlock = {
      id: 'reconnecting-1',
      subtaskId: 1,
      type: 'tool',
      toolName: 'runtime_reconnecting',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    const { rerender } = render(
      <ToolBlocksDisplay blocks={[reconnectingBlock]} isStreaming={true} />
    )

    const status = screen.getByTestId('runtime-reconnecting-status')
    expect(status).toHaveTextContent('连接中断，正在重连…')
    expect(status).toHaveClass('truncate')
    expect(status.querySelector('.tool-activity-shimmer')).not.toBeNull()

    rerender(
      <ToolBlocksDisplay blocks={[{ ...reconnectingBlock, status: 'done' }]} isStreaming={true} />
    )
    expect(screen.getByTestId('runtime-reconnecting-status')).toHaveTextContent('连接已恢复')
    expect(screen.getByTestId('runtime-reconnecting-status').firstElementChild).not.toHaveClass(
      'tool-activity-shimmer'
    )

    rerender(
      <ToolBlocksDisplay blocks={[{ ...reconnectingBlock, status: 'error' }]} isStreaming={true} />
    )
    expect(screen.getByTestId('runtime-reconnecting-status')).toHaveTextContent('重连失败')
    expect(screen.getByTestId('runtime-reconnecting-status')).toHaveAttribute('role', 'alert')
  })

  test('does not duplicate the generic thinking indicator when live thinking is visible', () => {
    const thinkingBlock: ProcessingBlock = {
      id: 'thinking-1',
      subtaskId: 1,
      type: 'thinking',
      content: 'Reading files',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(<ToolBlocksDisplay blocks={[thinkingBlock]} isStreaming={true} />)

    expect(screen.getByTestId('thinking-live-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('does not duplicate the generic thinking indicator when live process text is visible', () => {
    const textBlock: ProcessingBlock = {
      id: 'text-1',
      subtaskId: 1,
      type: 'text',
      content: 'Let me explore the repository structure.',
      status: 'streaming',
      createdAt: 1770000000000,
    }

    render(<ToolBlocksDisplay blocks={[textBlock]} isStreaming={true} />)

    expect(screen.getByTestId('process-text-block')).toBeInTheDocument()
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('renders request user input blocks as interactive cards', () => {
    const onSubmit = vi.fn()
    const block: ProcessingBlock = {
      id: 'request-1',
      subtaskId: 9,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'pending',
      createdAt: 1770000000000,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        questions: [
          {
            id: 'goal',
            question: '你希望我接下来问你哪些问题？',
            options: [{ label: '工作目标', description: '聚焦具体事情。' }],
          },
        ],
      },
    }

    render(
      <ToolBlocksDisplay blocks={[block]} isStreaming={true} onRequestUserInputSubmit={onSubmit} />
    )

    expect(screen.getByTestId('request-user-input-card')).toHaveTextContent(
      '你希望我接下来问你哪些问题？'
    )
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onSubmit).toHaveBeenCalledWith({
      requestId: 42,
      itemId: undefined,
      answers: {
        goal: { answers: ['工作目标'] },
      },
    })
  })

  test('can hide request user input blocks when the composer owns them', () => {
    const block: ProcessingBlock = {
      id: 'request-1',
      subtaskId: 9,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'pending',
      createdAt: 1770000000000,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        questions: [
          {
            id: 'goal',
            question: '你希望我接下来问你哪些问题？',
            options: [{ label: '工作目标', description: '聚焦具体事情。' }],
          },
        ],
      },
    }

    render(<ToolBlocksDisplay blocks={[block]} isStreaming={true} hideRequestUserInputBlocks />)

    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
  })

  test('shows answered request user input blocks as summaries while hiding pending blocks', () => {
    const pendingBlock: ProcessingBlock = {
      id: 'request-pending',
      subtaskId: 9,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'done',
      createdAt: 1770000000000,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        questions: [{ id: 'goal', question: '你希望我接下来问你哪些问题？' }],
      },
    }
    const answeredBlock: ProcessingBlock = {
      id: 'request-answered',
      subtaskId: 10,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'done',
      createdAt: 1770000000001,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 43,
        questions: [{ id: 'goal', question: '这次计划优先解决哪个问题？' }],
        response: {
          requestId: 43,
          answers: {
            goal: { answers: ['任务启动更顺'] },
          },
        },
      },
    }

    render(
      <ToolBlocksDisplay
        blocks={[pendingBlock, answeredBlock]}
        isStreaming={true}
        hideRequestUserInputBlocks
      />
    )

    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('任务启动更顺')
  })

  test('can hide pending request user input blocks by request id', () => {
    const block: ProcessingBlock = {
      id: 'request-1',
      subtaskId: 9,
      type: 'tool',
      toolName: 'request_user_input',
      status: 'pending',
      createdAt: 1770000000000,
      renderPayload: {
        kind: 'request_user_input',
        request_id: 42,
        questions: [
          {
            id: 'goal',
            question: '你希望我接下来问你哪些问题？',
            options: [{ label: '工作目标', description: '聚焦具体事情。' }],
          },
        ],
      },
    }

    render(
      <ToolBlocksDisplay
        blocks={[block]}
        isStreaming={true}
        hiddenRequestUserInputIds={new Set(['request:42'])}
      />
    )

    expect(screen.queryByTestId('request-user-input-card')).not.toBeInTheDocument()
  })

  test('groups consecutive subagent tool events and preserves each agent status', () => {
    const agents: ProcessingBlock[] = [
      {
        id: 'agent-a',
        subtaskId: 1,
        type: 'tool',
        toolName: 'spawn_agent',
        toolInput: { agent_type: 'review', message: '审查前端' },
        toolOutput: { status: 'completed' },
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'agent-b',
        subtaskId: 1,
        type: 'tool',
        toolName: 'explore_agent',
        toolInput: { message: '检查协议' },
        status: 'pending',
        createdAt: 1770000000001,
      },
    ]

    render(<ToolBlocksDisplay blocks={agents} isStreaming showSummary={false} />)

    expect(screen.getByTestId('subagent-tool-group')).toHaveTextContent('2 个子智能体')
    expect(screen.getAllByTestId('subagent-tool-block')).toHaveLength(2)
    expect(screen.getByText('审查前端')).toBeInTheDocument()
    expect(screen.getByText('检查协议')).toBeInTheDocument()
    expect(screen.getByText('运行中')).toBeInTheDocument()
  })
})
