import { useEffect, useRef, useState } from 'react'
import { GeneralSettingsPage } from '../../src/components/settings/GeneralSettingsPage'
import { ScrollableMessageArea } from '../../src/components/chat/ScrollableMessageArea'
import { Button } from '../../src/components/ui/button'
import { rememberConversationProcessingWindow } from '../../src/features/appearance/conversationProcessPreferences'
import type { ProcessingBlock, WorkbenchMessage } from '../../src/types/workbench'
import { ToolPathPreviewConsumer } from '../../src/kcoder/toolPathPreview'

function blocks(count: number): ProcessingBlock[] {
  const started = Date.now() - 11000
  const paragraphs = [
    '我先核对当前页面的布局和字体配置，确认哪些区域需要统一。',
    '模型、Wiki、插件和工作流配置页应采用一致的内容宽度，让标题、正文和操作按钮保持对齐。',
    '思考内容与工具调用按原来的顺序排列，长段落在各自的小区域内滚动，短内容保持自然高度。',
    '查看已有内容时，新输出不会把阅读位置拉回底部；需要时可以回到最新内容继续查看。',
    '每段思考结束后收起内容，整轮完成后再将处理过程折叠为摘要，用户可以随时展开查看。',
    '文件改动汇总会等到最终回复完成后再显示，生成过程中不提前出现。',
  ]
  return [
    {
      id: 'normal-text',
      subtaskId: 1,
      type: 'text',
      status: 'done',
      createdAt: started,
      content: '我会先查找相关说明，再检查页面布局。',
    },
    {
      id: 'before-search',
      subtaskId: 1,
      type: 'thinking',
      status: 'done',
      createdAt: started,
      content: '先查询资料，再继续分析。',
    },
    {
      id: 'search',
      subtaskId: 1,
      type: 'tool',
      status: 'done',
      createdAt: started + 1000,
      toolName: 'web_search',
      toolInput: { query: 'KCoder Studio 使用说明' },
    },
    {
      id: 'current-thinking',
      subtaskId: 1,
      type: 'thinking',
      status: 'streaming',
      createdAt: started + 2000,
      content: Array.from(
        { length: count },
        (_, index) => paragraphs[index % paragraphs.length]
      ).join('\n\n'),
    },
  ]
}

