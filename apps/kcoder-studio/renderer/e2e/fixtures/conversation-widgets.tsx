import { useCallback, useState } from 'react'
import { ConversationWidgetsProvider } from '../../src/components/chat/widgets/ConversationWidgetsProvider'
import { MessageList } from '../../src/components/chat/MessageList'
import { ScrollableMessageArea } from '../../src/components/chat/ScrollableMessageArea'
import { WIDGET_EXAMPLES } from '../../src/features/widgets/examples'
import { widgetContentSha256 } from '../../src/features/widgets/contentHash'
import { publishCommittedWidget } from '../../src/kcoder/widgetEvents'
import { acceptWidgetPreviewNotification } from '../../src/kcoder/widgetPreviewEvents'
import type { WidgetRequest } from '../../src/kcoder/widgetApi'
import type { WidgetRef } from '../../../shared/generated/contracts'
import type { WorkbenchMessage } from '../../src/types/workbench'
import { rememberConversationProcessingWindow } from '../../src/features/appearance/conversationProcessPreferences'

const address = { deviceId: 'widget-fixture', taskId: 'fixture-task', threadId: 'fixture-thread' }
if (new URLSearchParams(location.search).get('scroll') === '1')
  rememberConversationProcessingWindow(`${address.deviceId}:${address.taskId}`, true)
const client = {}
const identity = {
  deviceId: address.deviceId,
  taskId: address.taskId,
  threadId: address.threadId,
  turnId: 'fixture-turn',
  attemptId: 'fixture-attempt',
  client,
  serverId: 'fixture-instance',
  sequence: 1,
}
const query = new URLSearchParams(location.search)
const tallExample = {
  title: '长图示内部滚动',
  format: 'svg' as const,
  summary: '真实 SVG 内容由组件内部滚动；不移动会话阅读位置。',
  libraries: [],
  source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 3200">${Array.from({ length: 80 }, (_, index) => `<text x="20" y="${30 + index * 38}" fill="currentColor">图示条目 ${index + 1}</text>`).join('')}</svg>`,
}
const examples =
  query.get('tallWidget') === '1'
    ? [tallExample]
    : query.get('singleWidget') === '1'
      ? [WIDGET_EXAMPLES.overview]
      : [WIDGET_EXAMPLES.overview, WIDGET_EXAMPLES.revenue, WIDGET_EXAMPLES.compound]
const widgets: WidgetRef[] = await Promise.all(
  examples.map(async (example, index) => ({
    widgetId: `w-${index}`,
    threadId: address.threadId,
    turnId: identity.turnId,
    attemptId: identity.attemptId,
    toolCallId: `call-${index}`,
    revision: 1,
    title: example.title,
    summary: example.summary,
    format: example.format,
    executionMode: 'managed',
    libraries: example.libraries as WidgetRef['libraries'],
    bytes: new TextEncoder().encode(example.source).length,
    sha256: await widgetContentSha256(new TextEncoder().encode(example.source)),
    createdAtMs: 1,
  }))
)
const finalContent =
  examples.length === 1
    ? '可视化结果。\n::kcoder-widget{widget_id="w-0" revision=1}'
    : '三种可视化直接穿插在回复中。\n::kcoder-widget{widget_id="w-0" revision=1}\n下面是季度数据。\n::kcoder-widget{widget_id="w-1" revision=1}\n你可以调整复利试算器。\n::kcoder-widget{widget_id="w-2" revision=1}'
const scrollHistory: WorkbenchMessage[] = Array.from({ length: 14 }, (_, index) => ({
  id: `scroll-history-${index}`,
  role: index % 2 ? 'assistant' : 'user',
  content: Array.from(
    { length: 4 },
    (_, paragraph) =>
      `历史阅读锚点 ${index + 1}.${paragraph + 1}：用户正在阅读已完成的对话，后续图表加载或流式输出应保持此处的阅读位置。`
  ).join('\n\n'),
  status: 'done',
  createdAt: '2026-10-12T00:00:00Z',
}))

