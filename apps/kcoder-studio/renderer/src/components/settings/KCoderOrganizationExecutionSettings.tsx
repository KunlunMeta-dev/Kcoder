import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import type { OrganizationResource } from './KCoderOrganizationResources'
import {
  cloneOrganizationExecutionPolicy,
  ORGANIZATION_BUDGET_LIMITS,
  organizationModelOrigin,
  validOrganizationExecutionPolicy,
  type OrganizationBudgetPolicy,
  type OrganizationExecutionPolicy,
  type OrganizationModelRule,
} from './organizationExecutionPolicy'

interface Props {
  organizationId: string
  revision: number
  policy: OrganizationExecutionPolicy | null | undefined
  accounts: { id: string; username: string }[]
  resources: OrganizationResource[]
  busy: boolean
  save: (operation: Record<string, unknown>) => Promise<void>
}
const controlClass =
  'mt-1 block h-10 w-full rounded-lg border border-border bg-background px-3 text-sm'

export function KCoderOrganizationExecutionSettings({
  organizationId,
  revision,
  policy,
  accounts,
  resources,
  busy,
  save,
}: Props) {
  const { t } = useTranslation('localRuntime')
  const text = (key: string) => t(`organization.execution.${key}`)
  const [draft, setDraft] = useState(() => cloneOrganizationExecutionPolicy(policy))
  const [baseRevision, setBaseRevision] = useState(revision)
  const [originalBudgetIds, setOriginalBudgetIds] = useState(
    () => policy?.budgetPolicies.map(row => row.id) ?? []
  )
  const stale = revision !== baseRevision
  const workspaces = resources.filter(resource => resource.kind === 'workspace')
  const valid = validOrganizationExecutionPolicy(
    draft,
    accounts.map(account => account.id),
    workspaces.map(resource => resource.id),
    organizationId
  )
  const model = (index: number, change: Partial<OrganizationModelRule>) =>
    setDraft(current => ({
      ...current,
      modelRules: current.modelRules.map((row, at) => (at === index ? { ...row, ...change } : row)),
    }))
  const budget = (index: number, change: Partial<OrganizationBudgetPolicy>) =>
    setDraft(current => ({
      ...current,
      budgetPolicies: current.budgetPolicies.map((row, at) =>
        at === index ? { ...row, ...change } : row
      ),
    }))
  const addModel = () =>
    setDraft(current => ({
      ...current,
      modelRules: [
        ...current.modelRules,
        {
          id: '',
          members: [],
          workspaceResourceIds: [],
          provider: '',
          model: '',
          endpointOrigin: '',
          configurationRevision: null,
          enabled: true,
        },
      ],
    }))
  const addBudget = () => {
    const now = Date.now()
    setDraft(current => ({
      ...current,
      budgetPolicies: [
        ...current.budgetPolicies,
        {
          id: '',
          scope: { kind: 'organization', id: organizationId },
          window: { id: '', startsAtMs: now, endsAtMs: now + 86_400_000 },
          limits: { tokens: 1_000_000 },
          currency: null,
        },
      ],
    }))
  }
  const options = (values: string[], selected: string, checked: boolean) =>
    checked ? [...values, selected] : values.filter(value => value !== selected)
  return (
    <details
      data-testid="organization-execution-settings"
      className="studio-card-spacing rounded-lg border border-border"
    >
      <summary className="cursor-pointer text-sm font-medium">{text('title')}</summary>
      <p className="mt-3 text-sm text-text-secondary">{text('boundary')}</p>
      {stale && (
        <div role="alert" className="mt-3 space-y-2 text-sm">
          <p>{text('changed')}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraft(cloneOrganizationExecutionPolicy(policy))
              setBaseRevision(revision)
              setOriginalBudgetIds(policy?.budgetPolicies.map(row => row.id) ?? [])
            }}
          >
            {text('reload')}
          </Button>
        </div>
      )}
      <fieldset disabled={busy || stale} className="mt-4 min-w-0 space-y-5">
        <legend className="text-sm font-medium">{text('models')}</legend>
        {draft.modelRules.map((row, index) => (
          <div
            key={index}
            className="space-y-3 border-t border-border pt-4"
            data-testid={`organization-model-rule-${index}`}
          >
            <div className="grid gap-3 md:grid-cols-2">
              {(['id', 'provider', 'model', 'endpointOrigin'] as const).map(field => (
                <label key={field} className="min-w-0 text-sm">
                  {text(field)}
                  <input
                    aria-label={`${text(field)} ${index + 1}`}
                    value={row[field]}
                    className={controlClass}
                    onChange={event => model(index, { [field]: event.target.value })}
                  />
                </label>
              ))}
              <label className="min-w-0 text-sm">
                {text('configurationRevision')}
                <input
                  aria-label={`${text('configurationRevision')} ${index + 1}`}
                  value={row.configurationRevision ?? ''}
                  className={controlClass}
                  onChange={event =>
                    model(index, { configurationRevision: event.target.value || null })
                  }
                />
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm">{text('members')}</legend>
                {accounts.map(account => (
                  <label key={account.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={row.members.includes(account.id)}
                      onChange={event =>
                        model(index, {
                          members: options(row.members, account.id, event.target.checked),
                        })
                      }
                    />
                    {account.username}
                  </label>
                ))}
              </fieldset>
              <fieldset className="min-w-0 space-y-2">
                <legend className="mb-2 text-sm">{text('workspaces')}</legend>
                {workspaces.map(resource => (
                  <label key={resource.id} className="flex min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      checked={row.workspaceResourceIds.includes(resource.id)}
                      onChange={event =>
                        model(index, {
                          workspaceResourceIds: options(
                            row.workspaceResourceIds,
                            resource.id,
                            event.target.checked
                          ),
                        })
                      }
                    />
                    <span className="break-all">{resource.id}</span>
                  </label>
                ))}
                {!workspaces.length && (
                  <p className="text-sm text-text-secondary">{text('registerWorkspace')}</p>
                )}
              </fieldset>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={row.enabled}
                  onChange={event => model(index, { enabled: event.target.checked })}
                />
                {text('enabled')}
              </label>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setDraft(current => ({
                    ...current,
                    modelRules: current.modelRules.filter((_, at) => at !== index),
                  }))
                }
              >
                {text('removeModel')}
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={draft.modelRules.length >= 128}
          onClick={addModel}
        >
          {text('addModel')}
        </Button>
        <p className="text-sm font-medium">{text('budgets')}</p>
        <p className="text-sm text-text-secondary">{text('budgetBoundary')}</p>
        {draft.budgetPolicies.map((row, index) => (
          <div
            key={index}
            className="space-y-3 border-t border-border pt-4"
            data-testid={`organization-budget-policy-${index}`}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm">
                {text('id')}
                <input
                  aria-label={`${text('budgetId')} ${index + 1}`}
                  value={row.id}
                  disabled={index < originalBudgetIds.length}
                  className={controlClass}
                  onChange={event => budget(index, { id: event.target.value })}
                />
              </label>
              <label className="text-sm">
                {text('scope')}
                <SettingsSelect
                  aria-label={`${text('scope')} ${index + 1}`}
                  value={row.scope.kind}
                  disabled={index < originalBudgetIds.length}
                  className={controlClass}
                  onChange={event =>
                    budget(index, {
                      scope: {
                        kind: event.target.value as OrganizationBudgetPolicy['scope']['kind'],
                        id: event.target.value === 'organization' ? organizationId : '',
                      },
                    })
                  }
                >
                  {(['organization', 'account', 'workspace', 'task'] as const).map(kind => (
                    <option key={kind} value={kind}>
                      {text(`scopes.${kind}`)}
                    </option>
                  ))}
                </SettingsSelect>
              </label>
              <label className="min-w-0 text-sm">
                {text('scopeReference')}
                <input
                  aria-label={`${text('scopeReference')} ${index + 1}`}
                  value={row.scope.id}
                  disabled={row.scope.kind === 'organization' || index < originalBudgetIds.length}
                  className={controlClass}
                  onChange={event =>
                    budget(index, { scope: { ...row.scope, id: event.target.value } })
                  }
                />
              </label>
              <label className="text-sm">
                {text('windowId')}
                <input
                  aria-label={`${text('windowId')} ${index + 1}`}
                  value={row.window.id}
                  className={controlClass}
                  onChange={event =>
                    budget(index, { window: { ...row.window, id: event.target.value } })
                  }
                />
              </label>
              {(['startsAtMs', 'endsAtMs'] as const).map(field => (
                <label key={field} className="text-sm">
                  {text(field)}
                  <input
                    type="datetime-local"
                    aria-label={`${text(field)} ${index + 1}`}
                    value={localDateTime(row.window[field])}
                    className={controlClass}
                    onChange={event =>
                      budget(index, {
                        window: {
                          ...row.window,
                          [field]: event.target.value
                            ? new Date(event.target.value).getTime()
                            : NaN,
                        },
                      })
                    }
                  />
                </label>
              ))}
              {ORGANIZATION_BUDGET_LIMITS.map(field => (
                <label key={field} className="text-sm">
                  {text(`limits.${field}`)}
                  <input
                    type="number"
                    min="0"
                    step="1"
                    aria-label={`${text(`limits.${field}`)} ${index + 1}`}
                    value={row.limits[field] ?? ''}
                    className={controlClass}
                    onChange={event => {
                      const limits = { ...row.limits }
                      if (event.target.value === '') delete limits[field]
                      else limits[field] = Number(event.target.value)
                      budget(index, { limits })
                    }}
                  />
                </label>
              ))}
              <label className="text-sm">
                {text('currency')}
                <input
                  aria-label={`${text('currency')} ${index + 1}`}
                  value={row.currency ?? ''}
                  disabled={index < originalBudgetIds.length}
                  maxLength={3}
                  className={controlClass}
                  onChange={event => budget(index, { currency: event.target.value || null })}
                />
              </label>
            </div>
            {index >= originalBudgetIds.length && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setDraft(current => ({
                    ...current,
                    budgetPolicies: current.budgetPolicies.filter((_, at) => at !== index),
                  }))
                }
              >
                {text('removeBudget')}
              </Button>
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={draft.budgetPolicies.length >= 128}
          onClick={addBudget}
        >
          {text('addBudget')}
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!valid || busy || stale}
            data-testid="organization-execution-save"
            onClick={() =>
              void save({
                operation: 'organization.executionPolicy',
                expectedRevision: baseRevision,
                executionPolicy: {
                  ...draft,
                  modelRules: draft.modelRules.map(row => ({
                    ...row,
                    endpointOrigin:
                      organizationModelOrigin(row.endpointOrigin) ?? row.endpointOrigin,
                  })),
                },
              })
            }
          >
            {text('save')}
          </Button>
          {!valid && (
            <p role="status" className="text-sm text-text-secondary">
              {text('invalid')}
            </p>
          )}
        </div>
      </fieldset>
    </details>
  )
}

function localDateTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return ''
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(milliseconds - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
