import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { manageGatewayAccounts } from '@/kcoder/gatewayRpc'
import type { OrganizationBudgetPolicy } from './organizationExecutionPolicy'

interface Observation {
  charged: { tokens: number; modelCalls: number; runMillis: number; costMicros: number | null }
  unknownCostReservations: number
  activeTasks: number
  activeCalls: number
}
interface BudgetPage {
  version: 1
  organizationId: string
  policyRevision: number
  status: 'ready' | 'preparing' | 'uninitialized' | 'not_configured'
  nextAfter: number | null
  items: {
    configured: OrganizationBudgetPolicy
    observation: Observation | null
    current: boolean
  }[]
}

export function KCoderOrganizationBudgetStatus({
  serverId,
  organizationId,
  revision,
  canInitialize,
}: {
  serverId: string
  organizationId: string
  revision: number
  canInitialize: boolean
}) {
  const { t, i18n } = useTranslation('localRuntime')
  const text = (key: string) => t(`organization.budgetService.${key}`)
  const [page, setPage] = useState<BudgetPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [offsets, setOffsets] = useState<(number | null)[]>([null])
  const live = useRef(false)
  const sequence = useRef(0)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const read = async (nextOffsets: (number | null)[], initialize = false) => {
    const currentAccount = captureAccountContextRevision()
    const request = ++sequence.current
    setBusy(true)
    setError(false)
    const current = () => live.current && request === sequence.current && currentAccount(serverId)
    try {
      if (initialize) {
        await manageGatewayAccounts(serverId, { operation: 'organization.budget.initialize' })
        if (!current()) return
      }
      const result = await manageGatewayAccounts<BudgetPage>(serverId, {
        operation: 'organization.budget.inspect',
        expectedRevision: revision,
        after: nextOffsets.at(-1) ?? null,
      })
      if (!current()) return
      if (
        result.version !== 1 ||
        result.organizationId !== organizationId ||
        result.policyRevision !== revision ||
        !['ready', 'preparing', 'uninitialized', 'not_configured'].includes(result.status) ||
        !Array.isArray(result.items) ||
        result.items.length > 10 ||
        result.items.some(
          row =>
            !row ||
            !row.configured ||
            typeof row.configured.id !== 'string' ||
            !row.configured.scope ||
            typeof row.configured.scope.id !== 'string' ||
            (row.configured.currency !== null && typeof row.configured.currency !== 'string') ||
            typeof row.current !== 'boolean' ||
            (row.observation !== null &&
              (!row.observation ||
                !row.observation.charged ||
                typeof row.observation.charged !== 'object'))
        ) ||
        (result.nextAfter !== null &&
          (!Number.isSafeInteger(result.nextAfter) ||
            result.nextAfter < 1 ||
            result.nextAfter > 128))
      )
        throw new Error('Invalid organization budget observation')
      setPage(result)
      setOffsets(nextOffsets)
    } catch {
      if (current()) {
        setPage(null)
        setError(true)
      }
    } finally {
      if (current()) setBusy(false)
    }
  }
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value.toLocaleString()
      : text('unknown')
  const money = (value: number | null, currency: string | null) => {
    if (
      value === null ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      !currency ||
      !/^[A-Z]{3}$/.test(currency)
    )
      return text('unknown')
    return new Intl.NumberFormat(i18n?.language, {
      style: 'currency',
      currency,
      maximumFractionDigits: 6,
    }).format(value / 1_000_000)
  }
  const seconds = (value: number) =>
    Number.isSafeInteger(value) && value >= 0
      ? (value / 1_000).toLocaleString(i18n?.language, { maximumFractionDigits: 3 })
      : text('unknown')

  return (
    <details
      className="studio-card-spacing rounded-lg border border-border"
      data-testid="organization-budget-status"
    >
      <summary className="cursor-pointer text-sm font-medium">{text('title')}</summary>
      <p className="mt-3 text-sm text-text-secondary">{text('boundary')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void read([null])}>
          {text('refresh')}
        </Button>
        {canInitialize && page?.status === 'uninitialized' && (
          <Button disabled={busy} onClick={() => void read([null], true)}>
            {text('initialize')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-text-secondary">
          {text('unconfirmed')}
        </p>
      )}
      {page && (
        <div className="mt-3 space-y-4">
          <p role="status" className="text-sm">
            {text(page.status)}
          </p>
          {page.items.map(row => (
            <div key={row.configured.id} className="space-y-2 border-t border-border pt-3 text-sm">
              <p className="break-all font-medium">{row.configured.id}</p>
              <p className="break-all text-text-secondary">{row.configured.scope.id}</p>
              {!row.current && <p className="text-text-secondary">{text('notCurrent')}</p>}
              {row.observation ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <dt>{text('tokens')}</dt>
                  <dd>{number(row.observation.charged.tokens)}</dd>
                  <dt>{text('modelCalls')}</dt>
                  <dd>{number(row.observation.charged.modelCalls)}</dd>
                  <dt>{text('runMillis')}</dt>
                  <dd>{seconds(row.observation.charged.runMillis)}</dd>
                  <dt>{text('costMicros')}</dt>
                  <dd>{money(row.observation.charged.costMicros, row.configured.currency)}</dd>
                  <dt>{text('unknownCostReservations')}</dt>
                  <dd>{number(row.observation.unknownCostReservations)}</dd>
                  <dt>{text('activeTasks')}</dt>
                  <dd>{number(row.observation.activeTasks)}</dd>
                  <dt>{text('activeCalls')}</dt>
                  <dd>{number(row.observation.activeCalls)}</dd>
                </dl>
              ) : (
                <p className="text-text-secondary">{text('notObserved')}</p>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || offsets.length < 2}
              onClick={() => void read(offsets.slice(0, -1))}
            >
              {text('previous')}
            </Button>
            <Button
              variant="outline"
              disabled={busy || page.nextAfter === null}
              onClick={() => void read([...offsets, page.nextAfter])}
            >
              {text('next')}
            </Button>
          </div>
        </div>
      )}
    </details>
  )
}
