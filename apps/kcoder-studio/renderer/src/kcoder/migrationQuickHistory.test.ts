import { describe, expect, test, vi } from 'vitest'
import {
  QuickHistoryMigration,
  quickHistoryId,
  type QuickHistoryApi,
} from './migrationQuickHistory'
import type { HistorySourceSummary } from '../../../shared/generated/contracts'

type Arg<K extends keyof QuickHistoryApi> = Parameters<QuickHistoryApi[K]>[0]
type HistoryRecord = {
  job: { jobId: string; source: string; stage: string; sequence: number; failureCode: null }
  workerRunning: boolean
  workerState: string
  workerError: null
}
type BranchRecord = {
  progress: { viewId: string; stage: string; sequence: number; issues: string[] }
  workerRunning: boolean
}
type ContinuationRecord = {
  job: {
    jobId: string
    sourceJobId: string
    viewId: string
    stage: string
    sequence: number
    threadId: string | null
  }
  workerRunning: boolean
}

function fixture(count = 1, codex = 0) {
  let generation = 0
  const selected = new Map<string, HistorySourceSummary>()
  const rows = (source: 'claude-code' | 'codex', size: number) =>
    Array.from(
      { length: size },
      (_, i) =>
        ({
          sourceHandle: `${source}-${i}`,
          source,
          sourceSessionId: `${source}-session-${i}`,
          sourceArtifactId: null,
          parentSessionId: null,
          agentId: null,
          bytes: 100 + i,
          modifiedAtMs: 123,
          archived: false,
          compressed: false,
          title: `Conversation ${i}`,
          project: null,
          previewIncomplete: false,
          importIssues: [],
        }) satisfies HistorySourceSummary
    )
  const claudeRows = rows('claude-code', count),
    codexRows = rows('codex', codex)
  const catalogs = new Map<string, HistorySourceSummary[]>()
  const page = (catalogId: string, offset: number) => ({
    catalogId,
    items: catalogs.get(catalogId)!.slice(offset, offset + 10),
    totalItems: catalogs.get(catalogId)!.length,
    nextCursor: offset + 10 < catalogs.get(catalogId)!.length ? String(offset + 10) : null,
    discoveryComplete: true,
    problems: [],
  })
  const jobs = new Map<string, HistoryRecord>(),
    views = new Map<string, BranchRecord>(),
    tools = new Set<string>()
  const attachments = new Map<
    string,
    { stage: string; sequence: number; info?: unknown; catalog?: unknown }
  >()
  const continuations = new Map<string, ContinuationRecord>(),
    calls: string[] = []
  const api = {
    historyDiscover: vi.fn(async ({ source }: Arg<'historyDiscover'>) => {
      const id = source + ++generation,
        entries = (source === 'codex' ? codexRows : claudeRows).map(row => ({
          ...row,
          sourceHandle: `${row.sourceHandle}-${generation}`,
        }))
      entries.forEach(row => selected.set(row.sourceHandle, row))
      catalogs.set(id, entries)
      return page(id, 0)
    }),
    historySources: vi.fn(async ({ catalogId, cursor }: Arg<'historySources'>) =>
      page(catalogId, Number(cursor))
    ),
    historyCreate: vi.fn(async ({ requestId, sourceHandle }: Arg<'historyCreate'>) => {
      calls.push('create')
      const source = selected.get(sourceHandle)!
      if (!jobs.has(requestId))
        jobs.set(requestId, {
          job: {
            jobId: requestId,
            source: source.source,
            stage: 'capturing',
            sequence: 0,
            failureCode: null,
          },
          workerRunning: false,
          workerState: 'stopped',
          workerError: null,
        })
      return jobs.get(requestId)
    }),
    historyRun: vi.fn(async ({ jobId }: Arg<'historyRun'>) => {
      calls.push('archive')
      const value = jobs.get(jobId)
      value.job.stage = 'normalized'
      value.job.sequence++
      return value
    }),
    historyRead: vi.fn(async (id: string) => jobs.get(id)),
    historyResume: vi.fn(async ({ jobId }: Arg<'historyResume'>) => {
      const row = jobs.get(jobId)
      row.job.stage = 'planned'
      return row
    }),
    historyCancel: vi.fn(async () => ({})),
    historyAttachmentRead: vi.fn(async ({ selection }: Arg<'historyAttachmentRead'>) => ({
      job: attachments.get(JSON.stringify(selection)) ?? null,
      workerRunning: false,
    })),
    historyAttachmentRun: vi.fn(async ({ selection }: Arg<'historyAttachmentRun'>) => {
      const job = {
        stage: 'ready',
        sequence: 1,
        info: {
          kind: 'embedded_base64',
          receipt: { attachmentId: 'fixture', bytes: 2, chunkBytes: 2, sha256: 'fixture' },
        },
      }
      attachments.set(JSON.stringify(selection), job)
      return { job, workerRunning: false }
    }),
    historyAttachmentResume: vi.fn(async ({ selection }: Arg<'historyAttachmentResume'>) => {
      const job = {
        stage: 'ready',
        sequence: 2,
        info: {
          kind: 'embedded_base64',
          receipt: { attachmentId: 'fixture', bytes: 2, chunkBytes: 2, sha256: 'fixture' },
        },
      }
      attachments.set(JSON.stringify(selection), job)
      return { job, workerRunning: false }
    }),
    historyAttachmentCancel: vi.fn(async () => ({})),
    historyAttachmentItems: vi.fn(async () => ({
      items: [],
      nextCursor: null,
      summary: {
        structured: true,
        attachments: 0,
        opaqueItems: 0,
        sourceItems: 0,
        unknownItems: 0,
      },
    })),
    branchPrepare: vi.fn(async ({ jobId }: Arg<'branchPrepare'>) => {
      calls.push('branch')
      if (!views.has(jobId))
        views.set(jobId, {
          progress: { viewId: 'view-' + jobId, stage: 'planned', sequence: 0, issues: [] },
          workerRunning: false,
        })
      return views.get(jobId)
    }),
    branchRead: vi.fn(async ({ jobId }: Arg<'branchRead'>) => views.get(jobId)),
    branchRun: vi.fn(async ({ jobId }: Arg<'branchRun'>) => {
      views.get(jobId).progress.stage = 'ready'
      return views.get(jobId)
    }),
    branchResume: vi.fn(async ({ jobId }: Arg<'branchResume'>) => views.get(jobId)),
    branchCancel: vi.fn(async () => ({})),
    branchToolsRead: vi.fn(async ({ viewId }: Arg<'branchToolsRead'>) => ({
      state: { run: tools.has(viewId) ? { stage: 'ready' } : null, workerRunning: false },
      workerError: null,
    })),
    branchToolsRun: vi.fn(async ({ viewId }: Arg<'branchToolsRun'>) => {
      tools.add(viewId)
      return {}
    }),
    branchToolsResume: vi.fn(async ({ viewId }: Arg<'branchToolsResume'>) => {
      tools.add(viewId)
      return {}
    }),
    branchToolsCancel: vi.fn(async () => ({})),
    continuationCreate: vi.fn(
      async ({ requestId, sourceJobId, viewId }: Arg<'continuationCreate'>) => {
        calls.push('continue')
        if (!continuations.has(requestId))
          continuations.set(requestId, {
            job: {
              jobId: requestId,
              sourceJobId,
              viewId,
              stage: 'planned',
              sequence: 0,
              threadId: null,
            },
            workerRunning: false,
          })
        return continuations.get(requestId)
      }
    ),
    continuationRun: vi.fn(async ({ jobId }: Arg<'continuationRun'>) => {
      const row = continuations.get(jobId)
      row.job.stage = 'imported'
      row.job.threadId = 'thread-' + jobId
      return row
    }),
    continuationRead: vi.fn(async ({ jobId }: Arg<'continuationRead'>) => continuations.get(jobId)),
    continuationResume: vi.fn(async ({ jobId }: Arg<'continuationResume'>) => {
      const row = continuations.get(jobId)!
      row.job.stage = 'imported'
      row.job.threadId = 'thread-' + jobId
      return row
    }),
    continuationCancel: vi.fn(async () => ({})),
    undoLookup: vi.fn(async (): Promise<{ existingJob: { stage: string } | null }> => ({
      existingJob: null,
    })),
    continuationSource: vi.fn(async ({ threadId }: Arg<'continuationSource'>) => {
      const row = [...continuations.values()].find(row => row.job.threadId === threadId)
      return { source: { sourceJobId: row.job.sourceJobId, viewId: row.job.viewId } }
    }),
  }
  const create = (
    current = () => true,
    options: { concurrency?: number; sleep?: () => Promise<void>; maxObservations?: number } = {}
  ) =>
    new QuickHistoryMigration({
      api: api as unknown as QuickHistoryApi,
      namespace: 'owned-account-target',
      isCurrent: current,
      sleep: () => Promise.resolve(),
      maxObservations: 5,
      concurrency: 2,
      ...options,
    })
  return { api, create, jobs, views, continuations, attachments, calls, claudeRows, codexRows }
}

