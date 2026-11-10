import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'
import { createMigrationPluginsApi } from './gatewayMigrationPlugins'
import { createRandomUuid } from '@/lib/random-id'
import {
  isMigrationPluginDiscoverResult,
  isMigrationPluginListResult,
  isMigrationPluginStateResult,
  type MigrationPluginDiscoverResult,
  type MigrationPluginListResult,
  type MigrationPluginStateResult,
  type MigrationSourceKind,
} from '../../../shared/generated/contracts'
type Api = ReturnType<typeof createMigrationPluginsApi>
type Scope = {
  api: Api
  target: string
  accountCurrent: (target: string) => boolean
  epoch: number
}
type View = {
  catalog: MigrationPluginDiscoverResult | null
  records: MigrationPluginListResult | null
  state: MigrationPluginStateResult | null
  sourcePage: number
  recordPage: number
  busy: boolean
  error: string
  unknownOperation: string | null
}
const EMPTY: View = {
  catalog: null,
  records: null,
  state: null,
  sourcePage: 0,
  recordPage: 0,
  busy: false,
  error: '',
  unknownOperation: null,
}
const errorCode = (error: unknown) =>
  (error instanceof Error ? error.message : '').match(
    /\b(?:plugin_migration|migration)_[a-z_]+\b/
  )?.[0] ?? 'plugin_migration_outcome_unknown'
