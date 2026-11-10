import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BatchCancellationControl } from '../../../shared/migrationBatchControl'
import { createMigrationApi } from './gatewayMigration'
import { useMigrationProjectMcpCatalog } from './useMigrationProjectMcpCatalog'
import { migrationFailureCode } from './migrationFailureCode'
import { useMigrationBatchMcpCredentials } from './useMigrationBatchMcpCredentials'
import { useMigrationBatchHistorySources } from './useMigrationBatchHistorySources'
import { mcpCandidatePrivateFields, mcpPrivateFieldKey } from './migrationMcpFields'
import { isMigrationBatchStateResult } from '../../../shared/generated/contracts'
import type {
  MigrationResourceLimits,
  MigrationBatchChoice,
  MigrationDiscoverResult,
  MigrationItemsResult,
  MigrationJobReadResult,
  MigrationJobsListResult,
  MigrationBatchItemPlanResult,
  MigrationAssetPreviewResult,
  MigrationApiKeySource,
  MigrationMcpPrivateField,
  MigrationBatchStateResult,
} from '../../../shared/generated/contracts'

/** A closed UI never owns a durable batch. Journals and native receipts own its progress. */
export function useMigrationBatch(
  deviceId: string,
  workspacePath: string | undefined,
  isCurrent: () => boolean,
  onLegacy?: (jobId: string) => void
) {
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const cancellation = useMemo(() => new BatchCancellationControl(() => crypto.randomUUID(), api), [api])
  const mounted = useRef(true),
    running = useRef(false),
    jobRef = useRef<MigrationJobReadResult | null>(null),
    pageRef = useRef(0)
  const [kind, setKind] = useState<'claude-code' | 'codex'>('claude-code')
  const [includeProject, setIncludeProject] = useState(false)
  const [reuseExisting, setReuseExisting] = useState(true)
  const [discovery, setDiscovery] = useState<MigrationDiscoverResult | null>(null)
  const [sources, setSources] = useState<Set<string>>(new Set())
  const [sourceOwner, setSourceOwner] = useState(0)
  const latestSourceOwner = useRef(0)
  const [plugins, setPlugins] = useState<
    Array<{ operationId: string; expectedSequence: number; name: string }>
  >([])
  const [job, setJobState] = useState<MigrationJobReadResult | null>(null)
  const [page, setPage] = useState<MigrationItemsResult>({ items: [] })
  const [pageIndex, setPageIndex] = useState(0)
  const [overrides, setOverrides] = useState<Record<string, MigrationBatchChoice>>({})
  const [credentials, setCredentials] = useState<Record<string, MigrationApiKeySource>>({})
  const [mcpCredentials, setMcpCredentials] = useState<
    Record<
      string,
      {
        fields: MigrationMcpPrivateField[]
        consentPrivateValues: boolean
      }
    >
  >({})
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [records, setRecords] = useState<MigrationJobsListResult | null>(null)
  const [recordCursors, setRecordCursors] = useState<Array<string | undefined>>([undefined])
  const [recordPage, setRecordPage] = useState(0)
  const [busy, setBusy] = useState(false),
    [settling, setSettling] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [error, setError] = useState('')
  const [detail, setDetail] = useState<
    MigrationBatchItemPlanResult | MigrationAssetPreviewResult | null
  >(null)
  const [lastAction, setLastAction] = useState<'apply' | 'rollback' | null>(null)
  const requestIds = useRef<{ apply?: string; rollback?: string; resume?: string }>({})
  const workerSupport = useRef<boolean | null>(null)
  const [worker, setWorker] = useState<MigrationBatchStateResult | null>(null)
  const workerRef = useRef<MigrationBatchStateResult | null>(null)
  const resumeSequence = useRef<number | null>(null)
  const selectionEpoch = useRef(0)
  const mcpPrivate = useMigrationBatchMcpCredentials(deviceId, workspacePath, job, isCurrent)
  const projectMcp = useMigrationProjectMcpCatalog(api, job?.batch?.planId ? undefined : job?.job.jobId, isCurrent)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const valid = () => mounted.current && isCurrent()
  const historySources = useMigrationBatchHistorySources(api, kind, valid)
  const assertCurrent = () => {
    if (!valid()) throw new Error('migration_scope_changed')
  }
  const setJob = (value: MigrationJobReadResult) => {
    if (
      jobRef.current?.job.jobId === value.job.jobId &&
      jobRef.current.job.sequence > value.job.sequence
    )
      return
    jobRef.current = value
    setJobState(value)
  }
  const acceptWorker = useCallback((value: MigrationBatchStateResult) => {
    if (!isMigrationBatchStateResult(value)) throw new Error('migration_invalid_worker_state')
    if (!jobRef.current || jobRef.current.job.jobId === value.state.job.jobId) {
      if (
        !workerRef.current ||
        workerRef.current.state.job.jobId !== value.state.job.jobId ||
        workerRef.current.state.job.sequence <= value.state.job.sequence
      )
        workerRef.current = value
      setWorker(previous =>
        previous?.state.job.jobId === value.state.job.jobId &&
        previous.state.job.sequence > value.state.job.sequence
          ? previous
          : value
      )
      if (
        !value.workerRunning &&
        (!jobRef.current || value.state.job.sequence >= jobRef.current.job.sequence)
      )
        setLastAction(null)
    }
  }, [])
  const readCurrent = useCallback(
    async (
      id: string,
      options?: { signal?: AbortSignal },
      fallback?: MigrationJobReadResult,
      observeWorker: (value: MigrationBatchStateResult) => void = acceptWorker
    ) => {
      const epoch = selectionEpoch.current
      if (workerSupport.current !== false) {
        try {
          const value = await api.readBatch(id, options)
          if (!mounted.current || !isCurrent()) throw new Error('migration_scope_changed')
          if (options?.signal?.aborted || epoch !== selectionEpoch.current)
            throw new Error('migration_observation_cancelled')
          if (!isMigrationBatchStateResult(value)) throw new Error('migration_invalid_worker_state')
          observeWorker(value)
          workerSupport.current = true
          return value.state
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !cause.message.includes('migration_batch_workers_update_required')
          )
            throw cause
          // A read-only capability probe cannot have started or retried a mutation.
          workerSupport.current = false
        }
      }
      return fallback ?? api.read(id)
    },
    [api, isCurrent, acceptWorker]
  )
  const loadPage = async (value: MigrationJobReadResult, index = pageRef.current) => {
    const epoch = selectionEpoch.current
    const next = await api.items({
      jobId: value.job.jobId,
      pageIndex: index,
      includeTemplates: true,
    })
    assertCurrent()
    if (
      epoch === selectionEpoch.current &&
      jobRef.current?.job.jobId === value.job.jobId &&
      jobRef.current.job.sequence <= value.job.sequence &&
      pageRef.current === index
    ) {
      setPage(next)
      return true
    }
    return false
  }
  const recover = async () => {
    const previous = jobRef.current
    if (!previous) return
    const current = await readCurrent(previous.job.jobId)
    assertCurrent()
    setJob(current)
    await loadPage(current)
  }
  const fail = (cause: unknown) => {
    if (valid())
      setError(migrationFailureCode(cause))
  }
  const perform = async (action: () => Promise<void>) => {
    if (running.current || !valid()) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      fail(cause)
      try {
        await recover()
      } catch {
        /* Observation is safe; an uncertain mutation is never replayed here. */
      }
    } finally {
      running.current = false
      if (valid()) setBusy(false)
    }
  }
  const activeWorker = worker?.state.job.jobId === job?.job.jobId ? worker : null
  const observing = Boolean(
    job?.batch?.planId &&
    (settling ||
      (activeWorker
        ? activeWorker.workerRunning
        : ['applying', 'cancel_requested', 'rolling_back'].includes(job.job.status)))
  )
  useEffect(() => {
    if ((!busy && !observing) || !jobRef.current?.batch?.planId) return
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const poll = async () => {
      const previous = jobRef.current
      const epoch = selectionEpoch.current
      const ownsObservation = (current: MigrationJobReadResult, index?: number) =>
        !stopped &&
        mounted.current &&
        isCurrent() &&
        epoch === selectionEpoch.current &&
        jobRef.current?.job.jobId === current.job.jobId &&
        jobRef.current.job.sequence <= current.job.sequence &&
        (index === undefined || pageRef.current === index)
      try {
        if (previous) {
          let observed: MigrationBatchStateResult | undefined
          const current = await readCurrent(
            previous.job.jobId,
            { signal: controller.signal },
            undefined,
            value => {
              observed = value
            }
          )
          if (ownsObservation(current)) {
            const index = pageRef.current
            let page: MigrationItemsResult | undefined
            if (
              current.job.sequence !== previous.job.sequence ||
              observed?.workerRunning === false
            ) {
              if (observed?.workerRunning === false) {
                setSettling(true)
                setJob(current)
                acceptWorker(observed)
              }
              page = await api.items({
                jobId: current.job.jobId,
                pageIndex: index,
                includeTemplates: true,
              })
            }
            if (ownsObservation(current, index)) {
              // A stopped worker remains stopped while its saved results are reconciled.
              // Keep observing until the final page belongs to the same selected snapshot.
              setJob(current)
              if (page) setPage(page)
              if (observed) acceptWorker(observed)
              setSettling(false)
            }
          }
        }
      } catch {
        /* The foreground operation reconciles its own receipt. */
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => {
      stopped = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [api, busy, observing, isCurrent, readCurrent, acceptWorker])
  const defaults = job?.batch?.defaultItemIds ?? []
  const selected = new Set([...defaults.filter(id => !excluded.has(id)), ...Object.keys(overrides)])
  const mcpConsentPending = Object.entries(mcpCredentials).some(
    ([id, choice]) => selected.has(id) && choice.fields.length > 0 && !choice.consentPrivateValues
  )
  const reset = () => {
    if (running.current) return
    selectionEpoch.current++
    latestSourceOwner.current++
    setSourceOwner(latestSourceOwner.current)
    jobRef.current = null
    setJobState(null)
    setPage({ items: [] })
    setDiscovery(null)
    setSources(new Set())
    setDetail(null)
    setOverrides({})
    setCredentials({})
    setMcpCredentials({})
    setExcluded(new Set())
    requestIds.current = {}
    setLastAction(null)
    setSettling(false)
    setCancelling(false)
    setWorker(null)
    historySources.reset()
    setPlugins([])
    workerRef.current = null
    resumeSequence.current = null
    setError('')
    pageRef.current = 0
    setPageIndex(0)
  }
  const open = async (jobId: string) => {
    const epoch = ++selectionEpoch.current
    setSettling(false)
    setCancelling(false)
    const current = await readCurrent(jobId)
    assertCurrent()
    if (epoch !== selectionEpoch.current) return
    historySources.reset()
    setPlugins([])
    if (!current.batch) {
      onLegacy?.(jobId)
      return
    }
    setKind(current.source)
    setJob(current)
    pageRef.current = 0
    setPageIndex(0)
    setOverrides({})
    setCredentials({})
    setMcpCredentials({})
    setExcluded(new Set())
    requestIds.current = {}
    setDetail(null)
    setLastAction(
      current.job.status === 'rolling_back' || current.job.status === 'rollback_conflict'
        ? 'rollback'
        : null
    )
    await loadPage(current, 0)
  }
  return {
    projectMcp,
    acceptUpdatedJob: (value: MigrationJobReadResult) => {
      if (
        valid() &&
        jobRef.current?.job.jobId === value.job.jobId &&
        jobRef.current.job.sequence <= value.job.sequence
      )
        setJob(value)
    },
    kind,
    setKind: (value: 'claude-code' | 'codex') => {
      selectionEpoch.current++
      latestSourceOwner.current++
      setSourceOwner(latestSourceOwner.current)
      setKind(value)
      setDiscovery(null)
      setSources(new Set())
      historySources.reset()
      setPlugins([])
    },
    includeProject,
    setIncludeProject: (value: boolean) => {
      selectionEpoch.current++
      latestSourceOwner.current++
      setSourceOwner(latestSourceOwner.current)
      setIncludeProject(value)
      setDiscovery(null)
      setSources(new Set())
    },
    discovery,
    reuseExisting,
    setReuseExisting,
    sources,
    historySources,
    plugins,
    selectPlugin: (operationId: string, expectedSequence: number, name: string) => {
      if (!valid() || running.current || jobRef.current) return
      if (
        plugins.filter(item => item.operationId !== operationId).length +
          sources.size +
          historySources.selections.length >=
        64
      ) {
        setError('migration_batch_budget_exceeded')
        return
      }
      setPlugins(old => {
        const other = old.filter(item => item.operationId !== operationId)
        if (other.length + sources.size + historySources.selections.length >= 64) return old
        return [...other, { operationId, expectedSequence, name }]
      })
    },
    removePlugin: (operationId: string) =>
      setPlugins(old => old.filter(item => item.operationId !== operationId)),
    job,
    page,
    pageIndex,
    busy: busy || historySources.busy || settling,
    settling,
    workerRunning: activeWorker?.workerRunning ?? false,
    workerProgress: activeWorker?.workerRunning && !settling ? activeWorker.progress : null,
    workerError: activeWorker?.workerError ?? null,
    cancelling,
    error,
    detail,
    lastAction,
    selected,
    credentials,
    mcpCredentials,
    mcpPrivate,
    mcpConsentPending,
    chooseMcpFields: (itemId: string, chosen: MigrationMcpPrivateField[]) => {
      const available = mcpCandidatePrivateFields(page.mcps?.find(item => item.itemId === itemId))
      const keys = new Set(chosen.map(mcpPrivateFieldKey))
      const fields = available.filter(field => keys.has(mcpPrivateFieldKey(field)))
      setMcpCredentials(old => {
        const next = { ...old }
        if (fields.length) next[itemId] = { fields, consentPrivateValues: false }
        else delete next[itemId]
        return next
      })
    },
    consentMcpFields: (itemId: string, consentPrivateValues: boolean) =>
      setMcpCredentials(old =>
        old[itemId]
          ? {
              ...old,
              [itemId]: { ...old[itemId], consentPrivateValues },
            }
          : old
      ),
    chooseCredential: (itemId: string, source?: MigrationApiKeySource) =>
      setCredentials(old => {
        const next = { ...old }
        if (source) next[itemId] = source
        else delete next[itemId]
        return next
      }),
    records,
    recordPage,
    phase: !job
      ? 'source'
      : !job.batch?.planId
        ? 'configure'
        : settling || activeWorker?.workerRunning
          ? 'progress'
          : job.job.status === 'ready'
            ? 'review'
            : observing
              ? 'progress'
              : 'result',
    discover: () =>
      perform(async () => {
        if (sourceOwner !== latestSourceOwner.current) throw new Error('migration_scope_changed')
        const owner = ++latestSourceOwner.current
        setSourceOwner(owner)
        const next = await api.discover({ sources: [kind], includeProject })
        assertCurrent()
        if (owner !== latestSourceOwner.current) throw new Error('migration_scope_changed')
        setDiscovery(next)
        setSources(new Set(next.sources.map(source => source.sourceId)))
      }),
    deriveCodexLayers: (sourceId: string) =>
      perform(async () => {
        if (sourceOwner !== latestSourceOwner.current) throw new Error('migration_scope_changed')
        if (
          kind !== 'codex' ||
          !includeProject ||
          !discovery?.sources.some(
            source =>
              source.sourceId === sourceId && source.kind === 'codex' && source.scope === 'user'
          )
        )
          throw new Error('migration_codex_project_consent_required')
        const epoch = selectionEpoch.current,
          owner = sourceOwner
        const next = await api.codexLayersSelect({ sourceId, includeProject: true })
        assertCurrent()
        if (epoch !== selectionEpoch.current || owner !== latestSourceOwner.current)
          throw new Error('migration_scope_changed')
        if (
          new Set([
            next.source.sourceId,
            ...[...sources].filter(id => !next.replacesSourceIds.includes(id)),
          ]).size +
            plugins.length +
            historySources.selections.length >
          64
        )
          throw new Error('migration_batch_budget_exceeded')
        setDiscovery(old =>
          old
            ? {
                ...old,
                sources: [
                  next.source,
                  ...old.sources.filter(source => source.sourceId !== next.source.sourceId),
                ],
              }
            : old
        )
        setSources(
          old =>
            new Set([
              next.source.sourceId,
              ...[...old].filter(id => !next.replacesSourceIds.includes(id)),
            ])
        )
      }),
    toggleSource: (id: string, checked: boolean) =>
      setSources(old => {
        const next = new Set(old)
        if (checked) next.add(id)
        else next.delete(id)
        return next
      }),
    scan: (resourceLimits?: MigrationResourceLimits) =>
      perform(async () => {
        selectionEpoch.current++
        setSettling(false)
        setCancelling(false)
        setWorker(null)
        const current = await api.scanBatch({
          ...(resourceLimits ? { resourceLimits } : {}),
          sourceIds: [...sources],
          ...(plugins.length
            ? {
                pluginSources: plugins.map(({ operationId, expectedSequence }) => ({
                  operationId,
                  expectedSequence,
                })),
              }
            : {}),
          ...(historySources.selections.length
            ? { historySources: historySources.selections }
            : {}),
        })
        assertCurrent()
        setJob(current)
        pageRef.current = 0
        setPageIndex(0)
        setOverrides({})
        setCredentials({})
        setMcpCredentials({})
        setExcluded(new Set())
        await loadPage(current, 0)
      }),
    choose: (id: string, checked: boolean) => {
      if (!checked) {
        setCredentials(old => {
          const next = { ...old }
          delete next[id]
          return next
        })
        setMcpCredentials(old => {
          const next = { ...old }
          delete next[id]
          return next
        })
      }
      setExcluded(old => {
        const next = new Set(old)
        if (checked) next.delete(id)
        else next.add(id)
        return next
      })
      setOverrides(old => {
        const next = { ...old }
        if (!checked) {
          delete next[id]
          for (const [key, choice] of Object.entries(next))
            if (choice.kind === 'template' && choice.providerItemId === id) delete next[key]
        } else {
          const choice = page.drafts?.find(draft => draft.itemId === id)?.choice
          if (choice) next[id] = choice
        }
        return next
      })
    },
    configure: (choice: MigrationBatchChoice) => {
      setMcpCredentials(old => {
        if (!old[choice.itemId]) return old
        const next = { ...old }
        if (choice.kind === 'mcp')
          next[choice.itemId] = { ...next[choice.itemId], consentPrivateValues: false }
        else delete next[choice.itemId]
        return next
      })
      setOverrides(old => ({ ...old, [choice.itemId]: choice }))
      setExcluded(old => {
        const next = new Set(old)
        next.delete(choice.itemId)
        return next
      })
    },
    choice: (id: string) =>
      overrides[id] ?? page.drafts?.find(draft => draft.itemId === id)?.choice ?? null,
    plan: () =>
      perform(async () => {
        if (!job) return
        if (mcpConsentPending) throw new Error('migration_mcp_private_consent_required')
        const current = await api.planBatch({
          jobId: job.job.jobId,
          expectedSequence: job.job.sequence,
          choices: Object.values(overrides),
          includeDefaultItems: true,
          reuseExisting,
          excludedItemIds: [...excluded],
          ...(projectMcp.controller.selection() ? { projectMcpInheritance: projectMcp.controller.selection() } : {}),
          ...(Object.keys(mcpCredentials).length
            ? {
                mcpCredentials: Object.entries(mcpCredentials)
                  .filter(([itemId]) => selected.has(itemId))
                  .map(([itemId, choice]) => ({ itemId, ...choice })),
              }
            : {}),
          ...(Object.keys(credentials).length
            ? {
                credentials: Object.entries(credentials)
                  .filter(([itemId]) => selected.has(itemId))
                  .map(([itemId, source]) => ({ itemId, source, consentApiKey: true })),
              }
            : {}),
        })
        assertCurrent()
        setJob(current)
        await loadPage(current)
      }),
    operate: (rollback = false) =>
      perform(async () => {
        let current = jobRef.current
        if (!current) return
        const id = current.job.jobId
        selectionEpoch.current++
        setSettling(false)
        setCancelling(false)
        current = await readCurrent(id, undefined, current)
        assertCurrent()
        if (jobRef.current?.job.jobId !== id) return
        setJob(current)
        if (workerRef.current?.state.job.jobId === id && workerRef.current.workerRunning) return
        const planId = current?.batch?.planId
        if (!current || !planId) return
        const action = rollback
          ? 'rollback'
          : workerSupport.current && current.job.status !== 'ready'
            ? 'resume'
            : 'apply'
        setLastAction(rollback ? 'rollback' : 'apply')
        if (action === 'resume' && resumeSequence.current !== current.job.sequence) {
          requestIds.current.resume = undefined
          resumeSequence.current = current.job.sequence
        }
        requestIds.current[action] ??= crypto.randomUUID()
        const params = {
          jobId: current.job.jobId,
          planId,
          expectedSequence: current.job.sequence,
          requestId: requestIds.current[action]!,
        }
        let result: MigrationJobReadResult
        let stillRunning = false
        if (workerSupport.current) {
          const started = await api.runBatch({ ...params, mode: action })
          assertCurrent()
          if (jobRef.current?.job.jobId !== id) return
          acceptWorker(started)
          stillRunning = started.workerRunning
          result = started.state
        } else {
          result = await (rollback ? api.rollbackBatch(params) : api.applyBatch(params))
        }
        assertCurrent()
        setJob(result)
        if (!stillRunning) setLastAction(null)
        await loadPage(result)
      }),
    cancel: async () => {
      let current = jobRef.current
      if (!current || cancelling || !valid()) return
      const epoch = ++selectionEpoch.current
      setCancelling(true)
      try {
        const id = current.job.jobId
        let observed: MigrationBatchStateResult | undefined
        if (workerSupport.current) {
          current = await readCurrent(id, undefined, undefined, value => {
            observed = value
          })
        }
        assertCurrent()
        if (epoch !== selectionEpoch.current || jobRef.current?.job.jobId !== id) return
        if (
          ['completed', 'completed_with_issues', 'rolled_back', 'cancelled'].includes(
            current.job.status
          )
        ) {
          setSettling(true)
          setJob(current)
          if (observed) acceptWorker(observed)
          if (await loadPage(current)) setSettling(false)
          return
        }
        setJob(current)
        if (observed) acceptWorker(observed)
        setSettling(false)
        let controlled = false
        try {
          controlled = await cancellation.cancel(api, id, current.batch?.planId ?? '', () => {
            assertCurrent()
            if (epoch !== selectionEpoch.current || jobRef.current?.job.jobId !== id) throw new Error('migration_scope_changed')
          }) !== null
        } catch (cause) {
          if (!(cause instanceof Error) || cause.message !== 'migration_batch_control_update_required' || cancellation.hasPending(id)) throw cause
          // Older targets retain their original sequence CAS; never infer a new control grant.
        }
        const result = controlled
          ? await readCurrent(id)
          : await api.cancel({ jobId: current.job.jobId, expectedSequence: current.job.sequence })
        assertCurrent()
        if (epoch !== selectionEpoch.current || jobRef.current?.job.jobId !== id) return
        setJob(result)
      } catch (cause) {
        if (epoch !== selectionEpoch.current) return
        fail(cause)
        try {
          await recover()
        } catch {
          /* Cancellation is not a rollback receipt. */
        }
      } finally {
        if (valid() && epoch === selectionEpoch.current) setCancelling(false)
      }
    },
    paginate: (direction: -1 | 1) =>
      perform(async () => {
        const current = jobRef.current
        if (!current) return
        const index = pageRef.current + direction
        if (index < 0 || index * 10 >= current.job.totalItems) return
        pageRef.current = index
        setPageIndex(index)
        await loadPage(current, index)
      }),
    goToPage: (index: number) =>
      perform(async () => {
        const current = jobRef.current
        if (
          !current ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index * 10 >= current.job.totalItems
        )
          return
        pageRef.current = index
        setPageIndex(index)
        await loadPage(current, index)
      }),
    refresh: () => perform(recover),
    reset,
    openRecord: (id: string) => perform(() => open(id)),
    listRecords: (direction?: -1 | 1) =>
      perform(async () => {
        const index = direction == null ? 0 : recordPage + direction
        const cursor = direction === 1 ? (records?.nextCursor ?? undefined) : recordCursors[index]
        if (index < 0 || (direction === 1 && !cursor)) return
        const result = await api.listJobs(cursor ? { cursor } : {})
        assertCurrent()
        setRecords(result)
        setRecordPage(index)
        if (direction == null) setRecordCursors([undefined])
        else if (direction === 1) setRecordCursors(old => [...old.slice(0, index), cursor])
      }),
    inspect: (itemId: string) =>
      perform(async () => {
        const current = jobRef.current
        if (!current) return
        const result =
          current.batch?.planId &&
          page.planned?.some(item => item.itemId === itemId) &&
          !page.assets?.some(item => item.itemId === itemId)
            ? await api.readBatchItem({ jobId: current.job.jobId, itemId, includeTemplate: true })
            : await api.previewAsset({ jobId: current.job.jobId, itemId })
        assertCurrent()
        setDetail(result)
      }),
    closeDetail: () => setDetail(null),
    moreDetail: () =>
      perform(async () => {
        const current = jobRef.current
        if (!current || !detail || !('text' in detail) || detail.nextOffset == null) return
        const next = await api.previewAsset({
          jobId: current.job.jobId,
          itemId: detail.itemId,
          offset: detail.nextOffset,
        })
        assertCurrent()
        setDetail(previous =>
          previous && 'text' in previous && previous.itemId === detail.itemId
            ? { ...next, text: previous.text + next.text }
            : previous
        )
      }),
  }
}