describe('quick import composes Native receipts', () => {
  function blockForAttachments(
    f: ReturnType<typeof fixture>,
    issues: Array<{ code: string; position: number; blockIndex: number }>
  ) {
    f.api.continuationRun.mockImplementation(async ({ jobId }) => {
      const row = f.continuations.get(jobId)!
      Object.assign(row.job, { stage: 'blocked', compilation: { issues, issuesTruncated: false } })
      return row
    })
  }

  test('prepares an embedded attachment and resumes the same continuation', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_required', position: 7, blockIndex: 2 },
    ])
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'imported' })
    expect(f.api.historyAttachmentRun).toHaveBeenCalledTimes(1)
    expect(f.api.historyAttachmentRun.mock.calls[0][0].selection).toMatchObject({
      position: 7,
      blockIndex: 2,
      toolItemIndex: null,
    })
    expect(f.api.continuationResume).toHaveBeenCalledTimes(1)
    expect(f.continuations.size).toBe(1)
  })

  test('resumes a previously failed attachment using its original selection and sequence', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_not_ready', position: 7, blockIndex: 2 },
    ])
    f.api.historyAttachmentRead.mockResolvedValueOnce({
      job: { stage: 'failed', sequence: 42 },
      workerRunning: false,
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'imported' })
    expect(f.api.historyAttachmentRun).not.toHaveBeenCalled()
    expect(f.api.historyAttachmentResume).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSequence: 42 })
    )
    expect(f.continuations.size).toBe(1)
  })

  test('catalogues and prepares each embedded tool-result attachment', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_collection_required', position: 5, blockIndex: 0 },
    ])
    const original = f.api.historyAttachmentRun.getMockImplementation()!
    f.api.historyAttachmentRun.mockImplementation(async input => {
      if (input.selection.toolItemIndex != null) return original(input)
      const job = {
        stage: 'catalogued',
        sequence: 1,
        catalog: {
          structured: true,
          attachments: 2,
          opaqueItems: 0,
          sourceItems: 2,
          unknownItems: 0,
        },
      }
      f.attachments.set(JSON.stringify(input.selection), job)
      return { job, workerRunning: false }
    })
    f.api.historyAttachmentItems.mockResolvedValue({
      items: [
        { index: 0, sourceArrayIndex: 0, sourceType: 'image' },
        { index: 1, sourceArrayIndex: 1, sourceType: 'document' },
      ],
      nextCursor: null,
      summary: {
        structured: true,
        attachments: 2,
        opaqueItems: 0,
        sourceItems: 2,
        unknownItems: 0,
      },
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'imported' })
    expect(
      f.api.historyAttachmentRun.mock.calls.map(([input]) => input.selection.toolItemIndex)
    ).toEqual([null, 0, 1])
    expect(f.api.continuationResume).toHaveBeenCalledTimes(1)
  })

  test('does not resume a continuation when the historical attachment is unavailable', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_required', position: 7, blockIndex: 2 },
    ])
    f.api.historyAttachmentRun.mockImplementation(async ({ selection }) => {
      const job = { stage: 'unavailable', sequence: 1, info: { kind: 'remote_reference' } }
      f.attachments.set(JSON.stringify(selection), job)
      return { job, workerRunning: false }
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({
      status: 'failed',
      error: 'history_attachment_unavailable',
    })
    expect(f.api.continuationResume).not.toHaveBeenCalled()
  })

  test('does not restart an attachment when its worker outcome is unknown', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_required', position: 7, blockIndex: 2 },
    ])
    f.api.historyAttachmentRead.mockImplementationOnce(async () => ({
      job: null,
      workerRunning: false,
      workerError: 'history_attachment_job_failed',
    }))
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({
      status: 'failed',
      error: 'history_attachment_job_failed',
    })
    expect(f.api.historyAttachmentRun).not.toHaveBeenCalled()
    expect(f.api.continuationResume).not.toHaveBeenCalled()
  })

  test('does not poll forever or replay an attachment whose worker disappeared', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_required', position: 7, blockIndex: 2 },
    ])
    f.api.historyAttachmentRun.mockImplementation(async ({ selection }) => {
      const job = { stage: 'planned', sequence: 1 }
      f.attachments.set(JSON.stringify(selection), job)
      return { job, workerRunning: false }
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({
      status: 'failed',
      error: 'history_attachment_execution_unknown',
    })
    expect(f.api.historyAttachmentRun).toHaveBeenCalledTimes(1)
    expect(f.api.continuationResume).not.toHaveBeenCalled()
  })

  test('does not extract an item outside the verified attachment catalog', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_collection_required', position: 5, blockIndex: 0 },
    ])
    f.api.historyAttachmentRun.mockImplementation(async ({ selection }) => {
      const job = {
        stage: 'catalogued',
        sequence: 1,
        catalog: {
          structured: true,
          attachments: 1,
          opaqueItems: 0,
          sourceItems: 1,
          unknownItems: 0,
        },
      }
      f.attachments.set(JSON.stringify(selection), job)
      return { job, workerRunning: false }
    })
    f.api.historyAttachmentItems.mockResolvedValue({
      items: [{ index: 7, sourceArrayIndex: 0, sourceType: 'image' }],
      nextCursor: null,
      summary: {
        structured: true,
        attachments: 1,
        opaqueItems: 0,
        sourceItems: 1,
        unknownItems: 0,
      },
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({
      status: 'failed',
      error: 'history_attachment_catalog_changed',
    })
    expect(f.api.historyAttachmentRun).toHaveBeenCalledTimes(1)
    expect(f.api.continuationResume).not.toHaveBeenCalled()
  })

  test('does not prepare attachments while other history problems remain', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_required', position: 7, blockIndex: 2 },
      { code: 'history_context_unresolved_tool', position: 8, blockIndex: 0 },
    ])
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'failed' })
    expect(f.api.historyAttachmentRun).not.toHaveBeenCalled()
    expect(f.api.continuationResume).not.toHaveBeenCalled()
  })

  test('rechecks an unresolved Codex base using archived physical versions of the same session', async () => {
    const f = fixture(0, 2)
    f.codexRows[0].sourceArtifactId = 'physical-parent'
    f.codexRows[1].sourceArtifactId = 'physical-child'
    f.codexRows[1].sourceSessionId = f.codexRows[0].sourceSessionId
    const jobId = (row: HistorySourceSummary) =>
      quickHistoryId(
        'owned-account-target',
        row.source,
        row.sourceSessionId,
        row.sourceArtifactId,
        row.agentId,
        row.bytes,
        row.modifiedAtMs
      )
    const parent = jobId(f.codexRows[0]),
      child = jobId(f.codexRows[1])
    const original = f.api.branchPrepare.getMockImplementation()!
    f.api.branchPrepare.mockImplementation(async input => {
      const value = (await original(input))!
      if (input.jobId === child && input.relatedJobIds.length === 0)
        value.progress.issues = ['codex_history_base_unresolved', 'source_records_require_review']
      else if (input.jobId === child) {
        const replacement = {
          progress: { viewId: 'lineage-' + child, stage: 'planned', sequence: 0, issues: [] },
          workerRunning: false,
        }
        f.views.set(child, replacement)
        return replacement
      }
      return value
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows.every(row => row.status === 'imported')).toBe(true)
    expect(
      f.api.branchPrepare.mock.calls.some(
        ([input]) => input.jobId === child && input.relatedJobIds.includes(parent)
      )
    ).toBe(true)
    expect(f.continuations.size).toBe(2)
  })

  test('pausing during attachment preparation cancels only that attachment', async () => {
    const f = fixture(0, 1)
    blockForAttachments(f, [
      { code: 'history_context_attachment_required', position: 7, blockIndex: 2 },
    ])
    let release!: () => void
    f.api.historyAttachmentRead.mockImplementationOnce(async () => ({
      job: null,
      workerRunning: false,
    }))
    f.api.historyAttachmentRead.mockImplementationOnce(
      async () =>
        new Promise(done => {
          release = () => done({ job: null, workerRunning: false })
        })
    )
    const model = f.create()
    const pending = model.start(['codex'], 'kcoder')
    await vi.waitFor(() => expect(f.api.historyAttachmentRead).toHaveBeenCalledTimes(2))
    await model.pause()
    release()
    await pending
    expect(f.api.historyAttachmentCancel).toHaveBeenCalledTimes(1)
    expect(f.api.continuationResume).not.toHaveBeenCalled()
    expect(model.getSnapshot().phase).toBe('paused')
  })
  test.each([
    'history_job_busy',
    'history_catalog_busy',
    'history_context_preparation_busy',
    'continuation_busy',
  ])('reconciles the same continuation after %s', async code => {
    const f = fixture(0, 1)
    const run = f.api.continuationRun.getMockImplementation()!
    let first = true
    f.api.continuationRun.mockImplementation(async input => {
      const result = await run(input)
      if (first) {
        first = false
        throw new Error(code)
      }
      return result
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'imported' })
    expect(f.api.continuationRun).toHaveBeenCalledTimes(1)
    expect(f.continuations.size).toBe(1)
    expect(f.api.continuationCreate).toHaveBeenCalledTimes(2)
    expect(f.api.continuationCreate.mock.calls[0][0].requestId).toBe(
      f.api.continuationCreate.mock.calls[1][0].requestId
    )
  })

  test('contention retries are bounded and unknown outcomes are not retried', async () => {
    for (const [error, expected] of [
      ['history_job_busy', 8],
      ['connection_lost', 1],
    ] as const) {
      const f = fixture(0, 1)
      f.api.branchPrepare.mockRejectedValue(new Error(error))
      const model = f.create()
      await model.start(['codex'], 'kcoder')
      expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'failed' })
      expect(f.api.branchPrepare).toHaveBeenCalledTimes(expected)
      expect(f.api.continuationCreate).not.toHaveBeenCalled()
    }
  })

  test('a persisted busy failure is reconciled rather than endlessly polled', async () => {
    const f = fixture(0, 1)
    let first = true
    f.api.branchRun.mockImplementation(async ({ jobId }) => {
      const view = f.views.get(jobId)!
      if (first) {
        first = false
        Object.assign(view.progress, { stage: 'failed', failureCode: 'history_job_busy' })
      } else {
        Object.assign(view.progress, { stage: 'ready', failureCode: null })
      }
      return view
    })
    f.api.branchResume.mockImplementation(async ({ jobId }) => {
      const view = f.views.get(jobId)!
      view.progress.stage = 'planned'
      return view
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'imported' })
    expect(f.api.branchResume).toHaveBeenCalledTimes(1)
    expect(f.api.branchRun).toHaveBeenCalledTimes(2)
    expect(f.continuations.size).toBe(1)
  })

  test('waits for active workers before interpreting their previous terminal state', async () => {
    const f = fixture(0, 1)
    const historyRead = f.api.historyRead.getMockImplementation()!
    f.api.historyRead.mockImplementationOnce(async id => {
      const value = (await historyRead(id))!
      return { ...value, job: { ...value.job, stage: 'failed' }, workerRunning: true }
    })
    const branchRead = f.api.branchRead.getMockImplementation()!
    f.api.branchRead.mockImplementationOnce(async input => {
      const value = (await branchRead(input))!
      return { ...value, progress: { ...value.progress, stage: 'failed' }, workerRunning: true }
    })
    const toolsRead = f.api.branchToolsRead.getMockImplementation()!
    let toolsObservations = 0
    f.api.branchToolsRead.mockImplementation(async input => {
      const value = await toolsRead(input)
      if (value.state.run && toolsObservations++ === 0)
        return { ...value, state: { run: { stage: 'failed' }, workerRunning: true } }
      return value
    })
    const continuationRead = f.api.continuationRead.getMockImplementation()!
    f.api.continuationRead.mockImplementationOnce(async input => {
      const value = (await continuationRead(input))!
      return { ...value, job: { ...value.job, stage: 'failed' }, workerRunning: true }
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'imported' })
    expect(f.continuations.size).toBe(1)
    expect(f.api.continuationRun).toHaveBeenCalledTimes(1)
  })

  test('imports every page beyond both the first page and the old 64-selection UI limit', async () => {
    const f = fixture(65, 12),
      model = f.create()
    await model.start(['claude-code', 'codex'], 'kcoder')
    expect(model.getSnapshot().phase).toBe('complete')
    expect(model.getSnapshot().rows).toHaveLength(77)
    expect(model.getSnapshot().rows.every(row => row.status === 'imported')).toBe(true)
    expect(f.api.historySources).toHaveBeenCalledTimes(7)
    expect(f.calls.filter(call => call === 'create')).toHaveLength(77)
    expect(f.calls.indexOf('archive')).toBeGreaterThan(0)
    expect(f.calls.indexOf('archive')).toBeLessThan(77)
    expect(f.calls.lastIndexOf('archive')).toBeLessThan(f.calls.indexOf('branch'))
    expect(f.api.continuationCreate.mock.calls[0][0].options).toEqual({
      model: null,
      settingsTemplate: null,
      studioWorkMode: 'kcoder',
    })
  })

  test('a repeated click or reopened controller validates sources again and reuses the same sessions', async () => {
    const f = fixture(3)
    await f.create().start(['claude-code'], 'kworker')
    const before = [...f.continuations.keys()]
    const model = f.create()
    await model.start(['claude-code'], 'kworker')
    expect([...f.continuations.keys()]).toEqual(before)
    expect(f.api.continuationRun).toHaveBeenCalledTimes(3)
    expect(f.api.historyCreate).toHaveBeenCalledTimes(6)
    expect(model.getSnapshot().rows.every(row => row.status === 'imported')).toBe(true)
  })

  test('continues observing the original tool-correlation worker during catalog contention', async () => {
    const f = fixture()
    const read = f.api.branchToolsRead.getMockImplementation()!
    f.api.branchToolsRead
      .mockImplementationOnce(read)
      .mockRejectedValueOnce(new Error('history_catalog_busy'))
    const model = f.create()
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().rows[0].status).toBe('imported')
    expect(f.api.branchToolsRun).toHaveBeenCalledOnce()
    expect(f.api.branchToolsRead).toHaveBeenCalledTimes(3)
  })

  test('retries only safe observations when the catalog is temporarily busy', async () => {
    const f = fixture()
    f.api.branchToolsRead.mockRejectedValueOnce(new Error('history_catalog_busy'))
    f.api.undoLookup.mockRejectedValueOnce(new Error('history_catalog_busy'))
    f.api.continuationSource.mockRejectedValueOnce(new Error('history_catalog_busy'))
    const model = f.create()
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().rows[0].status).toBe('imported')
    expect(f.api.branchToolsRun).toHaveBeenCalledOnce()
    expect(f.api.continuationCreate).toHaveBeenCalledOnce()
    expect(f.api.undoLookup).toHaveBeenCalledTimes(2)
    expect(f.api.continuationSource).toHaveBeenCalledTimes(2)
  })

  test('one source or item failure does not block other conversations', async () => {
    const f = fixture(3, 1)
    f.claudeRows[0].importIssues = ['history_source_budget_exceeded']
    f.api.historyCreate.mockRejectedValueOnce(new Error('history_job_request_conflict'))
    const model = f.create()
    await model.start(['claude-code', 'codex'], 'kcoder')
    expect(model.getSnapshot().rows.map(row => row.status)).toEqual([
      'failed',
      'failed',
      'imported',
      'imported',
    ])
    expect(f.continuations.size).toBe(2)
  })

  test.each([
    ['compilation', 'history_context_incomplete_branch'],
    ['projection', 'historical_projection_context_budget_exceeded'],
  ])('reports the actual blocked continuation %s issue', async (report, issue) => {
    const f = fixture()
    f.api.continuationRun.mockImplementationOnce(async ({ jobId }) => {
      const row = f.continuations.get(jobId)!
      row.job.stage = 'blocked'
      Object.assign(row.job, { [report]: { issues: [{ code: issue }] } })
      return row
    })
    const model = f.create()
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({
      status: 'failed',
      archiveReady: true,
      error: issue,
    })
  })

  test('uses a distinct reconstructed branch only for a blocked single-root Codex history', async () => {
    const f = fixture(0, 1)
    const prepare = f.api.branchPrepare.getMockImplementation()!
    f.api.branchPrepare.mockImplementation(async input => {
      const result = await prepare(input)
      if (input.reconstructReadable) {
        result.progress = {
          viewId: 'reconstructed-' + input.jobId,
          stage: 'planned',
          sequence: 0,
          issues: ['codex_readable_reconstruction_requires_admission'],
        }
      } else result.progress.issues = ['source_records_require_review']
      return result
    })
    const model = f.create()
    await model.start(['codex'], 'kcoder')
    expect(f.api.branchPrepare).toHaveBeenCalledTimes(2)
    expect(f.api.branchPrepare.mock.calls[1][0]).toMatchObject({
      reconstructReadable: true,
      relatedJobIds: [],
    })
    expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'imported', reconstructed: true })
    expect([...f.continuations.values()][0].job.viewId).toMatch(/^reconstructed-/)
  })

  for (const code of [
    'history_reconstruction_checkpoint_unsupported',
    'history_reconstruction_checkpoint_not_found',
    'history_reconstruction_source_requires_review',
  ]) {
    for (const supportsNewRecipe of [true, false]) {
      test(`reconciles ${code} only with a distinct recipe (${supportsNewRecipe})`, async () => {
        const f = fixture(0, 1)
        const prepare = f.api.branchPrepare.getMockImplementation()!
        const run = f.api.branchRun.getMockImplementation()!
        let reconstructedAttempts = 0
        f.api.branchPrepare.mockImplementation(async input => {
          const result = await prepare(input)
          if (!input.reconstructReadable) result.progress.issues = ['source_records_require_review']
          else {
            reconstructedAttempts++
            result.progress = {
              viewId: reconstructedAttempts > 1 && supportsNewRecipe ? 'new-recipe' : 'old-recipe',
              stage: 'planned',
              sequence: 0,
              issues: ['codex_readable_reconstruction_requires_admission'],
            }
          }
          return result
        })
        f.api.branchRun.mockImplementation(async input => {
          if (input.viewId === 'old-recipe') {
            const value = f.views.get(input.jobId)!
            Object.assign(value.progress, { stage: 'failed', failureCode: code })
            return value
          }
          return run(input)
        })
        const model = f.create()
        await model.start(['codex'], 'kcoder')
        expect(
          f.api.branchRun.mock.calls.filter(([input]) => input.viewId === 'old-recipe')
        ).toHaveLength(1)
        expect(f.api.branchResume).not.toHaveBeenCalled()
        if (supportsNewRecipe) {
          expect(model.getSnapshot().rows[0]).toMatchObject({
            status: 'imported',
            reconstructed: true,
          })
          expect([...f.continuations.values()][0].job.viewId).toBe('new-recipe')
        } else {
          expect(model.getSnapshot().rows[0]).toMatchObject({ status: 'failed', error: code })
          expect(f.api.continuationCreate).not.toHaveBeenCalled()
        }
      })
    }
  }

  test('a lost create reply is never blindly replayed; an explicit next click reconciles the same intent', async () => {
    const f = fixture()
    const create = f.api.continuationCreate.getMockImplementation()!
    f.api.continuationCreate.mockImplementationOnce(async input => {
      await create(input)
      throw new Error('connection lost')
    })
    const model = f.create()
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().rows[0].status).toBe('failed')
    expect(f.api.continuationRun).not.toHaveBeenCalled()
    await model.start(['claude-code'], 'kcoder')
    expect(f.continuations.size).toBe(1)
    expect(f.api.continuationRun).toHaveBeenCalledOnce()
    expect(model.getSnapshot().rows[0].status).toBe('imported')
  })

  test('closing or changing accounts during a pending selection never launches subsequent work', async () => {
    for (const changed of [false, true]) {
      const f = fixture(2)
      let resolve!: () => void,
        current = true
      const original = f.api.historyCreate.getMockImplementation()!
      f.api.historyCreate.mockImplementationOnce(
        async input =>
          new Promise<HistoryRecord>(done => {
            resolve = async () => done(await original(input))
          })
      )
      const model = f.create(() => current),
        pending = model.start(['claude-code'], 'kcoder')
      await vi.waitFor(() => expect(f.api.historyCreate).toHaveBeenCalledOnce())
      if (changed) current = false
      else model.dispose()
      resolve()
      await pending
      expect(f.api.historyRun).not.toHaveBeenCalled()
      expect(f.api.historyCreate).toHaveBeenCalledOnce()
    }
  })

  test('pause cancels only the active job and keeps imported work for a later explicit continuation', async () => {
    const f = fixture(2)
    let resolve!: () => void
    f.api.historyRead.mockImplementationOnce(
      async (id: string) =>
        new Promise<HistoryRecord>(done => {
          resolve = () => done(f.jobs.get(id)!)
        })
    )
    const model = f.create(),
      pending = model.start(['claude-code'], 'kcoder')
    await vi.waitFor(() => expect(f.api.historyRead).toHaveBeenCalledTimes(2))
    await model.pause()
    resolve()
    await pending
    expect(f.api.historyCancel).toHaveBeenCalledOnce()
    expect(f.api.historyRun).toHaveBeenCalledTimes(2)
    expect(f.api.branchPrepare).not.toHaveBeenCalled()
    expect(model.getSnapshot().phase).toBe('paused')
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().rows.every(row => row.status === 'imported')).toBe(true)
  })

  test('links Codex ancestors only after their archives are complete', async () => {
    const f = fixture(0, 2)
    f.codexRows[1].parentSessionId = f.codexRows[0].sourceSessionId
    await f.create().start(['codex'], 'kcoder')
    const parentJob = f.api.historyCreate.mock.results[0]
    const parent = await parentJob.value
    expect(f.api.branchPrepare.mock.calls[1][0].relatedJobIds).toEqual([parent.job.jobId])
  })

  test('pausing between steps never cancels an archive that has already completed', async () => {
    const f = fixture()
    const prepare = f.api.branchPrepare.getMockImplementation()!
    let finish!: () => void
    f.api.branchPrepare.mockImplementationOnce(
      input =>
        new Promise<BranchRecord>(done => {
          finish = async () => done(await prepare(input))
        })
    )
    const model = f.create(),
      pending = model.start(['claude-code'], 'kcoder')
    await vi.waitFor(() => expect(f.api.branchPrepare).toHaveBeenCalledOnce())
    await model.pause()
    finish()
    await pending
    expect(f.api.historyCancel).not.toHaveBeenCalled()
    expect(f.api.branchRun).not.toHaveBeenCalled()
    expect(model.getSnapshot().rows[0].archiveReady).toBe(true)
    expect(model.getSnapshot().phase).toBe('paused')
  })

  test('does not convert an unclassified read error into success or retry a mutation', async () => {
    const f = fixture()
    f.api.branchToolsRead.mockRejectedValueOnce(new Error('migration_operation_failed'))
    const model = f.create()
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({
      status: 'failed',
      error: 'migration_operation_failed',
    })
    expect(f.api.branchToolsRead).toHaveBeenCalledOnce()
    expect(f.api.branchToolsRun).not.toHaveBeenCalled()
  })

  test('never reports an undone conversation as ready or recreates it', async () => {
    const f = fixture()
    f.api.undoLookup.mockResolvedValueOnce({ existingJob: { stage: 'undone' } })
    const model = f.create()
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().rows[0]).toMatchObject({
      status: 'failed',
      error: 'migration_quick_retired',
    })
    expect(f.api.continuationSource).not.toHaveBeenCalled()
    expect(f.api.continuationCreate).toHaveBeenCalledOnce()
  })

  test('reports incomplete discovery rather than claiming all sources were found', async () => {
    const f = fixture()
    const discover = f.api.historyDiscover.getMockImplementation()!
    f.api.historyDiscover.mockImplementationOnce(async input => ({
      ...(await discover(input)),
      discoveryComplete: false,
    }))
    const model = f.create()
    await model.start(['claude-code'], 'kcoder')
    expect(model.getSnapshot().warnings).toEqual([
      { source: 'claude-code', code: 'history_discovery_incomplete' },
    ])
    expect(model.getSnapshot().rows[0].status).toBe('imported')
  })

  test('request identities change for another target or another immutable source snapshot', () => {
    expect(quickHistoryId('a', 'source', 1)).toBe(quickHistoryId('a', 'source', 1))
    expect(quickHistoryId('a', 'source', 1)).not.toBe(quickHistoryId('b', 'source', 1))
    expect(quickHistoryId('a', 'source', 1)).not.toBe(quickHistoryId('a', 'source', 2))
    expect(quickHistoryId('a')).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    )
  })
})

