import { useEffect, useMemo, useRef, useState } from 'react'
import { createMigrationApi } from './gatewayMigration'
import { migrationFailureCode } from './migrationFailureCode'
import type {
  MigrationDiscoverResult,
  MigrationItemsResult,
  MigrationJobReadResult,
  MigrationProviderCandidate,
  MigrationSourceKind,
  MigrationItemPreview,
  MigrationMcpCandidate,
  MigrationAssetCandidate,
  MigrationAssetPreviewResult,
} from '../../../shared/generated/contracts'

export type MigrationForm = {
  name: string
  endpoint: string
  model: string
  context: string
  headroom: string
  output: string
}
const emptyForm: MigrationForm = {
  name: '',
  endpoint: '',
  model: '',
  context: '',
  headroom: '',
  output: '',
}
const terminal = (job: MigrationJobReadResult) =>
  ['completed', 'completed_with_issues', 'cancelled', 'rolled_back', 'rollback_conflict'].includes(
    job.job.status
  )
const positive = (value: string) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0

/** UI projections are fenced by the selected target/account lifetime; native journals own outcomes. */
export function useMigration(
  deviceId: string,
  workspacePath: string | undefined,
  isCurrent: () => boolean
) {
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const [kind, setKind] = useState<MigrationSourceKind>('claude-code')
  const [includeProject, setIncludeProject] = useState(false)
  const [discovery, setDiscovery] = useState<MigrationDiscoverResult | null>(null)
  const [sourcePage, setSourcePage] = useState(0)
  const [job, setJobState] = useState<MigrationJobReadResult | null>(null)
  const jobRef = useRef<MigrationJobReadResult | null>(null)
  const [page, setPage] = useState<MigrationItemsResult>({ items: [], providers: [] })
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [pageIndex, setPageIndex] = useState(0)
  const [candidate, setCandidate] = useState<MigrationProviderCandidate | null>(null)
  const [mcpCandidate, setMcpCandidate] = useState<MigrationMcpCandidate | null>(null)
  const [assetCandidate, setAssetCandidate] = useState<MigrationAssetCandidate | null>(null)
  const [assetPreview, setAssetPreview] = useState<MigrationAssetPreviewResult | null>(null)
  const [enableAsset, setEnableAsset] = useState(false)
  const [memoryMapping, setMemoryMapping] = useState<'' | 'global' | 'current_workspace'>('')
  const [mcpCwd, setMcpCwd] = useState('')
  const [enableMcp, setEnableMcp] = useState(false)
  const [selectedItem, setSelectedItem] = useState<MigrationItemPreview | null>(null)
  const [form, setForm] = useState<MigrationForm>(emptyForm)
  const [stage, setStage] = useState<'source' | 'configure' | 'review' | 'result'>('source')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const mounted = useRef(true)
  const [error, setError] = useState('')
  const actionRef = useRef<'apply' | 'rollback' | null>(null)
  const [uncertainAction, setUncertainAction] = useState<'apply' | 'rollback' | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const valid = () => mounted.current && isCurrent()
  const assertCurrent = () => {
    if (!valid()) throw new Error('migration_scope_changed')
  }
  const setJob = (value: MigrationJobReadResult) => {
    jobRef.current = value
    setJobState(value)
  }

  const selectCandidate = (
    value: MigrationProviderCandidate,
    preview?: MigrationItemPreview,
    sourceKind: MigrationSourceKind = kind
  ) => {
    setMcpCandidate(null)
    setAssetCandidate(null)
    setAssetPreview(null)
    setCandidate(value)
    setSelectedItem(preview ?? null)
    const sourceName = preview?.sourceName
    setForm({
      name:
        sourceName && /^[A-Za-z0-9_.-]{1,128}$/.test(sourceName) && sourceName !== 'minimax'
          ? sourceName
          : sourceKind === 'codex'
            ? 'ImportedCodex'
            : 'ImportedClaude',
      endpoint: value.endpoint ?? '',
      model: value.model ?? '',
      context: value.contextWindowTokens?.toString() ?? '',
      headroom: value.outputHeadroomTokens?.toString() ?? '',
      output: value.maxOutputTokens?.toString() ?? '',
    })
  }
  const selectMcp = (value: MigrationMcpCandidate, preview?: MigrationItemPreview) => {
    setCandidate(null)
    setAssetCandidate(null)
    setAssetPreview(null)
    setMcpCandidate(value)
    setSelectedItem(preview ?? null)
    setForm({ ...emptyForm, name: value.name })
    setMcpCwd(value.cwd ?? value.sourceCwd ?? '')
    setEnableMcp(false)
  }
  const recover = async () => {
    const previous = jobRef.current
    if (!previous) return
    const current = await api.read(previous.job.jobId)
    assertCurrent()
    setJob(current)
    const action = actionRef.current
    const settled =
      action === 'rollback'
        ? ['rolled_back', 'rollback_conflict'].includes(current.job.status)
        : terminal(current)
    if (settled) {
      actionRef.current = null
      setUncertainAction(null)
    }
    if (action === 'rollback' || current.job.status === 'rolling_back') setStage('result')
    else if (terminal(current)) setStage('result')
    else if (current.plans.length || current.mcpPlans?.length || current.assetPlans?.length)
      setStage('review')
  }
  const perform = async (action: () => Promise<void>) => {
    if (running.current || !valid()) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      if (!valid()) return
      const code = migrationFailureCode(cause)
      setError(code)
      if (
        ['migration_rollback_ownership_unknown', 'migration_commit_receipt_required'].includes(code)
      ) {
        actionRef.current = null
        setUncertainAction(null)
      }
      try {
        await recover()
      } catch {
        /* A lost observation never grants permission to replay a write. */
      }
    } finally {
      running.current = false
      if (valid()) setBusy(false)
    }
  }
  const loadPage = async (value: MigrationJobReadResult, cursor?: string) => {
    const next = await api.items({ jobId: value.job.jobId, ...(cursor ? { cursor } : {}) })
    assertCurrent()
    setPage(next)
    return next
  }
  const openRecord = (id: string) =>
    perform(async () => {
      const current = await api.read(id)
      assertCurrent()
      setJob(current)
      setKind(current.source)
      let next = await loadPage(current)
      const selectedId =
        current.mcpPlans?.[0]?.itemId ?? current.plans[0]?.itemId ?? current.assetPlans?.[0]?.itemId
      const restoredCursors: Array<string | undefined> = [undefined]
      let restoredPage = 0
      while (
        selectedId &&
        !next.items.some(item => item.id === selectedId) &&
        next.nextCursor &&
        restoredPage < 102
      ) {
        restoredCursors.push(next.nextCursor)
        restoredPage += 1
        next = await loadPage(current, next.nextCursor)
      }
      setPageIndex(restoredPage)
      setCursors(restoredCursors)
      if (terminal(current)) setStage('result')
      else if (current.plans.length || current.mcpPlans?.length || current.assetPlans?.length)
        setStage('review')
      else {
        setStage('configure')
        if (next.providers?.[0])
          selectCandidate(
            next.providers[0],
            next.items.find(item => item.id === next.providers?.[0].itemId),
            current.source
          )
        else if (next.mcps?.[0])
          selectMcp(
            next.mcps[0],
            next.items.find(item => item.id === next.mcps?.[0].itemId)
          )
        else if (next.assets?.[0])
          await chooseAsset(
            next.assets[0],
            next.items.find(item => item.id === next.assets?.[0].itemId)
          )
      }
      if (current.job.status === 'rolling_back') {
        actionRef.current = 'rollback'
        setUncertainAction('rollback')
      }
    })
  const chooseAsset = async (value: MigrationAssetCandidate, preview?: MigrationItemPreview) => {
    const current = jobRef.current
    if (!current) return
    setCandidate(null)
    setMcpCandidate(null)
    setAssetCandidate(value)
    setSelectedItem(preview ?? null)
    setEnableAsset(false)
    setMemoryMapping('')
    setAssetPreview(null)
    setForm({ ...emptyForm, name: value.name })
    const text = await api.previewAsset({ jobId: current.job.jobId, itemId: value.itemId })
    assertCurrent()
    setAssetPreview(text)
  }
  const selectAsset = (value: MigrationAssetCandidate, preview?: MigrationItemPreview) =>
    perform(() => chooseAsset(value, preview))
  const moreAssetPreview = () =>
    perform(async () => {
      const current = jobRef.current
      if (!current || !assetPreview || assetPreview.nextOffset == null) return
      const text = await api.previewAsset({
        jobId: current.job.jobId,
        itemId: assetPreview.itemId,
        offset: assetPreview.nextOffset,
      })
      assertCurrent()
      setAssetPreview({ ...text, text: assetPreview.text + text.text })
    })
  const discover = () =>
    perform(async () => {
      const result = await api.discover({ sources: [kind], includeProject })
      assertCurrent()
      setDiscovery(result)
      setSourcePage(0)
    })
  const scan = (sourceId: string) =>
    perform(async () => {
      const result = await api.scan({ sourceId })
      assertCurrent()
      setJob(result)
      setCandidate(null)
      setMcpCandidate(null)
      setAssetCandidate(null)
      setAssetPreview(null)
      setSelectedItem(null)
      setStage('configure')
      const next = await loadPage(result)
      setCursors([undefined])
      setPageIndex(0)
      const first =
        next.providers?.find(value => value.model && value.endpoint) ??
        (!next.mcps?.length ? next.providers?.[0] : undefined)
      if (first)
        selectCandidate(
          first,
          next.items.find(item => item.id === first.itemId)
        )
      else if (next.mcps?.[0])
        selectMcp(
          next.mcps[0],
          next.items.find(item => item.id === next.mcps?.[0].itemId)
        )
      else if (next.assets?.[0])
        await chooseAsset(
          next.assets[0],
          next.items.find(item => item.id === next.assets?.[0].itemId)
        )
      setStage('configure')
    })
  const paginate = (direction: -1 | 1) =>
    perform(async () => {
      if (!job) return
      const index = pageIndex + direction
      const cursor = direction === 1 ? (page.nextCursor ?? undefined) : cursors[index]
      if (index < 0 || (direction === 1 && !cursor)) return
      await loadPage(job, cursor)
      if (direction === 1) setCursors(old => [...old.slice(0, index), cursor])
      setPageIndex(index)
    })
  const unresolvable = selectedItem?.issues.some(
    issue =>
      issue.severity === 'blocking' &&
      (issue.phase ?? 'import') === 'import' &&
      !['missing_model', 'missing_model_limits', 'invalid_endpoint'].includes(issue.code) &&
      !(issue.code === 'requires_review' && ['model', 'endpoint'].includes(issue.field ?? '')) &&
      !(mcpCandidate && issue.field === 'cwd' && mcpCwd.trim())
  )
  const canPlan = Boolean(
    (selectedItem?.category !== 'memory' || memoryMapping === 'global' || memoryMapping === 'current_workspace' && !!workspacePath) &&
    ((assetCandidate && assetPreview?.itemId === assetCandidate.itemId && form.name.trim()) ||
      (mcpCandidate && form.name.trim()) ||
      (candidate &&
        form.name.trim() &&
        form.endpoint.trim() &&
        form.model.trim() &&
        positive(form.context) &&
        positive(form.headroom) &&
        positive(form.output))) &&
    !unresolvable &&
    !job?.issues.some(
      issue => issue.severity === 'blocking' && (issue.phase ?? 'import') === 'import'
    )
  )
  const plan = () =>
    perform(async () => {
      if (!job || (!candidate && !mcpCandidate && !assetCandidate) || !canPlan) return
      const result = assetCandidate
        ? await api.planAsset({
            jobId: job.job.jobId,
            expectedSequence: job.job.sequence,
            itemId: assetCandidate.itemId,
            targetName: form.name.trim(),
            enableAfterImport: ['memory', 'agent', 'hook'].includes(selectedItem?.category ?? '') ? false : enableAsset,
            ...(selectedItem?.category === 'memory' && memoryMapping ? { memoryMapping } : {}),
          })
        : mcpCandidate
          ? await api.planMcp({
              jobId: job.job.jobId,
              expectedSequence: job.job.sequence,
              itemId: mcpCandidate.itemId,
              targetName: form.name.trim(),
              ...(mcpCwd.trim() ? { cwd: mcpCwd.trim() } : {}),
              enableAfterImport: enableMcp,
            })
          : await api.plan({
              jobId: job.job.jobId,
              expectedSequence: job.job.sequence,
              itemId: candidate!.itemId,
              targetName: form.name.trim(),
              endpoint: form.endpoint.trim(),
              model: form.model.trim(),
              contextWindowTokens: Number(form.context),
              outputHeadroomTokens: Number(form.headroom),
              maxOutputTokens: Number(form.output),
            })
      assertCurrent()
      setJob(result)
      setStage('review')
      await loadPage(result)
    })
  const operate = (rollback = false) =>
    perform(async () => {
      const current = jobRef.current,
        selected = current?.assetPlans?.[0] ?? current?.mcpPlans?.[0] ?? current?.plans[0]
      if (!current || !selected) return
      actionRef.current = rollback ? 'rollback' : 'apply'
      setUncertainAction(actionRef.current)
      const params = {
        jobId: current.job.jobId,
        planId: selected.planId,
        expectedSequence: current.job.sequence,
      }
      const mcp = Boolean(current.mcpPlans?.length)
      const result = await (current.assetPlans?.length
        ? rollback
          ? api.rollbackAsset(params)
          : api.applyAsset(params)
        : mcp
          ? rollback
            ? api.rollbackMcp(params)
            : api.applyMcp(params)
          : rollback
            ? api.rollback(params)
            : api.apply(params))
      assertCurrent()
      setJob(result)
      actionRef.current = null
      setUncertainAction(null)
      setStage(terminal(result) ? 'result' : 'review')
      await loadPage(result)
    })
  const cancel = () =>
    perform(async () => {
      if (!job) return
      const result = await api.cancel({ jobId: job.job.jobId, expectedSequence: job.job.sequence })
      assertCurrent()
      setJob(result)
      if (terminal(result)) {
        actionRef.current = null
        setUncertainAction(null)
      }
      setStage(terminal(result) ? 'result' : 'review')
    })
  const reset = () => {
    if (running.current) return
    jobRef.current = null
    setJobState(null)
    setStage('source')
    setDiscovery(null)
    setError('')
    actionRef.current = null
    setUncertainAction(null)
    setPage({ items: [] })
    setCandidate(null)
    setForm(emptyForm)
    setMcpCandidate(null)
    setAssetCandidate(null)
    setAssetPreview(null)
    setEnableAsset(false)
    setSelectedItem(null)
    setMcpCwd('')
    setEnableMcp(false)
  }
  return {
    acceptUpdatedJob: (value: MigrationJobReadResult) => {
      if (
        valid() &&
        jobRef.current?.job.jobId === value.job.jobId &&
        jobRef.current.job.sequence <= value.job.sequence
      )
        setJob(value)
    },
    kind,
    setKind: (value: MigrationSourceKind) => {
      setKind(value)
      setDiscovery(null)
    },
    includeProject,
    setIncludeProject: (value: boolean) => {
      setIncludeProject(value)
      setDiscovery(null)
    },
    discovery,
    sourcePage,
    sources: discovery?.sources.slice(sourcePage * 10, sourcePage * 10 + 10) ?? [],
    paginateSources: (direction: -1 | 1) =>
      setSourcePage(old =>
        Math.max(
          0,
          Math.min(
            Math.max(0, Math.ceil((discovery?.sources.length ?? 0) / 10) - 1),
            old + direction
          )
        )
      ),
    job,
    page,
    pageIndex,
    candidate,
    mcpCandidate,
    assetCandidate,
    assetPreview,
    enableAsset,
    setEnableAsset,
    memoryMapping,
    setMemoryMapping,
    selectAsset,
    moreAssetPreview,
    mcpCwd,
    setMcpCwd,
    enableMcp,
    setEnableMcp,
    selectMcp,
    selectedItem,
    form,
    setForm,
    stage,
    busy,
    error,
    uncertainAction,
    canPlan,
    discover,
    scan,
    paginate,
    plan,
    apply: () => operate(),
    rollback: () => operate(true),
    cancel,
    selectCandidate,
    reset,
    refresh: () =>
      perform(async () => {
        await recover()
        if (jobRef.current) {
          await loadPage(jobRef.current)
          setPageIndex(0)
          setCursors([undefined])
        }
      }),
    openRecord,
  }
}
