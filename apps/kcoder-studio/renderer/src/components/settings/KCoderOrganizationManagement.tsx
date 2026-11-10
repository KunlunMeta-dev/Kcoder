import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { downloadLink } from '@/kcoder/downloadLink'
import { KCoderOrganizationExecutionSettings } from './KCoderOrganizationExecutionSettings'
import { KCoderOrganizationBudgetStatus } from './KCoderOrganizationBudgetStatus'
import type { OrganizationExecutionPolicy } from './organizationExecutionPolicy'
import { manageGatewayAccounts } from '@/kcoder/gatewayRpc'
import {
  captureAccountContextRevision,
  listenAccountContextChanges,
} from '@/kcoder/accountContextEvents'
import {
  KCoderOrganizationResources,
  type OrganizationResource,
} from './KCoderOrganizationResources'

const roles = [
  'member',
  'projectMaintainer',
  'knowledgePublisher',
  'applicationAdmin',
  'auditor',
] as const
type Role = (typeof roles)[number]
interface Account {
  id: string
  username: string
}
interface Member {
  principalId: string
  roles: Role[]
  disabled: boolean
  directoryMapped: boolean
}
interface OrganizationView {
  organizationId: string
  revision: number
  currentPrincipalId?: string | null
  members: Member[]
  resources: OrganizationResource[]
  auditExportResources: string[]
  executionPolicy?: OrganizationExecutionPolicy | null
  executionServices?: { budgetInspectionV1?: boolean; budgetInitializationV1?: boolean }
}

export function KCoderOrganizationManagement({
  serverId,
  accounts,
  auditOnly = false,
}: {
  serverId: string
  accounts: Account[]
  auditOnly?: boolean
}) {
  return (
    <OrganizationManagementForTarget
      key={`${serverId}:${auditOnly}`}
      serverId={serverId}
      accounts={accounts}
      auditOnly={auditOnly}
    />
  )
}

