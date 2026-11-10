import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useMigrationPluginSourceDiscovery } from '@/kcoder/useMigrationPluginSourceDiscovery'
import { useMigrationSourceTransfer } from '@/kcoder/useMigrationSourceTransfer'
import {
  createMigrationSourceDirectoryIntent,
  emptySourceDirectoryChoice,
  sourceDirectoryArgument,
  sourceDirectoryChoiceReady,
} from '@/kcoder/migrationSourceDirectoryIntent'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import { transferablePlugin } from '../../../../shared/migrationPlugins'
import type { MigrationSourceKind } from '../../../../shared/generated/contracts'
import { MigrationSourceDirectoryChoice } from './MigrationSourceDirectoryChoice'
import { MigrationSourceTransferStatus } from './MigrationSourceTransferStatus'
import { MigrationSourceAdoptionPanel } from './MigrationSourceAdoptionPanel'

export function MigrationPluginSourceBrowser({
  source,
  destination,
  isCurrent,
  onBusy,
  onOpenBatch,
  root,
  fixedKind,
}: {
  source: GatewayServer
  destination: GatewayServer
  isCurrent: () => boolean
  onBusy: (busy: boolean) => void
  onOpenBatch?: (jobId: string) => void
  root?: Parameters<typeof createMigrationSourceDirectoryIntent>[1]
  fixedKind?: MigrationSourceKind
}) {
  const { t } = useTranslation('migration')
  const { t: pluginText } = useTranslation('migrationPlugins')
  const [kind, setKind] = useState<MigrationSourceKind>(fixedKind ?? 'claude-code')
  const [includeProject, setIncludeProject] = useState(false)
  const [directory, setDirectory] = useState(emptySourceDirectoryChoice)
  const [consentCatalog, setConsentCatalog] = useState<string | null>(null)
  const uploaded = typeof root === 'object'
  const model = useMigrationPluginSourceDiscovery(source.id, source.workspacePath, isCurrent)
  const transfer = useMigrationSourceTransfer(destination, isCurrent)
  const [adoptionBusy, setAdoptionBusy] = useState(false),
    resolving = useRef(false)
  const busy = model.busy || transfer.busy || adoptionBusy
  const selected = new Set(model.selected.map(item => item.candidateId))
  const partial = !!model.page?.problems.length && consentCatalog !== model.session?.sessionId
  const login =
    (source.security?.identity.mode === 'kcoder-account' && !source.accountIdentity) ||
    (destination.security?.identity.mode === 'kcoder-account' && !destination.accountIdentity)
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  const start = async () => {
    if (!isCurrent() || !model.session || resolving.current || partial) return
    resolving.current = true
    try {
      const selections = await model.selections()
      if (isCurrent()) await transfer.start(model.session, selections)
    } catch {
      /* Keep the original source child and transfer identity; no implicit rediscovery. */
    } finally {
      resolving.current = false
    }
  }
  return (
    <section data-testid="migration-plugin-source-browser" className="space-y-3" aria-busy={busy}>
      <p className="text-sm leading-6 text-text-secondary">{pluginText('transfer.boundary')}</p>
      {uploaded && (
        <p className="text-sm leading-6 text-text-secondary">{pluginText('transfer.uploaded')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {(['claude-code', 'codex'] as const).map(value => (
          <Button
            key={value}
            size="sm"
            variant={(fixedKind ?? kind) === value ? 'secondary' : 'ghost'}
            aria-pressed={(fixedKind ?? kind) === value}
            disabled={busy || !!fixedKind || !!model.session}
            onClick={() => setKind(value)}
          >
            {value === 'codex' ? 'Codex' : 'Claude Code'}
          </Button>
        ))}
      </div>
      {!root && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeProject}
            disabled={busy || !!model.session || !source.workspacePath}
            onChange={event => setIncludeProject(event.target.checked)}
          />
          {pluginText('project.include')}
        </label>
      )}
      {root === undefined && (
        <MigrationSourceDirectoryChoice value={directory} onChange={setDirectory} disabled={busy} />
      )}
      {login && (
        <p role="alert" className="text-sm text-text-secondary">
          {t('transferBrowser.login')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            busy ||
            login ||
            model.releasePending ||
            (root === undefined && !sourceDirectoryChoiceReady(directory))
          }
          onClick={() =>
            void model.discover(
              fixedKind ?? kind,
              root ? false : includeProject,
              root ?? sourceDirectoryArgument(directory)
            )
          }
        >
          {t('find')}
        </Button>
        {model.session && (
          <Button variant="ghost" disabled={busy} onClick={() => void model.close()}>
            {t('transferBrowser.disconnect')}
          </Button>
        )}
      </div>
      {model.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(
            model.error.endsWith('update_required')
              ? 'transferBrowser.updateRequired'
              : 'transferBrowser.error'
          )}
        </p>
      )}
      {model.releasePending && (
        <p role="status" className="text-sm text-text-secondary">
          {t('transferBrowser.releasePending')}
        </p>
      )}
      {model.page && (
        <>
          {!model.page.candidates.length && (
            <p className="text-sm text-text-secondary">{pluginText('empty')}</p>
          )}
          <ul className="divide-y divide-border">
            {model.page.candidates.map(item => (
              <li
                key={item.candidateId}
                className="space-y-1 py-3 text-sm"
                data-testid="migration-plugin-source-row"
              >
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`${item.name} ${pluginText(`scope.${item.scope}`, { defaultValue: pluginText('scope.unknown') })}`}
                    checked={selected.has(item.candidateId)}
                    disabled={
                      busy ||
                      !!transfer.requestId ||
                      !transferablePlugin(item) ||
                      (item.scope !== 'user' && !includeProject && !uploaded) ||
                      (!selected.has(item.candidateId) && selected.size >= 64)
                    }
                    onChange={event => model.select(item.candidateId, event.target.checked)}
                  />
                  <span className="break-words">{item.name}</span>
                </label>
                <p className="text-xs text-text-secondary">
                  {pluginText(`scope.${item.scope}`, { defaultValue: pluginText('scope.unknown') })}{' '}
                  · {item.installedVersion ?? ''}
                </p>
                {!transferablePlugin(item) && (
                  <p className="text-xs text-warning">{pluginText('review')}</p>
                )}
              </li>
            ))}
          </ul>
          {!!model.page.problems.length && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!partial}
                disabled={busy || !!transfer.requestId}
                onChange={event =>
                  setConsentCatalog(event.target.checked ? model.session!.sessionId : null)
                }
              />
              {pluginText('transfer.partial')}
            </label>
          )}
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !!transfer.requestId || model.pageIndex === 0}
              onClick={() => void model.changePage('previous')}
            >
              {t('transferHistory.previous')}
            </Button>
            <span className="text-xs text-text-secondary">
              {pluginText('transfer.page', { page: model.pageIndex + 1 })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !!transfer.requestId || model.page.nextCursor == null}
              onClick={() => void model.changePage('next')}
            >
              {t('transferHistory.next')}
            </Button>
          </div>
          {!transfer.requestId && (
            <Button
              disabled={busy || login || !selected.size || partial}
              onClick={() => void start()}
            >
              {t('transferBrowser.transfer', { count: selected.size })}
            </Button>
          )}
        </>
      )}
      <MigrationSourceTransferStatus model={transfer} />
      {transfer.result?.result?.phase === 'ready' && transfer.result.result.receipt && (
        <MigrationSourceAdoptionPanel
          target={destination}
          receipt={transfer.result.result.receipt}
          isCurrent={isCurrent}
          onBusy={setAdoptionBusy}
          onOpenBatch={onOpenBatch}
        />
      )}
    </section>
  )
}
