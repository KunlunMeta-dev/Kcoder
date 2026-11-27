import { useCallback, useEffect, useRef, useState } from 'react'
import { createRandomUuid } from '@/lib/random-id'
import { captureAccountContextRevision } from './accountContextEvents'
import { getRuntimeConfig } from '@/config/runtime'
import { createMigrationSourceDirectoryIntent, type MigrationSourceLocation } from './migrationSourceDirectoryIntent'
import { createMigrationSourceSessionClient, MigrationSourceHttpError } from './gatewayMigrationSourceSessions'
import type { MigrationDiscoverResult, MigrationSourceKind, MigrationSourceSelectionV1, MigrationSourceSessionParams } from '../../../shared/generated/contracts'

interface OwnedDiscovery {
  session: MigrationSourceSessionParams
  client: ReturnType<typeof createMigrationSourceSessionClient>
  released: boolean
  directory: ReturnType<typeof createMigrationSourceDirectoryIntent>
}

/** Discovery owns a dedicated source child, never a conversation's shared broker. */
export function useMigrationSourceDiscovery(targetId: string | undefined, workspacePath: string | undefined, isCurrent: () => boolean) {
  const [result, setResult] = useState<MigrationDiscoverResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [releasePending, setReleasePending] = useState(false)
  const [session, setSession] = useState<MigrationSourceSessionParams | null>(null)
  const owned = useRef<OwnedDiscovery | null>(null)
  const active = useRef(false)
  const inFlight = useRef(false)
  const [projectConsent, setProjectConsent] = useState(false)
  const visible = useCallback(() => active.current && isCurrent(), [isCurrent])
  const release = useCallback(async (resource: OwnedDiscovery) => {
    if (resource.released) return true
    try {
      const response = await resource.client.close(resource.session)
      resource.released = response.status === 'released'
    } catch {
      // An uncertain close is not evidence that the child was released.
    }
    return resource.released
  }, [])
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      const resource = owned.current
      if (resource) void release(resource)
    }
  }, [release])
  const close = useCallback(async () => {
    if (inFlight.current) return
    const resource = owned.current
    if (!resource) return
    inFlight.current = true
    setBusy(true)
    const released = await release(resource)
    if (visible()) {
      setReleasePending(!released)
      if (released) { setResult(null); setSession(null); owned.current = null }
      setBusy(false)
    }
    inFlight.current = false
  }, [release, visible])
  const discover = useCallback(async (kind: MigrationSourceKind, includeProject: boolean, directory?: MigrationSourceLocation) => {
    if (!targetId || !visible() || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setResult(null)
    setProjectConsent(includeProject)
    let resource: OwnedDiscovery | null = null
    try {
      const desired = createMigrationSourceDirectoryIntent(kind, directory)
      const previous = owned.current
      const retry = previous && !previous.released && previous.directory.pending() && previous.directory.matches(kind, directory)
      if (previous && !retry && !await release(previous)) {
        if (visible()) setReleasePending(true)
        throw new MigrationSourceHttpError('source_transfer_release_pending', false)
      }
      if (!visible()) return
      if (retry) resource = previous
      else {
        const accountCurrent = captureAccountContextRevision(), identity = createRandomUuid(), mount = getRuntimeConfig().appBasePath
        // Cleanup has its own account/mount fence: unmounting must not disable original cleanup.
        const client = createMigrationSourceSessionClient({ captureScope: () => accountCurrent(targetId) && getRuntimeConfig().appBasePath === mount ? identity : '' })
        resource = { session: { sessionId: identity, purpose: 'source', targetId,
          ...(workspacePath === undefined ? {} : { workspacePath }) }, client, released: false, directory: desired }
      }
      owned.current = resource
      setSession(resource.session)
      setReleasePending(false)
      const state = await resource.client.open(resource.session)
      if (!visible()) return
      if (state.status !== 'ready') throw new MigrationSourceHttpError('source_transfer_source_not_ready', false)
      const selected = resource
      await selected.directory.authorize(selected.client, selected.session, () => visible() && owned.current === selected)
      if (!visible() || owned.current !== selected) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
      const value = await selected.client.query({ session: selected.session, query: { kind: 'configuration', params: { sources: [kind], includeProject } } })
      if (visible() && owned.current === resource && 'sources' in value) setResult(value as MigrationDiscoverResult)
    } catch (failure) {
      if (visible()) setError(failure instanceof MigrationSourceHttpError ? failure.code : 'source_transfer_outcome_unknown')
    } finally {
      if (!visible() && resource) {
        // A late open reply still belongs to this view, even if cleanup ran earlier.
        resource.released = false
        await release(resource)
      }
      inFlight.current = false
      if (visible()) setBusy(false)
    }
  }, [release, targetId, workspacePath, visible])
  const deriveCodexLayers = useCallback(async (sourceId: string) => {
    const resource = owned.current
    if (!resource || !visible() || inFlight.current || !projectConsent || !workspacePath ||
      !result?.sources.some(item => item.sourceId === sourceId && item.kind === 'codex' && item.scope === 'user')) {
      throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
    }
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const value = await resource.client.codexLayersSelect(resource.session, { sourceId, includeProject: true })
      if (!visible() || owned.current !== resource) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
      setResult(previous => previous && ({ ...previous, sources: [value.source, ...previous.sources.filter(item => !value.replacesSourceIds.includes(item.sourceId))] }))
      return value
    } catch (failure) {
      if (visible()) setError(failure instanceof MigrationSourceHttpError ? failure.code : 'source_transfer_outcome_unknown')
      throw failure
    } finally {
      inFlight.current = false; if (visible()) setBusy(false)
    }
  }, [result, projectConsent, workspacePath, visible])
  const readCodexLayers = useCallback(async (sourceId: string, pageIndex: number, signal?: AbortSignal) => {
    const resource = owned.current
    if (!resource || !visible() || !result?.sources.some(item => item.sourceId === sourceId && item.scope === 'codex-project-layers')) {
      throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
    }
    const value = await resource.client.codexLayersRead(resource.session, { sourceId, pageIndex }, signal)
    if (!visible() || owned.current !== resource) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
    return value
  }, [result, visible])
  const readConfigurationLayers = useCallback(async (sourceId: string, pageIndex: number, signal?: AbortSignal) => {
    const resource = owned.current
    if (!resource || !visible() || !result?.sources.some(item => item.sourceId === sourceId && item.kind === 'claude-code')) {
      throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
    }
    const value = await resource.client.configurationLayersRead(resource.session, { sourceId, pageIndex }, signal)
    if (!visible() || owned.current !== resource) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
    return value
  }, [result, visible])
  const selections = useCallback(async (ids: string[]): Promise<MigrationSourceSelectionV1[]> => {
    const resource = owned.current
    if (!resource || !visible() || inFlight.current || !ids.length || ids.length > 64
      || new Set(ids).size !== ids.length || ids.some(id => !result?.sources.some(item => item.sourceId === id))) {
      throw new MigrationSourceHttpError('source_transfer_invalid_request', false)
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const selected: MigrationSourceSelectionV1[] = []
      for (let index = 0; index < ids.length; index += 10) {
        const page = await resource.client.bindings(resource.session, ids.slice(index, index + 10))
        if (!visible() || owned.current !== resource) throw new MigrationSourceHttpError('source_transfer_authority_changed', false)
        selected.push(...page.bindings.map(binding => ({ kind: binding.family, sourceId: binding.sourceId })))
      }
      return selected
    } catch (failure) {
      if (visible()) setError(failure instanceof MigrationSourceHttpError ? failure.code : 'source_transfer_outcome_unknown')
      throw failure
    } finally {
      inFlight.current = false
      if (visible()) setBusy(false)
    }
  }, [result, visible])
  return { result, busy, error, releasePending, discover, close, session, selections, deriveCodexLayers, readCodexLayers, readConfigurationLayers, canDeriveCodexLayers: projectConsent && !!workspacePath }
}
