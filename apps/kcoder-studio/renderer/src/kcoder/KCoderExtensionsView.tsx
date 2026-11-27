import { useMemo, useState } from 'react'
import { AlertTriangle, Loader2, TerminalSquare } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { StatusChip } from '@/components/settings/settings-ui'
import {
  pluginNames,
  pluginPreferenceSource,
  pluginSkillSwitch,
  preferPluginCopy,
  preferenceCanSelect,
  restoreDefaultCopy,
  setPluginPreferred,
  type ExtensionConflict,
  type ExtensionInventoryItem,
  type ExtensionSkillPreference,
  type ExtensionSourceRef,
  type ExtensionsInventoryResult,
} from './extensionsInventory'
import type { ExtensionsInventoryState } from './useExtensionsInventory'
import { DetailList, Disclosure, HookIssueList } from './extensionsPresentation'
import { itemState, sourceLabel, upstreamRows } from './extensionsLabels'
import { EvolutionTargetSection } from './evolution/EvolutionTargetSection'
import { inventoryTargetKey } from './evolution/evolutionTargetModel'
import { useEvolutionSupport } from './evolution/useEvolutionSupport'
import { StableLabel, StableStatus } from '@/components/ui/stable-content'

/** Target scope for the per-skill evolution section; omitted where evolution is not shown. */
export interface ExtensionsEvolutionScope {
  deviceId?: string
  workspacePath?: string
  isScopeCurrent?: () => boolean
}

const KINDS = ['skill', 'mcp_server', 'hook', 'plugin', 'binary'] as const
type KindFilter = 'all' | (typeof KINDS)[number]

function matchesQuery(query: string, ...values: Array<string | null | undefined>) {
  const search = query.trim().toLocaleLowerCase()
  return !search || values.join(' ').toLocaleLowerCase().includes(search)
}

/** One action that rewrites the whole preference against the observed revision. */
interface PreferenceAction {
  key: string
  label: string
  next: ExtensionSkillPreference
}

function skillActions(
  t: (key: string, options?: Record<string, unknown>) => string,
  item: ExtensionInventoryItem,
  preference: ExtensionSkillPreference,
  plugins: Map<string, string>
): PreferenceAction[] {
  if (item.kind !== 'skill' || item.layer !== 'plugin' || !item.ownerPluginId) return []
  const pluginId = item.ownerPluginId
  if (
    !item.effective &&
    item.enabled &&
    item.shadowedBy &&
    preferenceCanSelect(item.shadowedBy.layer)
  )
    return [
      {
        key: 'use-plugin',
        label: t('actions.usePluginNamed', { plugin: plugins.get(pluginId) ?? pluginId }),
        next: preferPluginCopy(preference, item.name, pluginId),
      },
    ]
  if (!item.effective) return []
  const source = pluginPreferenceSource(preference, item.name, pluginId)
  if (source === 'name') {
    const next = restoreDefaultCopy(preference, item.name, pluginId)
    const builtin = (item.shadows ?? []).some(
      ref => ref.layer === 'builtin' || ref.layer === 'bundled'
    )
    return next
      ? [
          {
            key: 'use-default',
            label: t(builtin ? 'actions.useBuiltin' : 'actions.useDefault'),
            next,
          },
        ]
      : []
  }
  if (source === 'plugin')
    return [
      {
        key: 'stop-prefer',
        label: t('actions.stopPreferPlugin'),
        next: setPluginPreferred(preference, pluginId, false),
      },
    ]
  return []
}

function pluginActions(
  t: (key: string, options?: Record<string, unknown>) => string,
  pluginId: string,
  items: ExtensionInventoryItem[],
  preference: ExtensionSkillPreference
): PreferenceAction[] {
  const preferred = preference.preferPlugins?.includes(pluginId) === true
  const overlaps = items.some(
    item =>
      item.kind === 'skill' &&
      item.ownerPluginId === pluginId &&
      (item.preferred || item.shadowedBy || (item.shadows ?? []).length > 0)
  )
  if (!preferred && !overlaps) return []
  return [
    {
      key: preferred ? 'stop-prefer' : 'prefer',
      label: t(preferred ? 'actions.stopPreferPlugin' : 'actions.preferPlugin'),
      next: setPluginPreferred(preference, pluginId, !preferred),
    },
  ]
}

