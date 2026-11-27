import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import {
  connectModelPolicies,
  ModelPolicyError,
  type ModelPolicyClient,
  type ModelPolicyTarget,
} from '@/kcoder/modelPolicies'
import type {
  IntegrationModelPolicyCatalog,
  IntegrationModelPolicySettingsSnapshot,
  IntegrationModelSelectionIntent,
} from '../../../../shared/generated/contracts'
import { PolicySettingsEditor } from './PolicySettingsEditor'
import { PolicyPreview, type AutoPolicyIntent } from './PolicyPreview'
interface Props {
  target: ModelPolicyTarget
  value?: IntegrationModelSelectionIntent
  onSelect?: (intent: AutoPolicyIntent) => void
  allowEdit?: boolean
}
export function NativeModelPolicyWorkspace({ target, value, onSelect, allowEdit = true }: Props) {
  const { key, isCurrent } = usePluginTargetScope(target.serverId, target.workspacePath)
  return (
    <OwnedModelPolicyWorkspace
      key={key}
      isCurrent={isCurrent}
      target={target}
      value={value}
      onSelect={onSelect}
      allowEdit={allowEdit}
    />
  )
}
function OwnedModelPolicyWorkspace({
  target,
  value,
  onSelect,
  allowEdit,
  isCurrent,
}: Props & { isCurrent: () => boolean }) {
  const { t } = useTranslation('modelPolicies')
  const { serverId, workspacePath, requiredCapability } = target
  const [ready, setReady] = useState<{
    client: ModelPolicyClient
    catalog: IntegrationModelPolicyCatalog
    settings?: IntegrationModelPolicySettingsSnapshot
    settingsError?: ModelPolicyError['code']
  }>()
  const [failure, setFailure] = useState<'unavailable' | 'unsupported'>()
  const [revision, setRevision] = useState(0)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    pending.current = abort
    let client: ModelPolicyClient | undefined
    if (serverId)
      void (async () => {
        try {
          client = await connectModelPolicies(
            { serverId, workspacePath, requiredCapability },
            isCurrent,
            abort.signal
          )
          const [catalog, settings] = await Promise.allSettled([
            client.policies(abort.signal),
            allowEdit ? client.settings(abort.signal) : Promise.resolve(undefined),
          ])
          if (abort.signal.aborted || !isCurrent()) return
          if (catalog.status !== 'fulfilled') throw catalog.reason
          setReady({
            client,
            catalog: catalog.value,
            settings: settings.status === 'fulfilled' ? settings.value : undefined,
            settingsError:
              settings.status === 'rejected'
                ? settings.reason instanceof ModelPolicyError
                  ? settings.reason.code
                  : 'unavailable'
                : undefined,
          })
          setFailure(undefined)
        } catch (error) {
          if (!abort.signal.aborted && isCurrent())
            setFailure(
              error instanceof ModelPolicyError && error.code === 'unsupported'
                ? 'unsupported'
                : 'unavailable'
            )
        }
      })()
    return () => {
      abort.abort()
      client?.dispose()
    }
  }, [serverId, workspacePath, requiredCapability, isCurrent, allowEdit, revision])
  const refreshCatalog = () => {
    if (!ready) return
    const abort = new AbortController()
    pending.current = abort
    void ready.client
      .policies(abort.signal)
      .then(catalog => {
        if (!abort.signal.aborted && isCurrent())
          setReady(previous => previous && { ...previous, catalog })
      })
      .catch(() => {
        if (!abort.signal.aborted && isCurrent()) setFailure('unavailable')
      })
  }
  useEffect(() => () => pending.current?.abort(), [])
  return (
    <section className="space-y-4" data-testid="native-model-policies">
      <header className="space-y-1">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <p className="text-sm text-text-secondary">{t('description')}</p>
      </header>
      {failure ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm text-text-secondary">
            {t(failure)}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setReady(undefined)
              setFailure(undefined)
              setRevision(value => value + 1)
            }}
          >
            {t('retry')}
          </Button>
        </div>
      ) : !ready ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('loading')}
        </p>
      ) : null}
      {ready && (
        <>
          <PolicyPreview
            key={JSON.stringify([
              ready.client.ownerKey,
              ready.catalog.policies.map(policy => policy.reference),
            ])}
            client={ready.client}
            catalog={ready.catalog}
            value={value}
            onSelect={onSelect}
          />
          {allowEdit && (
            <details open={!ready.settings?.policies.length}>
              <summary className="cursor-pointer py-2 text-sm font-medium">
                {t('configure')}
              </summary>
              {ready.settings ? (
                <PolicySettingsEditor
                  client={ready.client}
                  initial={ready.settings}
                  onSaved={refreshCatalog}
                />
              ) : (
                <p className="py-2 text-sm text-text-secondary">
                  {t(
                    ready.settingsError === 'unsupported'
                      ? 'unsupported'
                      : ready.settingsError === 'custom_file'
                        ? 'customFile'
                        : 'unavailable'
                  )}
                </p>
              )}
            </details>
          )}
        </>
      )}
    </section>
  )
}