function OrganizationManagementForTarget({
  serverId,
  accounts,
  auditOnly,
}: {
  serverId: string
  accounts: Account[]
  auditOnly: boolean
}) {
  const { t } = useTranslation('localRuntime')
  const target = useRef(serverId)
  const [view, setView] = useState<OrganizationView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [principalId, setPrincipalId] = useState('')
  const [role, setRole] = useState<Role>('member')
  useEffect(() => {
    target.current = serverId
    const stop = listenAccountContextChanges(id => {
      if (id !== serverId) return
      setView(null)
      setError('')
      setBusy(false)
      setPrincipalId('')
    })
    return () => {
      target.current = ''
      stop()
    }
  }, [serverId])

  const run = async (operation?: Record<string, unknown>) => {
    const owner = serverId
    const currentAccount = captureAccountContextRevision()
    setBusy(true)
    setError('')
    try {
      if (operation) await manageGatewayAccounts(owner, operation)
      if (target.current !== owner || !currentAccount(owner)) return
      const next = await manageGatewayAccounts<OrganizationView>(owner, {
        operation: auditOnly ? 'organization.self' : 'organization.inspect',
      })
      if (target.current === owner && currentAccount(owner)) setView(next)
    } catch {
      if (target.current === owner && currentAccount(owner)) setError(t('organization.failed'))
    } finally {
      if (target.current === owner && currentAccount(owner)) setBusy(false)
    }
  }
  const exportAudit = async (resourceId: string) => {
    const owner = serverId
    const currentAccount = captureAccountContextRevision()
    setBusy(true)
    setError('')
    try {
      const bundle = await manageGatewayAccounts(owner, {
        operation: 'organization.export',
        resourceId,
      })
      if (target.current !== owner || !currentAccount(owner)) return
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = 'kcoder-organization-audit.json'
      downloadLink(link)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      if (target.current === owner && currentAccount(owner))
        setError(t('organization.exportDenied'))
    } finally {
      if (target.current === owner && currentAccount(owner)) setBusy(false)
    }
  }
  return (
    <div className="space-y-3" data-testid="kcoder-organization-management">
      <Button variant="ghost" disabled={busy} onClick={() => void run()}>
        {t(auditOnly ? 'organization.audit' : 'organization.manage')}
      </Button>
      {view && (
        <div className="space-y-3 border-t border-border pt-3">
          <p className="text-sm">
            {view.organizationId} · {t('organization.policyRevision', { revision: view.revision })}
          </p>
          <p className="text-xs text-text-secondary">{t('organization.privateBoundary')}</p>
          {!auditOnly && (
            <>
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={event => {
                  event.preventDefault()
                  if (principalId)
                    void run({
                      operation: 'organization.member',
                      principalId,
                      roles: [role],
                      disabled: false,
                      expectedRevision: view.revision,
                    })
                }}
              >
                <label className="text-sm">
                  {t('organization.member')}
                  <SettingsSelect
                    required
                    aria-label={t('organization.member')}
                    value={principalId}
                    onChange={event => setPrincipalId(event.target.value)}
                    className="mt-1 block h-9 max-w-full rounded border border-border bg-background px-2 max-md:h-11"
                  >
                    <option value="">{t('organization.selectMember')}</option>
                    {accounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {account.username}
                      </option>
                    ))}
                  </SettingsSelect>
                </label>
                <label className="text-sm">
                  {t('organization.role')}
                  <SettingsSelect
                    aria-label={t('organization.role')}
                    value={role}
                    onChange={event => setRole(event.target.value as Role)}
                    className="mt-1 block h-9 rounded border border-border bg-background px-2 max-md:h-11"
                  >
                    {roles.map(value => (
                      <option key={value} value={value}>
                        {t(`organization.roles.${value}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                </label>
                <Button type="submit" disabled={busy || !principalId}>
                  {t('organization.saveMember')}
                </Button>
              </form>
              {view.members.map(member => (
                <div
                  key={member.principalId}
                  className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                >
                  <span className="min-w-0 break-all">
                    {accounts.find(account => account.id === member.principalId)?.username ??
                      member.principalId}
                  </span>
                  <span className="text-text-secondary">
                    {member.roles.map(value => t(`organization.roles.${value}`)).join(' · ')}
                  </span>
                  {member.directoryMapped && (
                    <span className="text-xs text-text-secondary">
                      {t('organization.directoryMapped')}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run({
                        operation: 'organization.member',
                        principalId: member.principalId,
                        roles: member.roles,
                        disabled: !member.disabled,
                        expectedRevision: view.revision,
                      })
                    }
                  >
                    {t(member.disabled ? 'accounts.enable' : 'accounts.disable')}
                  </Button>
                </div>
              ))}
              <details>
                <summary className="cursor-pointer text-sm">{t('organization.resources')}</summary>
                <div className="mt-2 space-y-2">
                  {view.resources.map(resource => (
                    <div key={resource.id} className="break-all text-sm">
                      {resource.id} · {resource.kind} ·{' '}
                      {t(`organization.visibility.${resource.visibility}`)}
                    </div>
                  ))}
                </div>
                <KCoderOrganizationResources
                  resources={view.resources}
                  accounts={accounts}
                  currentPrincipalId={view.currentPrincipalId}
                  revision={view.revision}
                  busy={busy}
                  save={run}
                />
              </details>
              {view.executionServices?.budgetInspectionV1 && (
                <KCoderOrganizationBudgetStatus
                  key={`${serverId}:${view.revision}`}
                  serverId={serverId}
                  organizationId={view.organizationId}
                  revision={view.revision}
                  canInitialize={view.executionServices.budgetInitializationV1 === true}
                />
              )}
              {view.executionPolicy !== undefined ? (
                <KCoderOrganizationExecutionSettings
                  key={serverId}
                  organizationId={view.organizationId}
                  revision={view.revision}
                  policy={view.executionPolicy}
                  accounts={accounts}
                  resources={view.resources}
                  busy={busy}
                  save={run}
                />
              ) : (
                <p className="text-sm text-text-secondary">
                  {t('organization.execution.unavailable')}
                </p>
              )}
            </>
          )}
          <p className="text-xs text-text-secondary">{t('organization.historyBoundary')}</p>
          {view.auditExportResources.map(resourceId => (
            <Button
              key={resourceId}
              variant="outline"
              disabled={busy}
              onClick={() => void exportAudit(resourceId)}
            >
              {t('organization.exportAudit')}
            </Button>
          ))}
          {!view.auditExportResources.length && (
            <p className="text-xs text-text-secondary">{t('organization.exportDenied')}</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