function PreferenceButtons({
  actions,
  state,
}: {
  actions: PreferenceAction[]
  state: ExtensionsInventoryState
}) {
  const { t } = useTranslation('extensions')
  if (actions.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map(action => (
        <Button
          key={action.key}
          type="button"
          variant="outline"
          size="sm"
          data-testid={`extensions-action-${action.key}`}
          disabled={state.saving}
          aria-busy={state.saving}
          onClick={() => void state.updatePreference(action.next)}
        >
          <StableLabel alternatives={[t('actions.saving'), action.label]}>{state.saving ? t('actions.saving') : action.label}</StableLabel>
        </Button>
      ))}
    </div>
  )
}

/**
 * Per-plugin skill switch (`pluginSkillPolicyV1`). Targets without it keep the
 * explanation that only the whole plugin can be turned off.
 */
function PluginSkillToggle({
  pluginId,
  result,
  plugins,
  state,
}: {
  pluginId: string
  result: ExtensionsInventoryResult
  plugins: Map<string, string>
  state: ExtensionsInventoryState
}) {
  const { t } = useTranslation('extensions')
  const control = pluginSkillSwitch(result, pluginId)
  if (!result.pluginSkillPolicy)
    return <p className="text-xs text-text-muted">{t('pluginSkillSwitchLimit')}</p>
  if (!control) return null
  const plugin = plugins.get(pluginId) ?? pluginId
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="extensions-plugin-skills"
      data-plugin-id={pluginId}
    >
      <label className="flex min-h-11 items-center gap-2 text-sm text-text-primary md:min-h-8">
        <Switch
          size="sm"
          checked={control.enabled}
          disabled={state.saving}
          aria-busy={state.saving}
          aria-label={t('pluginSkills.toggleNamed', { plugin })}
          data-testid="extensions-plugin-skills-switch"
          onCheckedChange={enabled => void state.setPluginSkillsEnabled(pluginId, enabled)}
        />
        {t('pluginSkills.toggle')}
      </label>
      <p className="basis-full text-xs text-text-muted">
        {t(control.enabled ? 'pluginSkills.help' : 'pluginSkills.helpOff')}
      </p>
    </div>
  )
}

function ItemRow({
  item,
  result,
  plugins,
  state,
  evolution,
}: {
  item: ExtensionInventoryItem
  result: ExtensionsInventoryResult
  plugins: Map<string, string>
  state: ExtensionsInventoryState
  evolution?: ExtensionsEvolutionScope
}) {
  const { t } = useTranslation('extensions')
  const status = itemState(item)
  const preference = result.skillPreference
  const actions =
    item.kind === 'plugin' && item.ownerPluginId
      ? pluginActions(t, item.ownerPluginId, result.items, preference)
      : skillActions(t, item, preference, plugins)
  const byPlugin =
    item.kind === 'skill' &&
    item.effective &&
    item.ownerPluginId &&
    pluginPreferenceSource(preference, item.name, item.ownerPluginId) === 'plugin'
  const shadows = item.shadows ?? []
  // Only a target-published key is used; items without one show no evolution section.
  const evolutionKey = inventoryTargetKey(item)
  return (
    <article
      data-testid="extensions-item"
      data-item-id={item.id}
      data-kind={item.kind}
      data-effective={item.effective ? 'true' : 'false'}
      className="studio-card-spacing flex flex-col gap-1 rounded-xl border border-border/60 bg-background"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all text-base font-medium">{item.name}</h3>
            <StatusChip>{t(`kind.${item.kind}`)}</StatusChip>
            <StatusChip data-testid="extensions-item-source">
              {sourceLabel(t, item, plugins)}
            </StatusChip>
            <StatusChip variant={status.variant} data-testid="extensions-item-state">
              {t(status.key)}
            </StatusChip>
            {item.version && <StatusChip>{item.version}</StatusChip>}
            {item.preferred && <StatusChip>{t('relation.preferred')}</StatusChip>}
          </div>
          {item.shadowedBy && (
            <p className="mt-1 text-sm text-text-secondary" data-testid="extensions-shadowed-by">
              {t('relation.shadowedBy', { source: sourceLabel(t, item.shadowedBy, plugins) })}
            </p>
          )}
          {shadows.length > 0 && (
            <p className="mt-1 text-sm text-text-secondary" data-testid="extensions-shadows">
              {t('relation.shadows', {
                sources: Array.from(new Set(shadows.map(ref => sourceLabel(t, ref, plugins)))).join(
                  ', '
                ),
              })}
            </p>
          )}
          {item.description && (
            <p className="mt-1 line-clamp-2 text-sm text-text-muted">{item.description}</p>
          )}
        </div>
        <PreferenceButtons actions={actions} state={state} />
      </div>
      <Disclosure summary={t('details')}>
        <DetailList
          rows={[
            [t('detail.path'), item.path],
            [t('detail.version'), item.version],
            [t('detail.marketplace'), item.marketplaceId],
            [t('detail.role'), item.detail],
            [t('detail.count'), item.count],
            [
              t('detail.bundled'),
              item.kind === 'binary' && item.bundled != null
                ? t(item.bundled ? 'detail.bundledYes' : 'detail.bundledNo')
                : null,
            ],
            ...upstreamRows(t, item.upstream),
            ...(item.shadowedBy
              ? ([[t('state.shadowed'), copyText(t, item.shadowedBy, plugins)]] as Array<
                  [string, string]
                >)
              : []),
            ...shadows.map(
              (ref, index) =>
                [`${t('detail.shadowedCopies')} ${index + 1}`, copyText(t, ref, plugins)] as [
                  string,
                  string,
                ]
            ),
          ]}
        />
        {byPlugin && (
          <p className="text-xs text-text-muted">
            {t('preferredByPlugin', {
              plugin: plugins.get(item.ownerPluginId!) ?? item.ownerPluginId,
            })}
          </p>
        )}
        {item.kind === 'skill' &&
          item.layer === 'plugin' &&
          item.shadowedBy &&
          !preferenceCanSelect(item.shadowedBy.layer) && (
            <p className="text-xs text-text-muted">{t('preferenceBlocked')}</p>
          )}
        {item.kind === 'skill' && item.effective && evolution?.deviceId && evolutionKey && (
          <EvolutionTargetSection
            deviceId={evolution.deviceId}
            workspacePath={evolution.workspacePath}
            isScopeCurrent={evolution.isScopeCurrent}
            targetKey={evolutionKey}
          />
        )}
        {item.kind === 'plugin' && item.ownerPluginId && (
          <PluginSkillToggle
            pluginId={item.ownerPluginId}
            result={result}
            plugins={plugins}
            state={state}
          />
        )}
      </Disclosure>
    </article>
  )
}