/** Only reads are automatic. Mutations retain their operation identity and never replay a lost reply. */
export function useMigrationPlugins(
  deviceId: string,
  workspacePath: string | undefined,
  isCurrent: () => boolean,
  initialKind: MigrationSourceKind = 'claude-code'
) {
  const [accountEpoch, setAccountEpoch] = useState(0)
  const [kind, setKindValue] = useState<MigrationSourceKind>(initialKind)
  const [includeProject, setIncludeProjectValue] = useState(false)
  const scope = useMemo<Scope>(
    () => ({
      api: createMigrationPluginsApi(deviceId, workspacePath),
      target: deviceId,
      accountCurrent: captureAccountContextRevision(),
      epoch: accountEpoch,
    }),
    [deviceId, workspacePath, accountEpoch]
  )
  const scopeRef = useRef(scope),
    isCurrentRef = useRef(isCurrent),
    mounted = useRef(false)
  const latest = useRef<MigrationPluginStateResult | null>(null),
    selected = useRef<string | null>(null)
  const requests = useRef(new Map<string, string>()),
    active = useRef(false),
    readTicket = useRef(0),
    acceptedTicket = useRef(0)
  const catalogRevision = useRef(0)
  const sourcePages = useRef<MigrationPluginDiscoverResult[]>([]),
    recordPages = useRef<MigrationPluginListResult[]>([])
  const sourcePage = useRef(0),
    recordPage = useRef(0)
  const observation = useRef<AbortController | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [stored, setStored] = useState<View & { scope: Scope }>({ scope, ...EMPTY })
  const view = stored.scope === scope ? stored : EMPTY
  const valid = useCallback(
    (owner: Scope) =>
      mounted.current &&
      scopeRef.current === owner &&
      isCurrentRef.current() &&
      owner.accountCurrent(owner.target),
    []
  )
  const update = useCallback(
    (owner: Scope, patch: Partial<View>) => {
      if (valid(owner))
        setStored(before => ({
          ...(before.scope === owner ? before : EMPTY),
          ...patch,
          scope: owner,
        }))
    },
    [valid]
  )
  useLayoutEffect(() => {
    scopeRef.current = scope
    isCurrentRef.current = isCurrent
  }, [scope, isCurrent])
  useEffect(
    () =>
      listenAccountContextChanges(target => {
        if (target === deviceId) setAccountEpoch(value => value + 1)
      }),
    [deviceId]
  )
  const accept = useCallback(
    (owner: Scope, value: MigrationPluginStateResult, ticket: number) => {
      if (!valid(owner)) return
      if (
        !isMigrationPluginStateResult(value) ||
        value.job.operationId !== selected.current ||
        !Number.isSafeInteger(value.job.sequence) ||
        !Number.isSafeInteger(value.job.cancelRevision)
      )
        throw new Error('plugin_migration_invalid_result')
      const old = latest.current
      if (
        old &&
        (value.job.sequence < old.job.sequence ||
          value.job.cancelRevision < old.job.cancelRevision ||
          (value.job.sequence === old.job.sequence &&
            value.job.cancelRevision === old.job.cancelRevision &&
            ticket < acceptedTicket.current))
      )
        return
      acceptedTicket.current = ticket
      latest.current = value
      recordPages.current = recordPages.current.map(page => ({
        ...page,
        items: page.items.map(job => (job.operationId === value.job.operationId ? value.job : job)),
      }))
      update(owner, {
        state: value,
        unknownOperation: null,
        ...(recordPages.current[recordPage.current]
          ? { records: recordPages.current[recordPage.current] }
          : {}),
      })
    },
    [valid, update]
  )
  const read = useCallback(
    async (owner: Scope, id: string, signal?: AbortSignal) => {
      const ticket = ++readTicket.current,
        value = await owner.api.read(id, signal ? { signal } : undefined)
      if (!valid(owner) || signal?.aborted || selected.current !== id) return null
      accept(owner, value, ticket)
      return value
    },
    [valid, accept]
  )
  useEffect(() => {
    mounted.current = true
    latest.current = null
    selected.current = null
    requests.current.clear()
    active.current = false
    acceptedTicket.current = 0
    readTicket.current = 0
    sourcePages.current = []
    recordPages.current = []
    sourcePage.current = 0
    recordPage.current = 0
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void scope.api
        .list(undefined, { signal: controller.signal })
        .then(page => {
          if (!isMigrationPluginListResult(page) || page.items.length > 10)
            throw new Error('plugin_migration_invalid_result')
          if (!controller.signal.aborted && valid(scope)) {
            recordPages.current = [page]
            recordPage.current = 0
            update(scope, { records: page, recordPage: 0 })
          }
        })
        .catch(error => {
          if (!controller.signal.aborted) update(scope, { error: errorCode(error) })
        })
    }, 0)
    return () => {
      mounted.current = false
      controller.abort()
      observation.current?.abort()
      clearTimeout(timer)
    }
  }, [scope, update, valid])
  useEffect(() => {
    if (!view.state?.workerRunning) return
    const owner = scope,
      id = view.state.job.operationId,
      controller = new AbortController()
    observation.current = controller
    let timer: ReturnType<typeof setTimeout>,
      failures = 0
    const poll = async () => {
      if (!valid(owner) || controller.signal.aborted || selected.current !== id) return
      try {
        const result = await read(owner, id, controller.signal)
        failures = 0
        if (result?.workerRunning && !controller.signal.aborted)
          timer = setTimeout(() => void poll(), 250)
      } catch (error) {
        if (valid(owner) && !controller.signal.aborted) {
          if (++failures < 4) timer = setTimeout(() => void poll(), 500)
          else update(owner, { error: errorCode(error) })
        }
      }
    }
    timer = setTimeout(() => void poll(), 100)
    return () => {
      controller.abort()
      clearTimeout(timer)
      if (observation.current === controller) observation.current = null
    }
  }, [
    scope,
    view.state?.job.operationId,
    view.state?.workerRunning,
    refreshRevision,
    read,
    update,
    valid,
  ])
  const perform = async (action: (owner: Scope) => Promise<void>) => {
    if (!valid(scope) || active.current) return false
    const owner = scope
    active.current = true
    update(owner, { busy: true, error: '' })
    try {
      await action(owner)
      return valid(owner)
    } catch (error) {
      update(owner, { error: errorCode(error) })
      return false
    } finally {
      if (valid(owner)) {
        active.current = false
        update(owner, { busy: false })
      }
    }
  }
  const discover = (cursor?: string) =>
    perform(async owner => {
      const revision = catalogRevision.current
      const result = await owner.api.discover({
        sources: [kind],
        cursor,
        ...(includeProject ? { includeProject: true } : {}),
      })
      if (!isMigrationPluginDiscoverResult(result) || result.candidates.length > 10)
        throw new Error('plugin_migration_invalid_result')
      if (revision === catalogRevision.current && valid(owner)) {
        if (cursor) {
          sourcePages.current = [...sourcePages.current.slice(0, sourcePage.current + 1), result]
          sourcePage.current++
        } else {
          sourcePages.current = [result]
          sourcePage.current = 0
        }
        update(owner, { catalog: result, sourcePage: sourcePage.current })
      }
    })
  const listRecords = (cursor?: string) =>
    perform(async owner => {
      const result = await owner.api.list(cursor)
      if (!isMigrationPluginListResult(result) || result.items.length > 10)
        throw new Error('plugin_migration_invalid_result')
      if (valid(owner)) {
        if (cursor) {
          recordPages.current = [...recordPages.current.slice(0, recordPage.current + 1), result]
          recordPage.current++
        } else {
          recordPages.current = [result]
          recordPage.current = 0
        }
        update(owner, { records: result, recordPage: recordPage.current })
      }
    })
  const open = (id: string) =>
    perform(async owner => {
      selected.current = id
      latest.current = null
      update(owner, { state: null, unknownOperation: id })
      await read(owner, id)
      if (valid(owner)) setRefreshRevision(value => value + 1)
    })
  const refresh = () => {
    const id = selected.current
    return id ? open(id) : listRecords()
  }
  const plan = (candidateId: string, targetName?: string, mappedProject = false) =>
    perform(async owner => {
      const key = `${candidateId}\0${targetName ?? ''}\0${mappedProject}`
      const prior = requests.current.get(key),
        id = prior ?? createRandomUuid()
      requests.current.set(key, id)
      if (requests.current.size > 32) requests.current.delete(requests.current.keys().next().value!)
      selected.current = id
      latest.current = null
      update(owner, { state: null, unknownOperation: id })
      if (prior) {
        await read(owner, id)
        return
      }
      const ticket = ++readTicket.current
      try {
        accept(
          owner,
          await owner.api.plan({
            requestId: id,
            candidateId,
            targetName,
            ...(mappedProject ? { projectMapping: 'current_workspace' as const } : {}),
          }),
          ticket
        )
      } catch (error) {
        if (valid(owner)) await read(owner, id).catch(() => undefined)
        throw error
      }
    })
  const mutate = (action: 'capture' | 'apply' | 'undo' | 'resume') =>
    perform(async owner => {
      const id = selected.current
      if (!id) return
      const observed = await read(owner, id)
      if (!observed || !valid(owner)) return
      const ticket = ++readTicket.current
      try {
        accept(
          owner,
          await owner.api[action]({ operationId: id, expectedSequence: observed.job.sequence }),
          ticket
        )
      } catch (error) {
        if (valid(owner)) await read(owner, id).catch(() => undefined)
        throw error
      }
    })
  const cancel = async () => {
    if (!valid(scope) || !selected.current) return
    const owner = scope,
      id = selected.current
    try {
      const observed = await read(owner, id)
      if (!observed || !valid(owner)) return
      const ticket = ++readTicket.current
      accept(
        owner,
        await owner.api.cancel({ operationId: id, expectedSequence: observed.job.sequence }),
        ticket
      )
    } catch (error) {
      if (valid(owner)) await read(owner, id).catch(() => undefined)
      update(owner, { error: errorCode(error) })
    }
  }
  const setKind = (value: MigrationSourceKind) => {
    catalogRevision.current++
    sourcePages.current = []
    sourcePage.current = 0
    setKindValue(value)
    update(scope, { catalog: null, sourcePage: 0 })
  }
  const setIncludeProject = (value: boolean) => {
    if (active.current) return
    catalogRevision.current++
    sourcePages.current = []
    sourcePage.current = 0
    setIncludeProjectValue(value)
    update(scope, { catalog: null, sourcePage: 0 })
  }
  const previousSources = () => {
    if (valid(scope) && !active.current && sourcePage.current > 0) {
      sourcePage.current--
      update(scope, {
        catalog: sourcePages.current[sourcePage.current],
        sourcePage: sourcePage.current,
      })
    }
  }
  const previousRecords = () => {
    if (valid(scope) && !active.current && recordPage.current > 0) {
      recordPage.current--
      update(scope, {
        records: recordPages.current[recordPage.current],
        recordPage: recordPage.current,
      })
    }
  }
  return {
    ...view,
    kind,
    setKind,
    includeProject,
    setIncludeProject,
    discover,
    listRecords,
    open,
    refresh,
    plan,
    cancel,
    previousSources,
    previousRecords,
    capture: () => mutate('capture'),
    apply: () => mutate('apply'),
    undo: () => mutate('undo'),
    resume: () => mutate('resume'),
  }
}