describe('bounded independent history lanes', () => {
  test('pins remaining metadata while two archives run and exposes completion without waiting for input order', async () => {
    const f = fixture(5),
      waits = new Map<string, () => void>()
    let active = 0,
      peak = 0,
      blocked = true
    f.api.historyRead.mockImplementation(async id => {
      if (!blocked) return f.jobs.get(id)!
      active++
      peak = Math.max(peak, active)
      return new Promise<HistoryRecord>(resolve =>
        waits.set(id, () => {
          active--
          waits.delete(id)
          resolve(f.jobs.get(id)!)
        })
      )
    })
    const model = f.create(),
      running = model.start(['claude-code'], 'kcoder')
    await vi.waitFor(() => expect(waits.size).toBe(2))
    expect(f.api.historyCreate).toHaveBeenCalledTimes(5)
    expect(f.api.historyRun).toHaveBeenCalledTimes(2)
    const first = model.getSnapshot().rows[0],
      second = model.getSnapshot().rows[1]
    waits.get(second.jobId)!()
    await vi.waitFor(() => expect(second.status).toBe('archived'))
    expect(first.status).toBe('archiving')
    await vi.waitFor(() => expect(f.api.historyRun).toHaveBeenCalledTimes(3))
    expect(peak).toBe(2)
    blocked = false
    ;[...waits.values()].forEach(resolve => resolve())
    await running
    expect(model.getSnapshot().rows.every(row => row.status === 'imported')).toBe(true)
    expect(f.api.historyRun).toHaveBeenCalledTimes(5)
  })

  test('pause cancels each admitted original job and never starts the queued third archive', async () => {
    const f = fixture(4),
      waits: Array<() => void> = []
    f.api.historyRead.mockImplementation(
      async id => new Promise<HistoryRecord>(resolve => waits.push(() => resolve(f.jobs.get(id)!)))
    )
    const model = f.create(),
      running = model.start(['claude-code'], 'kcoder')
    await vi.waitFor(() => expect(waits).toHaveLength(2))
    const active = f.api.historyRun.mock.calls.map(([input]) => input.jobId)
    await model.pause()
    waits.forEach(resolve => resolve())
    await running
    expect(f.api.historyCancel.mock.calls.map(([id]) => id).sort()).toEqual([...active].sort())
    expect(f.api.historyRun).toHaveBeenCalledTimes(2)
    expect(f.api.branchPrepare).not.toHaveBeenCalled()
    expect(model.getSnapshot().phase).toBe('paused')
  })

  test('refuses unsupported concurrency before discovery or any source admission', () => {
    const f = fixture(4)
    for (const concurrency of [0, 65, 100, Infinity, 1.5])
      expect(() => f.create(() => true, { concurrency })).toThrow(
        'migration_history_concurrency_invalid'
      )
    expect(f.api.historyDiscover).not.toHaveBeenCalled()
    expect(f.api.historyCreate).not.toHaveBeenCalled()
  })

  test('controlled Native-worker latency baseline is 480ms serial versus 240ms with two lanes', async () => {
    vi.useFakeTimers()
    try {
      const measure = async (concurrency: number) => {
        const f = fixture(12),
          original = f.api.historyRun.getMockImplementation()!
        f.api.historyRun.mockImplementation(async input => {
          const value = f.jobs.get(input.jobId)!
          value.job.stage = 'normalizing'
          value.workerRunning = true
          value.workerState = 'running'
          setTimeout(() => {
            void original(input)
            value.workerRunning = false
            value.workerState = 'stopped'
          }, 40)
          return value
        })
        const model = f.create(() => true, {
          concurrency,
          maxObservations: 100,
          sleep: () => new Promise(resolve => setTimeout(resolve, 10)),
        })
        const began = Date.now()
        let elapsed = -1
        model.subscribe(() => {
          if (model.getSnapshot().phase === 'complete') elapsed = Date.now() - began
        })
        const running = model.start(['claude-code'], 'kcoder')
        await vi.advanceTimersByTimeAsync(1000)
        await running
        expect(model.getSnapshot().rows.filter(row => row.status === 'imported')).toHaveLength(12)
        return elapsed
      }
      const serial = await measure(1),
        parallel = await measure(2)
      expect(serial).toBe(480)
      expect(parallel).toBe(240)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('native-declared sixty-four-way migration', () => {
  const createCurrent = (
    f: ReturnType<typeof fixture>,
    api: QuickHistoryApi = f.api as unknown as QuickHistoryApi
  ) =>
    new QuickHistoryMigration({
      api,
      namespace: 'owned-account-target',
      isCurrent: () => true,
      sleep: () => Promise.resolve(),
      maxObservations: 5,
    })
  test('default admits 64 archives, queues source 65, and cancellation drains every original slot without replay', async () => {
    const f = fixture(72),
      waits: Array<() => void> = []
    const original = f.api.historyRead.getMockImplementation()!
    f.api.historyRead.mockImplementation(
      async id => new Promise<HistoryRecord>(resolve => waits.push(() => resolve(f.jobs.get(id)!)))
    )
    const model = createCurrent(f),
      running = model.start(['claude-code'], 'kcoder')
    await vi.waitFor(() => expect(waits).toHaveLength(64))
    expect(f.api.historyRun).toHaveBeenCalledTimes(64)
    const owned = f.api.historyRun.mock.calls.map(([input]) => input.jobId)
    await model.pause()
    expect(f.api.historyCancel.mock.calls.map(([id]) => id).sort()).toEqual([...owned].sort())
    waits.forEach(done => done())
    await running
    expect(f.api.historyRun).toHaveBeenCalledTimes(64)
    expect(f.api.branchPrepare).not.toHaveBeenCalled()
    f.api.historyRead.mockImplementation(original)
    await model.start(['claude-code'], 'kcoder')
    expect(f.api.historyRun).toHaveBeenCalledTimes(72)
    expect(f.api.continuationRun).toHaveBeenCalledTimes(72)
    expect(model.getSnapshot().rows.filter(row => row.status === 'imported')).toHaveLength(72)
  })

  test('64 child-first Codex sources do not hold continuation lanes waiting for their parent at selection 65', async () => {
    const f = fixture(0, 65),
      parentSession = f.codexRows[64].sourceSessionId
    for (const child of f.codexRows.slice(0, 64)) child.parentSessionId = parentSession
    let blocked = true
    const waits: Array<() => void> = []
    f.api.historyRead.mockImplementation(async id =>
      blocked
        ? new Promise<HistoryRecord>(resolve => waits.push(() => resolve(f.jobs.get(id)!)))
        : f.jobs.get(id)
    )
    const model = createCurrent(f),
      running = model.start(['codex'], 'kcoder')
    await vi.waitFor(() => expect(waits).toHaveLength(64))
    expect(f.api.branchPrepare).not.toHaveBeenCalled()
    expect(f.api.historyRun).toHaveBeenCalledTimes(64)
    blocked = false
    waits.forEach(done => done())
    await running
    const rows = model.getSnapshot().rows,
      parent = rows[64]
    expect(rows.map(row => row.source.sourceSessionId)).toEqual(
      f.codexRows.map(row => row.sourceSessionId)
    )
    expect(rows.every(row => row.status === 'imported')).toBe(true)
    expect(f.api.historyRun).toHaveBeenCalledTimes(65)
    for (const [input] of f.api.branchPrepare.mock.calls.filter(
      ([input]) => input.jobId !== parent.jobId
    ))
      expect(input.relatedJobIds).toEqual([parent.jobId])
  })

  test('old targets use declared conservative capacity and surface the update requirement before admitting work', async () => {
    const f = fixture(3),
      waits: Array<() => void> = []
    let block = true
    f.api.historyRead.mockImplementation(async id =>
      block
        ? new Promise<HistoryRecord>(resolve => waits.push(() => resolve(f.jobs.get(id)!)))
        : f.jobs.get(id)
    )
    const historyConcurrency = vi.fn(async () => ({ maxConcurrentJobs: 1, requiresUpdate: true }))
    const model = createCurrent(f, { ...f.api, historyConcurrency } as unknown as QuickHistoryApi)
    const running = model.start(['claude-code'], 'kcoder')
    await vi.waitFor(() => expect(waits).toHaveLength(1))
    expect(model.getSnapshot()).toMatchObject({ concurrency: 1, requiresUpdate: true })
    expect(f.api.historyRun).toHaveBeenCalledOnce()
    block = false
    waits[0]()
    await running
    expect(historyConcurrency).toHaveBeenCalledOnce()
    expect(model.getSnapshot().rows.every(row => row.status === 'imported')).toBe(true)
  })
})