function copyText(
  t: (key: string, options?: Record<string, unknown>) => string,
  ref: ExtensionSourceRef,
  plugins: Map<string, string>
) {
  return `${sourceLabel(t, ref, plugins)} · ${ref.path ?? t('detail.unknownPath')}`
}

export function ExtensionsNoticeBar({ state }: { state: ExtensionsInventoryState }) {
  const { t } = useTranslation('extensions')
  if (!state.notice || state.notice.kind === 'saved') return null
  // Failures stay a persistent, dismissible alert; success uses `ExtensionsSavedStatus`.
  return (
    <div
      role="alert"
      data-testid="extensions-notice"
      data-kind={state.notice.kind}
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm text-text-secondary"
    >
      <span>{t(`notice.${state.notice.kind}`)}</span>
      <Button type="button" variant="ghost" size="sm" onClick={state.dismissNotice}>
        {t('dismiss')}
      </Button>
    </div>
  )
}

/**
 * The "applies to new conversations" line with a reserved slot for the saved result,
 * so a successful toggle or preference change does not insert a bar above the list.
 */
function AppliesLine({ state, testId }: { state: ExtensionsInventoryState; testId?: string }) {
  const { t } = useTranslation('extensions')
  const saved = state.notice?.kind === 'saved'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
      <p data-testid={testId}>{t('appliesToNewConversations')}</p>
      <StableStatus
        className="font-medium text-text-primary"
        itemClassName="whitespace-nowrap"
        reserve={[t('notice.saved')]}
      >
        {saved && (
          <span data-testid="extensions-notice" data-kind="saved">
            {t('notice.saved')}
          </span>
        )}
      </StableStatus>
    </div>
  )
}

function StatusLine({ state }: { state: ExtensionsInventoryState }) {
  const { t } = useTranslation('extensions')
  if (state.status === 'loading')
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('loading')}
      </p>
    )
  if (state.status === 'error' && state.error)
    return (
      <p role="alert" className="text-sm text-text-secondary">
        {t(`notice.${state.error}`)}
      </p>
    )
  return null
}

