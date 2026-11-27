import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import { AgentChoiceController } from '../../../../shared/migrationAgents'
import type { MigrationAgentAdaptation } from '../../../../shared/generated/contracts'

export function MigrationAgentChoice({ deviceId, workspacePath, jobId, itemId, initial, isCurrent, onChange }: {
  deviceId: string; workspacePath?: string; jobId: string; itemId: string; initial?: MigrationAgentAdaptation | null
  isCurrent(): boolean; onChange(value: MigrationAgentAdaptation | null, ready: boolean): void
}) {
  const { t } = useTranslation('migrationAgents')
  const controller = useMemo(() => new AgentChoiceController(createMigrationApi(deviceId, workspacePath), { jobId, itemId }, isCurrent, initial), [deviceId, workspacePath, jobId, itemId, isCurrent, initial])
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  useEffect(() => { controller.activate(); return controller.dispose }, [controller])
  useEffect(() => { onChange(controller.value(), controller.ready()) }, [controller, state, onChange])
  return <section className="space-y-3" data-testid="migration-agent-choice">
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={state.enabled} onChange={event => controller.change({ enabled: event.target.checked })}/>{t('adapt')}</label>
    {state.enabled && <>
      <p className="text-xs leading-5 text-text-secondary">{t('boundary')}</p>
      <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void controller.read()} data-testid="migration-agent-inspect">{t('inspect')}</Button>
      {state.error && <p role="alert" className="text-sm text-destructive">{t(state.error)}</p>}
      {state.result && !state.result.compatibility.canAdapt && <p role="alert" className="text-sm text-text-secondary">{t('unsupported')}</p>}
      {state.result?.compatibility.canAdapt && <>
        <label className="block space-y-1 text-sm"><span>{t('modelPolicy')}</span><SettingsSelect aria-label={t('modelPolicy')} data-testid="migration-agent-model-kind" className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" value={state.kind} onChange={event => controller.change({ kind: event.target.value as typeof state.kind })}><option value="">{t('choose')}</option><option value="inherit">{t('inherit')}</option><option value="target">{t('target')}</option></SettingsSelect></label>
        {state.kind === 'target' && <div className="grid gap-3 md:grid-cols-2">{(['provider', 'model'] as const).map(key => <label key={key} className="block space-y-1 text-sm"><span>{t(key)}</span><input aria-label={t(key)} data-testid={`migration-agent-${key}`} className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" value={state[key]} maxLength={256} onChange={event => controller.change({ [key]: event.target.value })}/></label>)}</div>}
        <p className="text-xs leading-5 text-text-secondary">{t('modelBoundary')}</p>
        <fieldset className="space-y-1"><legend className="text-sm">{t('tools')}</legend>{state.result.compatibility.availableTools.map(tool => <label key={tool} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={state.tools.includes(tool)} onChange={event => controller.change({ tools: event.target.checked ? [...state.tools, tool] : state.tools.filter(value => value !== tool) })}/>{tool}</label>)}</fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input data-testid="migration-agent-confirm" type="checkbox" checked={state.confirmed} onChange={event => controller.confirm(event.target.checked)}/>{t('confirm')}</label>
      </>}
    </>}
  </section>
}