export function ConversationWidgetsFixture() {
  const scroll = new URLSearchParams(location.search).get('scroll') === '1'
  const history = new URLSearchParams(location.search).get('history') === '1'
  const [phase, setPhase] = useState<'running' | 'done' | 'failed' | 'cancelled' | 'unknown'>(
    history ? 'done' : 'running'
  )
  const [committed, setCommitted] = useState(history)
  const [extra, setExtra] = useState('')
  const [draft, setDraft] = useState('保留已有草稿')
  const [prefix, setPrefix] = useState(0)
  const [reads, setReads] = useState(0)
  const [receipts, setReceipts] = useState(0)
  const [startedAt] = useState(() => Date.now() - 1000)
  const message: WorkbenchMessage = {
    id: 'widget-assistant',
    role: 'assistant',
    subtaskId: identity.attemptId,
    turnId: identity.turnId,
    attemptId: identity.attemptId,
    content: phase === 'running' ? '正在制作可视化。' : finalContent + extra,
    status:
      phase === 'running'
        ? 'streaming'
        : phase === 'done'
          ? 'done'
          : phase === 'unknown'
            ? 'unknown'
            : 'failed',
    runtimeStatus: phase === 'cancelled' ? 'cancelled' : undefined,
    createdAt: '2026-10-12T00:00:00Z',
    blocks: [
      ...(query.get('denseProcess') === '1'
        ? [
            {
              id: 'scroll-thinking',
              subtaskId: identity.attemptId,
              type: 'thinking' as const,
              status: phase === 'running' ? ('streaming' as const) : ('done' as const),
              createdAt: startedAt,
              content: Array.from(
                { length: 40 },
                (_, index) => `正在核对图示 ${index + 1}，此处是需要折叠的中间过程。`
              ).join('\n\n'),
            },
          ]
        : []),
      {
        id: 'call-0',
        subtaskId: identity.attemptId,
        type: 'tool',
        toolName: 'show_widget',
        status: phase === 'running' ? 'running' : 'done',
        createdAt: startedAt,
        toolOutput: committed ? 'committed' : undefined,
      },
    ],
  }
  const request: WidgetRequest = useCallback(
    async <T,>(method: string, params: Record<string, unknown>) => {
      const thread =
        method === 'widget/render/receipt'
          ? (params.widget as Record<string, unknown>).threadId
          : params.threadId
      if (thread !== address.threadId) throw new Error('Fixture target mismatch')
      if (method === 'widget/list')
        return { widgets: committed ? widgets : [], nextOffset: null } as T
      if (method === 'widget/render/receipt') {
        if (phase === 'running' && params.status === 'rendered') setReceipts(value => value + 1)
        return { accepted: true } as T
      }
      const index = widgets.findIndex(
        widget => widget.widgetId === params.widgetId && widget.revision === params.revision
      )
      if (!committed || index < 0) throw new Error('artifact_unavailable')
      if (method === 'widget/read') return { widget: widgets[index] } as T
      if (method !== 'widget/content/read') throw new Error('Unexpected widget fixture operation')
      if (query.get('slowContent') === '1' && phase !== 'running')
        await new Promise(resolve => setTimeout(resolve, 400))
      setReads(value => value + 1)
      const bytes = new TextEncoder().encode(examples[index].source)
      const offset = Number(params.offset)
      const nextOffset = Math.min(bytes.length, offset + 32768)
      return {
        widgetId: params.widgetId,
        revision: params.revision,
        sha256: widgets[index].sha256,
        bytes: bytes.length,
        offset,
        nextOffset,
        dataBase64: btoa(String.fromCharCode(...bytes.slice(offset, nextOffset))),
      } as T
    },
    [committed, phase]
  )
  const messages = scroll ? [...scrollHistory, message] : [message]
  return (
    <div
      className={`${scroll ? 'flex h-dvh flex-col overflow-hidden' : 'h-dvh overflow-auto'} bg-background text-text-primary`}
      data-testid="widget-fixture-scroll"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-sm">
        <button
          data-testid="widget-fixture-prefix"
          className="rounded border border-border px-3 py-2"
          onClick={() => {
            const next = prefix + 1
            setPrefix(next)
            if (prefix === 0) acceptWidgetPreviewNotification(identity, 'turn/started')
            const source =
              next === 1
                ? '<svg viewBox="0 0 160 60"><rect x="10" y="10" width="60" height="30" fill="#3589df"/>'
                : '<svg viewBox="0 0 160 60"><rect x="10" y="10" width="60" height="30" fill="#3589df"/><circle cx="110" cy="25" r="15" fill="#e84a4a"/></svg>'
            acceptWidgetPreviewNotification({ ...identity, sequence: next + 1 }, 'item/event', {
              type: 'widget_input_preview',
              id: 'call-0',
              preview: {
                source,
                title: '实时图示',
                format: 'svg',
                bytes: new TextEncoder().encode(source).length,
                complete: next > 1,
                truncated: false,
              },
            })
          }}
        >
          Append actual SVG prefix
        </button>
        <button
          data-testid="widget-fixture-commit"
          className="rounded border border-border px-3 py-2"
          onClick={() => {
            setCommitted(true)
            widgets.forEach(widget =>
              publishCommittedWidget({ deviceId: address.deviceId, taskId: address.taskId, widget })
            )
          }}
        >
          Commit artifacts
        </button>
        <button
          data-testid="widget-fixture-complete"
          className="rounded border border-border px-3 py-2"
          onClick={() => setPhase('done')}
        >
          Complete turn
        </button>
        <button
          data-testid="widget-fixture-cancel"
          className="rounded border border-border px-3 py-2"
          onClick={() => setPhase('cancelled')}
        >
          Cancel turn
        </button>
        <button
          data-testid="widget-fixture-fail"
          className="rounded border border-border px-3 py-2"
          onClick={() => setPhase('failed')}
        >
          Fail turn
        </button>
        <button
          data-testid="widget-fixture-unknown"
          className="rounded border border-border px-3 py-2"
          onClick={() => setPhase('unknown')}
        >
          Result unknown
        </button>
        <button
          data-testid="widget-fixture-delta"
          className="rounded border border-border px-3 py-2"
          onClick={() => setExtra(value => value + '\n普通文字更新。')}
        >
          Unrelated text update
        </button>
        <output data-testid="widget-fixture-reads">{reads}</output>
        <output data-testid="widget-fixture-active-receipts">{receipts}</output>
      </div>
      <div className={scroll ? 'min-h-0 flex-1' : 'mx-auto max-w-3xl px-6 py-8'}>
        <ConversationWidgetsProvider
          address={address}
          messages={messages}
          request={request}
          onSendPrompt={text => setDraft(value => (value ? `${value}\n${text}` : text))}
        >
          {scroll ? (
            <ScrollableMessageArea
              className="h-full"
              scrollTestId="widget-conversation-scroll"
              messages={messages}
              conversationKey={
                new URLSearchParams(location.search).get('noScrollKey') === '1'
                  ? null
                  : 'widget-scrolling-fixture'
              }
              toolsCatalogServerId={address.deviceId}
              toolsCatalogTaskId={address.taskId}
              showTransientToolStatus={false}
            />
          ) : (
            <MessageList
              processingWindowEnabled
              messages={messages}
              conversationKey="widget-fixture"
            />
          )}
        </ConversationWidgetsProvider>
        {!scroll && (
          <textarea
            data-testid="widget-fixture-draft"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            className="mt-6 min-h-24 w-full rounded-xl border border-border p-3 text-base"
          />
        )}
      </div>
    </div>
  )
}