/** Shown in place of the All and Conflicts views for targets without the capability. */
export function ExtensionsUpgradeHint() {
  const { t } = useTranslation('extensions')
  return (
    <p data-testid="extensions-upgrade-hint" className="text-sm text-text-secondary">
      {t('unsupported')}
    </p>
  )
}

function BinaryCheck({ state }: { state: ExtensionsInventoryState }) {
  const { t } = useTranslation('extensions')
  const checked = state.result?.binariesIncluded === true
  // Drift findings stay next to the action that produced them.
  const findings = (state.result?.conflicts ?? []).filter(conflict => conflict.kind === 'binary')
  return (
    <section
      data-testid="extensions-binaries"
      className="studio-card-spacing flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-background"
    >
      <TerminalSquare className="size-5 shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-medium">{t('binaries.title')}</h3>
        <p className="text-sm text-text-secondary">
          {checked ? t('binaries.checked') : t('binaries.description')}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="extensions-check-binaries"
        disabled={state.checkingBinaries || state.status !== 'ready'}
        aria-busy={state.checkingBinaries}
        onClick={() => void state.checkBinaries()}
      >
        <StableLabel alternatives={[t('binaries.checking'), t('binaries.recheck'), t('binaries.check')]}>
          {state.checkingBinaries
            ? t('binaries.checking')
            : t(checked ? 'binaries.recheck' : 'binaries.check')}
        </StableLabel>
      </Button>
      {findings.length > 0 && (
        <ul className="flex basis-full flex-col gap-1" data-testid="extensions-binary-findings">
          {findings.map(conflict => (
            <li
              key={`${conflict.reason}:${conflict.name}`}
              className="flex items-start gap-2 text-sm text-text-secondary"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              {conflictSummary(t, conflict, new Map())}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function ExtensionsAllView({
  state,
  query,
  onShowConflicts,
  evolutionScope,
}: {
  state: ExtensionsInventoryState
  query: string
  onShowConflicts: () => void
  evolutionScope?: ExtensionsEvolutionScope
}) {
  const { t } = useTranslation('extensions')
  const evolutionSupported = useEvolutionSupport(
    evolutionScope?.deviceId,
    evolutionScope?.workspacePath
  )
  const [kind, setKind] = useState<KindFilter>('all')
  const [onlyOverrides, setOnlyOverrides] = useState(false)
  const result = state.result
  const plugins = useMemo(() => pluginNames(result?.items ?? []), [result])
  const items = useMemo(() => {
    const order = new Map<string, number>(KINDS.map((value, index) => [value, index]))
    return [...(result?.items ?? [])].sort(
      (left, right) =>
        (order.get(left.kind) ?? 9) - (order.get(right.kind) ?? 9) ||
        left.name.localeCompare(right.name) ||
        Number(right.effective) - Number(left.effective)
    )
  }, [result])
  const visible = items.filter(
    item =>
      (kind === 'all' || item.kind === kind) &&
      (!onlyOverrides || item.shadowedBy || (item.shadows ?? []).length > 0) &&
      matchesQuery(query, item.name, item.description, item.ownerPluginId, item.path)
  )
  const hookIssues = result?.hookIssues ?? []
  return (
    <div data-testid="extensions-all" className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">{t('intro')}</p>
      <AppliesLine state={state} testId="extensions-applies" />
      <ExtensionsNoticeBar state={state} />
      <StatusLine state={state} />
      {result && (
        <>
          {hookIssues.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
              {t('hookIssues.summary', { count: hookIssues.length })}
              <Button type="button" variant="ghost" size="sm" onClick={onShowConflicts}>
                {t('hookIssues.view')}
              </Button>
            </div>
          )}
          <BinaryCheck state={state} />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary">{t('kindFilter.label')}</span>
              <SettingsSelect
                density="compact"
                data-testid="extensions-kind-filter"
                aria-label={t('kindFilter.label')}
                value={kind}
                onChange={event => setKind(event.target.value as KindFilter)}
              >
                <option value="all">{t('kindFilter.all')}</option>
                {KINDS.map(value => (
                  <option key={value} value={value}>
                    {t(`kind.${value}`)}
                  </option>
                ))}
              </SettingsSelect>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
              <Checkbox
                data-testid="extensions-only-overrides"
                checked={onlyOverrides}
                onChange={event => setOnlyOverrides(event.currentTarget.checked)}
              />
              {t('onlyOverrides')}
            </label>
          </div>
          {items.length === 0 && <p className="text-sm text-text-muted">{t('empty')}</p>}
          {items.length > 0 && visible.length === 0 && (
            <p role="status" className="text-sm text-text-muted">
              {t('noMatches')}
            </p>
          )}
          {visible.map(item => (
            <ItemRow
              key={item.id}
              item={item}
              result={result}
              plugins={plugins}
              state={state}
              evolution={evolutionSupported ? evolutionScope : undefined}
            />
          ))}
        </>
      )}
    </div>
  )
}

function conflictSummary(
  t: (key: string, options?: Record<string, unknown>) => string,
  conflict: ExtensionConflict,
  plugins: Map<string, string>
): string {
  const effective = conflict.effective
    ? conflict.kind === 'binary'
      ? (conflict.effective.path ?? sourceLabel(t, conflict.effective, plugins))
      : sourceLabel(t, conflict.effective, plugins)
    : t('conflicts.unknownSource')
  const shadowed = conflict.shadowed ?? []
  switch (conflict.reason) {
    case 'same_name':
      return t('conflicts.summary.same_name', {
        name: conflict.name,
        effective,
        count: shadowed.length,
      })
    case 'mixed_family':
      return t('conflicts.summary.mixed_family', {
        name: conflict.name,
        plugin: conflict.pluginId ? (plugins.get(conflict.pluginId) ?? conflict.pluginId) : '',
        provided: (conflict.provided ?? []).length,
        fromPlugin: (conflict.effectiveFromPlugin ?? []).length,
        missing: (conflict.missing ?? []).length,
      })
    case 'multiple_binaries':
      return t('conflicts.summary.multiple_binaries', {
        name: conflict.name,
        effective,
        count: shadowed.length,
      })
    default:
      return t('conflicts.summary.version_mismatch', {
        name: conflict.name,
        resolved: (conflict.provided ?? [])[0] ?? '',
        bundled: (conflict.missing ?? [])[0] ?? '',
      })
  }
}

function conflictActions(
  t: (key: string, options?: Record<string, unknown>) => string,
  conflict: ExtensionConflict,
  result: ExtensionsInventoryResult,
  plugins: Map<string, string>
): PreferenceAction[] {
  const preference = result.skillPreference
  if (conflict.kind !== 'skill') return []
  if (conflict.reason === 'mixed_family' && conflict.pluginId)
    return pluginActions(t, conflict.pluginId, result.items, preference)
  if (conflict.reason !== 'same_name') return []
  const copies = result.items.filter(
    item => item.kind === 'skill' && item.name === conflict.name && item.layer === 'plugin'
  )
  return copies.flatMap(item => skillActions(t, item, preference, plugins))
}

/** Plugins owning a copy in this conflict, effective copy first. */
function conflictPluginIds(conflict: ExtensionConflict): string[] {
  const owners = [
    conflict.pluginId,
    conflict.effective?.ownerPluginId,
    ...(conflict.shadowed ?? []).map(ref => ref.ownerPluginId),
  ]
  return Array.from(new Set(owners.filter((id): id is string => Boolean(id))))
}

function upstreamOf(result: ExtensionsInventoryResult, name: string, ref: ExtensionSourceRef) {
  return result.items.find(
    item =>
      item.name === name &&
      item.layer === ref.layer &&
      (item.ownerPluginId ?? null) === (ref.ownerPluginId ?? null) &&
      (ref.path == null || item.path === ref.path)
  )?.upstream
}

function ConflictRow({
  conflict,
  result,
  plugins,
  state,
}: {
  conflict: ExtensionConflict
  result: ExtensionsInventoryResult
  plugins: Map<string, string>
  state: ExtensionsInventoryState
}) {
  const { t } = useTranslation('extensions')
  const copies = [
    ...(conflict.effective ? [{ ref: conflict.effective, effective: true }] : []),
    ...(conflict.shadowed ?? []).map(ref => ({ ref, effective: false })),
  ]
  const list = (values?: string[]) => (values && values.length > 0 ? values.join(', ') : null)
  return (
    <article
      data-testid="extensions-conflict"
      data-reason={conflict.reason}
      data-name={conflict.name}
      className="studio-card-spacing flex flex-col gap-1 rounded-xl border border-border/60 bg-background"
    >
      <div className="flex flex-wrap items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all text-base font-medium">{conflict.name}</h3>
            <StatusChip>{t(`kind.${conflict.kind}`)}</StatusChip>
            <StatusChip>{t(`conflicts.reason.${conflict.reason}`)}</StatusChip>
            {conflict.sameUpstream && (
              <StatusChip data-testid="extensions-same-upstream">
                {t('detail.sameUpstream')}
              </StatusChip>
            )}
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            {conflictSummary(t, conflict, plugins)}
          </p>
        </div>
        <PreferenceButtons actions={conflictActions(t, conflict, result, plugins)} state={state} />
      </div>
      <Disclosure summary={t('details')} testId="extensions-conflict-details">
        {copies.map(({ ref, effective }, index) => (
          <div key={`${ref.layer}:${ref.ownerPluginId}:${ref.path}:${index}`} className="space-y-1">
            <DetailList
              rows={[
                [
                  effective ? t('detail.effectiveCopy') : t('detail.shadowedCopies'),
                  copyText(t, ref, plugins),
                ],
                ...upstreamRows(t, upstreamOf(result, conflict.name, ref)),
              ]}
            />
          </div>
        ))}
        <DetailList
          rows={
            conflict.reason === 'version_mismatch'
              ? [
                  [t('detail.resolvedVersion'), list(conflict.provided)],
                  [t('detail.bundledVersion'), list(conflict.missing)],
                ]
              : [
                  [t('detail.provided'), list(conflict.provided)],
                  [t('detail.missing'), list(conflict.missing)],
                  [t('detail.fromPlugin'), list(conflict.effectiveFromPlugin)],
                  [
                    t('detail.sameUpstream'),
                    conflict.kind === 'skill'
                      ? t(
                          conflict.sameUpstream ? 'detail.sameUpstream' : 'detail.differentUpstream'
                        )
                      : null,
                  ],
                ]
          }
        />
        {conflict.kind === 'skill' &&
          (result.pluginSkillPolicy ? (
            conflictPluginIds(conflict).map(pluginId => (
              <PluginSkillToggle
                key={pluginId}
                pluginId={pluginId}
                result={result}
                plugins={plugins}
                state={state}
              />
            ))
          ) : (
            <p className="text-xs text-text-muted">{t('pluginSkillSwitchLimit')}</p>
          ))}
      </Disclosure>
    </article>
  )
}

export function ExtensionsConflictsView({
  state,
  query,
}: {
  state: ExtensionsInventoryState
  query: string
}) {
  const { t } = useTranslation('extensions')
  const result = state.result
  const plugins = useMemo(() => pluginNames(result?.items ?? []), [result])
  const conflicts = (result?.conflicts ?? []).filter(conflict =>
    matchesQuery(query, conflict.name, conflict.pluginId)
  )
  const hookIssues = (result?.hookIssues ?? []).filter(issue =>
    matchesQuery(query, issue.path, issue.event, issue.message, issue.location)
  )
  return (
    <div data-testid="extensions-conflicts" className="flex flex-col gap-3">
      <AppliesLine state={state} />
      <ExtensionsNoticeBar state={state} />
      <StatusLine state={state} />
      {result && (
        <>
          {conflicts.length === 0 && hookIssues.length === 0 && (
            <p role="status" className="text-sm text-text-muted">
              {t('conflicts.none')}
            </p>
          )}
          <HookIssueList issues={hookIssues} />
          {conflicts.map((conflict, index) => (
            <ConflictRow
              key={`${conflict.kind}:${conflict.reason}:${conflict.name}:${index}`}
              conflict={conflict}
              result={result}
              plugins={plugins}
              state={state}
            />
          ))}
        </>
      )}
    </div>
  )
}

/** Override badges for one effective skill row of the Skills tab. */
export function SkillOverrideBadges({
  result,
  name,
}: {
  result: ExtensionsInventoryResult | null
  name: string
}) {
  const { t } = useTranslation('extensions')
  const plugins = useMemo(() => pluginNames(result?.items ?? []), [result])
  const effective = result?.items.find(
    item => item.kind === 'skill' && item.name === name && item.effective
  )
  if (!effective) return null
  const sources = Array.from(
    new Set((effective.shadows ?? []).map(ref => sourceLabel(t, ref, plugins)))
  )
  if (sources.length === 0 && !effective.preferred) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="kcoder-skill-override-badges">
      {effective.preferred && <StatusChip>{t('skillBadge.preferred')}</StatusChip>}
      {sources.map(source => (
        <StatusChip key={source}>{t('skillBadge.shadowsCopy', { source })}</StatusChip>
      ))}
    </div>
  )
}
