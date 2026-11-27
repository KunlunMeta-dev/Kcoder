import { MigrationProjectSourceBrowser } from './MigrationProjectSourceBrowser'
import { MigrationInstructionSourceBrowser } from './MigrationInstructionSourceBrowser'
import { useCallback, useEffect, useState } from 'react'
import { Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { useMigrationSourceDiscovery } from '@/kcoder/useMigrationSourceDiscovery'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
import type { MigrationSourceKind, SourceUploadState } from '../../../../shared/generated/contracts'
import { IconSelect } from './settings-ui'
import { MigrationSourceTransferSelection } from './MigrationSourceTransferSelection'
import { MigrationTransferRecords } from './MigrationTransferRecords'
import { migrationSourceRecoveryScope } from '@/kcoder/migrationSourceTransferScope'
import { MigrationHistorySourceBrowser } from './MigrationHistorySourceBrowser'
import { MigrationMemorySourceBrowser } from './MigrationMemorySourceBrowser'
import { MigrationPluginSourceBrowser } from './MigrationPluginSourceBrowser'
import { MigrationDefinitionSourceBrowser } from './MigrationDefinitionSourceBrowser'
import { MigrationSourceDirectoryChoice } from './MigrationSourceDirectoryChoice'
import {
  emptySourceDirectoryChoice,
  sourceDirectoryChoiceReady,
  sourceDirectoryArgument,
} from '@/kcoder/migrationSourceDirectoryIntent'

export function MigrationSourceBrowser({
  targets,
  destination,
  isCurrent,
  onBusy,
  onOpenBatch,
  uploaded,
}: {
  targets: GatewayServer[]
  destination: GatewayServer
  isCurrent: () => boolean
  onBusy: (value: boolean) => void
  onOpenBatch?: (jobId: string) => void
  uploaded?: SourceUploadState
}) {
  const { t } = useTranslation('migration')
  const { t: uploadText } = useTranslation('migrationUpload')
  const [sourceId, setSourceId] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const busy = sourceBusy || recoveryBusy
  const source = uploaded ? destination : targets.find(item => item.id === sourceId)
  const scope = usePluginTargetScope(source?.id, source?.workspacePath)
  const sourceScopeCurrent = scope.isCurrent
  const sourceCurrent = useCallback(
    () => isCurrent() && sourceScopeCurrent(),
    [isCurrent, sourceScopeCurrent]
  )
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  return (
    <section className="mt-4 space-y-3" data-testid="migration-source-browser">
      <p className="text-sm text-text-secondary">
        {uploaded ? uploadText('userSupplied') : t('transferBrowser.description')}
      </p>
      <label htmlFor="migration-source-device" className="block text-sm">
        {t('transferBrowser.source')}
      </label>
      <IconSelect
        id="migration-source-device"
        icon={<Server className="h-4 w-4" />}
        value={source?.id ?? ''}
        disabled={busy || !!uploaded}
        onChange={event => setSourceId(event.target.value)}
      >
        <option value="">{t('target_placeholder')}</option>
        {(uploaded ? [destination] : targets).map(item => (
          <option key={item.id} value={item.id}>
            {item.label || item.id}
          </option>
        ))}
      </IconSelect>
      {source && (!uploaded || uploaded.stage === 'ready') && (
        <SourceContents
          key={`${scope.key}:${uploaded?.operationId ?? ''}:${uploaded?.manifestSha256 ?? ''}`}
          source={source}
          destination={destination}
          isCurrent={sourceCurrent}
          onBusy={setSourceBusy}
          onOpenBatch={onOpenBatch}
          uploaded={uploaded}
        />
      )}
      <MigrationTransferRecords
        key={migrationSourceRecoveryScope(destination)}
        target={destination}
        isCurrent={isCurrent}
        onBusy={setRecoveryBusy}
        onOpenBatch={onOpenBatch}
      />
    </section>
  )
}
type SourceContentsProps = {
  source: GatewayServer
  destination: GatewayServer
  isCurrent: () => boolean
  onBusy: (value: boolean) => void
  onOpenBatch?: (jobId: string) => void
  uploaded?: SourceUploadState
}
function SourceContents({
  source,
  destination,
  isCurrent,
  onBusy,
  onOpenBatch,
  uploaded,
}: SourceContentsProps) {
  const { t } = useTranslation('migration')
  const { t: memoryText } = useTranslation('migrationMemory')
  const [mode, setMode] = useState<
    'configuration' | 'history' | 'memory' | 'definitions' | 'plugins' | 'instructions' | 'projects'
  >('configuration')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(
          [
            'configuration',
            'history',
            'memory',
            'definitions',
            'plugins',
            ...(!uploaded ? ['projects' as const, 'instructions' as const] : []),
          ] as const
        ).map(value => (
          <Button
            key={value}
            size="sm"
            data-testid={`migration-source-mode-${value}`}
            variant={mode === value ? 'secondary' : 'ghost'}
            aria-pressed={mode === value}
            disabled={busy}
            onClick={() => setMode(value)}
          >
            {value === 'projects' ? t('projectSourceMode') : value === 'instructions'
              ? t('instructionSourceMode')
              : value === 'plugins'
                ? t('pluginSource.mode')
                : value === 'definitions'
                  ? t('definitionSource.mode')
                  : value === 'memory'
                    ? memoryText('import')
                    : t(`transferHistory.${value}`)}
          </Button>
        ))}
      </div>
      {mode === 'projects' ? (<MigrationProjectSourceBrowser source={source} destination={destination} isCurrent={isCurrent} onBusy={setBusy} onOpenBatch={onOpenBatch}/>) : mode === 'instructions' ? (
        <MigrationInstructionSourceBrowser
          source={source}
          destination={destination}
          isCurrent={isCurrent}
          onBusy={setBusy}
          onOpenBatch={onOpenBatch}
        />
      ) : mode === 'plugins' ? (
        <MigrationPluginSourceBrowser
          source={source}
          destination={destination}
          isCurrent={isCurrent}
          onBusy={setBusy}
          onOpenBatch={onOpenBatch}
          fixedKind={uploaded?.source}
          root={
            uploaded
              ? { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 }
              : undefined
          }
        />
      ) : mode === 'definitions' ? (
        <MigrationDefinitionSourceBrowser
          source={source}
          destination={destination}
          isCurrent={isCurrent}
          onBusy={setBusy}
          onOpenBatch={onOpenBatch}
          fixedKind={uploaded?.source}
          root={
            uploaded
              ? { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 }
              : undefined
          }
        />
      ) : mode === 'history' ? (
        <MigrationHistorySourceBrowser
          source={source}
          destination={destination}
          isCurrent={isCurrent}
          onBusy={setBusy}
          onOpenBatch={onOpenBatch}
          uploaded={uploaded}
        />
      ) : mode === 'memory' ? (
        <MigrationMemorySourceBrowser
          source={source}
          destination={destination}
          isCurrent={isCurrent}
          onBusy={setBusy}
          onOpenBatch={onOpenBatch}
          fixedKind={uploaded?.source}
          root={
            uploaded
              ? { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 }
              : undefined
          }
        />
      ) : (
        <ConfigurationContents
          source={source}
          destination={destination}
          isCurrent={isCurrent}
          onBusy={setBusy}
          onOpenBatch={onOpenBatch}
          uploaded={uploaded}
        />
      )}
    </div>
  )
}
function ConfigurationContents({
  source,
  destination,
  isCurrent,
  onBusy,
  onOpenBatch,
  uploaded,
}: SourceContentsProps) {
  const { t } = useTranslation('migration')
  const [kind, setKind] = useState<MigrationSourceKind>('claude-code')
  const [includeProject, setIncludeProject] = useState(false)
  const [directory, setDirectory] = useState(emptySourceDirectoryChoice)
  const [transferBusy, setTransferBusy] = useState(false)
  const model = useMigrationSourceDiscovery(source.id, source.workspacePath, isCurrent)
  useEffect(() => {
    onBusy(model.busy || transferBusy)
    return () => onBusy(false)
  }, [model.busy, transferBusy, onBusy])
  const loginRequired =
    source.security?.identity.mode === 'kcoder-account' && !source.accountIdentity
  const working = model.busy || transferBusy
  return (
    <div className="space-y-3" aria-busy={working}>
      <div className="flex gap-2">
        {(['claude-code', 'codex'] as const).map(value => (
          <Button
            key={value}
            size="sm"
            variant={(uploaded?.source ?? kind) === value ? 'secondary' : 'ghost'}
            aria-pressed={(uploaded?.source ?? kind) === value}
            disabled={working || !!uploaded}
            onClick={() => setKind(value)}
          >
            {value === 'codex' ? 'Codex' : 'Claude Code'}
          </Button>
        ))}
      </div>
      {!uploaded && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeProject}
            disabled={working}
            onChange={event => setIncludeProject(event.target.checked)}
          />
          {t('project')}
        </label>
      )}
      {!uploaded && (
        <MigrationSourceDirectoryChoice
          value={directory}
          onChange={setDirectory}
          disabled={working}
        />
      )}
      {loginRequired && (
        <p role="alert" className="text-sm text-text-secondary">
          {t('transferBrowser.login')}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={
            working ||
            loginRequired ||
            model.releasePending ||
            (!uploaded && !sourceDirectoryChoiceReady(directory))
          }
          onClick={() =>
            void model.discover(
              uploaded?.source ?? kind,
              uploaded ? false : includeProject,
              uploaded
                ? { operationId: uploaded.operationId, manifestSha256: uploaded.manifestSha256 }
                : sourceDirectoryArgument(directory)
            )
          }
        >
          {t('find')}
        </Button>
        {model.session && (
          <Button variant="ghost" disabled={working} onClick={() => void model.close()}>
            {t('transferBrowser.disconnect')}
          </Button>
        )}
      </div>
      {model.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(
            model.error.startsWith('source_transfer_directory_')
              ? model.error.endsWith('update_required')
                ? 'sourceDirectory.updateRequired'
                : 'sourceDirectory.failed'
              : [
                    'source_transfer_source_bindings_update_required',
                    'source_transfer_codex_layers_update_required',
                  ].includes(model.error)
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
      {model.result && model.session && (
        <MigrationSourceTransferSelection
          key={model.session.sessionId}
          source={model}
          destination={destination}
          isCurrent={isCurrent}
          onBusy={setTransferBusy}
          onOpenBatch={onOpenBatch}
        />
      )}
    </div>
  )
}