// Synthetic UI activity exercises the ordinary conversation renderer, not a model.
export function ProcessingWindowFixture() {
  const next = useRef(1)
  const sequence = useRef(0)
  const client = useRef({})
  const [progress] = useState(() => new ToolPathPreviewConsumer())
  const [fileCount, setFileCount] = useState(0)
  const writeCount = useRef(12)
  useEffect(() => () => progress.dispose(), [progress])
  const [settings, setSettings] = useState(true)
  const [conversation, setConversation] = useState<{
    key: string
    message: WorkbenchMessage
  } | null>(null)
  const create = () => {
    const key = `fixture:process-${next.current++}`
    sequence.current = 1
    writeCount.current = 12
    setFileCount(0)
    progress.handle(
      'turn/started',
      { serverId: 'fixture-instance', threadId: key, turnId: key, sequence: 1 },
      'fixture',
      key.slice('fixture:'.length),
      client.current
    )
    rememberConversationProcessingWindow(key)
    setConversation({
      key,
      message: {
        id: key,
        subtaskId: 1,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: new Date(Date.now() - 11000).toISOString(),
        blocks: blocks(30),
        fileChanges: {
          version: 1,
          status: 'active',
          artifact_id: 'preview-changes',
          device_id: 'local',
          workspace_path: 'D:/fixture',
          file_count: 2,
          additions: 24,
          deletions: 3,
          files: [
            {
              path: 'src/components/ProcessingWindow.tsx',
              change_type: 'modified',
              additions: 18,
              deletions: 3,
              binary: false,
            },
            {
              path: 'docs/studio.md',
              change_type: 'modified',
              additions: 6,
              deletions: 0,
              binary: false,
            },
          ],
        },
      },
    })
    setSettings(false)
  }
  const emit = (method: string, extra: Record<string, unknown>) => {
    if (!conversation) return
    progress.handle(
      method,
      {
        serverId: 'fixture-instance',
        threadId: conversation.key,
        turnId: conversation.key,
        sequence: ++sequence.current,
        ...extra,
      },
      'fixture',
      conversation.key.slice('fixture:'.length),
      client.current
    )
  }
  const startWriting = () => {
    if (!conversation) return
    emit('item/event', {
      event: {
        type: 'tool_input_progress',
        id: 'writer-live',
        name: 'write',
        chars: 128,
        lines: { generatedLines: writeCount.current, replacedLines: 3 },
      },
    })
    emit('item/started', { item: { type: 'toolCall', id: 'writer-live' } })
    setConversation(
      current =>
        current && {
          ...current,
          message: {
            ...current.message,
            content: '',
            blocks: [
              ...(current.message.blocks ?? [])
                .filter(block => block.id !== 'write-narrative')
                .map(block => ({
                  ...block,
                  status: 'done' as const,
                })),
              {
                id: 'write-narrative',
                subtaskId: 1,
                type: 'text',
                content: current.message.content || '检索已完成，现在写入文件。',
                status: 'done',
                createdAt: Date.now(),
              },
              {
                id: 'writer-live',
                subtaskId: 1,
                type: 'tool',
                toolName: 'write',
                toolInput: { file_path: 'demo.txt', content: 'Preview' },
                status: 'streaming',
                createdAt: Date.now(),
              },
            ],
          },
        }
    )
  }
  return (
    <div className="flex h-dvh flex-col bg-background text-text-primary">
      <div className="flex shrink-0 flex-wrap gap-2 border-b border-border p-3">
        <Button data-testid="fixture-process-settings" onClick={() => setSettings(true)}>
          通用设置
        </Button>
        <Button data-testid="fixture-process-new" onClick={create}>
          新会话
        </Button>
        {conversation && (
          <>
            <Button
              data-testid="fixture-write-prepare"
              onClick={() => {
                writeCount.current = 12
                setConversation(
                  current =>
                    current && {
                      ...current,
                      message: {
                        ...current.message,
                        content: '检索已完成，现在写入文件。',
                        blocks: (current.message.blocks ?? []).map(block => ({
                          ...block,
                          status: 'done' as const,
                        })),
                      },
                    }
                )
                emit('item/event', {
                  event: {
                    type: 'tool_input_progress',
                    id: 'writer-live',
                    name: 'write',
                    chars: 128,
                    lines: { generatedLines: 12, replacedLines: 3 },
                  },
                })
              }}
            >
              生成写入参数
            </Button>
            <Button
              data-testid="fixture-write-generate"
              onClick={() => {
                writeCount.current += 8
                emit('item/event', {
                  event: {
                    type: 'tool_input_progress',
                    id: 'writer-live',
                    name: 'write',
                    chars: 256,
                    lines: { generatedLines: writeCount.current, replacedLines: 3 },
                  },
                })
              }}
            >
              继续生成参数
            </Button>
            <Button data-testid="fixture-write-start" onClick={startWriting}>
              开始写入
            </Button>
            <Button
              data-testid="fixture-write-update"
              onClick={() => {
                writeCount.current += 7
                emit('item/event', {
                  event: {
                    type: 'tool_file_progress',
                    id: 'writer-live',
                    counts: {
                      additions: writeCount.current,
                      deletions: 4,
                      files: 1,
                      binaryFiles: 0,
                      partial: false,
                    },
                  },
                })
              }}
            >
              更新工具行数
            </Button>
            <Button
              data-testid="fixture-file-progress"
              onClick={() => {
                const additions = fileCount + 12
                setFileCount(additions)
                progress.handle(
                  'item/event',
                  {
                    serverId: 'fixture-instance',
                    threadId: conversation.key,
                    turnId: conversation.key,
                    sequence: ++sequence.current,
                    event: {
                      type: 'workspace_file_progress',
                      counts: { additions, deletions: 3, files: 2, binaryFiles: 0, partial: false },
                    },
                  },
                  'fixture',
                  conversation.key.slice('fixture:'.length),
                  client.current
                )
              }}
            >
              更新行数
            </Button>
            <Button data-testid="fixture-process-back" onClick={() => setSettings(false)}>
              返回会话
            </Button>
            <Button
              data-testid="fixture-process-append"
              onClick={() =>
                setConversation(
                  current =>
                    current && {
                      ...current,
                      message: {
                        ...current.message,
                        blocks: blocks(
                          (current.message.blocks?.at(-1)?.type === 'thinking'
                            ? current.message.blocks.at(-1)!.content.split('\n\n').length
                            : 30) + 20
                        ),
                      },
                    }
                )
              }
            >
              追加过程
            </Button>
            <Button
              data-testid="fixture-process-finish"
              onClick={() => {
                emit('turn/completed', {})
                setConversation(
                  current =>
                    current && {
                      ...current,
                      message: {
                        ...current.message,
                        status: 'done',
                        content: '最终回复：任务完成。',
                        blocks: current.message.blocks?.map(block => ({
                          ...block,
                          status: 'done',
                        })),
                      },
                    }
                )
              }}
            >
              完成
            </Button>
          </>
        )}
      </div>
      {settings ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8 max-md:px-4">
          <GeneralSettingsPage />
        </div>
      ) : (
        conversation && (
          <ScrollableMessageArea
            className="min-h-0 flex-1"
            scrollTestId="fixture-process-page-scroll"
            messages={[conversation.message]}
            conversationKey={conversation.key}
            toolsCatalogServerId="fixture"
            toolsCatalogTaskId={conversation.key.slice('fixture:'.length)}
            showTransientToolStatus
            onLoadFileChangesDiff={async () => ({ diff: '', truncated: false })}
            onRevertFileChanges={async () => {
              throw new Error('Preview only')
            }}
          />
        )
      )}
    </div>
  )
}
