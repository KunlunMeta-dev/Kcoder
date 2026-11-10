import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useState } from 'react'
import type { AutomationDestination } from '../../../../shared/generated/contracts'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { KnowledgeIntegrationClient } from './client'
import { OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'

function Destinations({
  client,
  connectionId,
  value,
  disabled,
  onSelection,
}: {
  client: KnowledgeIntegrationClient
  connectionId: string
  value?: AutomationDestination
  disabled?: boolean
  onSelection: (value: AutomationDestination | undefined) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(`${client.ownerKey}-${connectionId}`, (after, signal) =>
    client.listDeliveryDestinations(connectionId, after, signal)
  )
  return (
    <div className="space-y-3" aria-busy={page.pending}>
      <OperationError error={page.error} />
      {!page.pending && !page.error && !page.items.length && (
        <p className="text-sm text-text-muted">{t('noDeliveryDestinations')}</p>
      )}
      {page.items.map(destination => (
        <Button
          key={destination.id}
          type="button"
          variant="outline"
          disabled={disabled || page.pending || destination.purpose !== 'subscription'}
          aria-pressed={
            value?.kind === 'channel' &&
            value.destinationRef === destination.id &&
            value.destinationRevision === destination.revision
          }
          data-testid="automation-delivery-destination"
          onClick={() =>
            onSelection({
              kind: 'channel',
              destinationRef: destination.id,
              destinationRevision: destination.revision,
            })
          }
        >
          {t(`connectionPlatform${destination.platform}`)} · {destination.label}
        </Button>
      ))}
      <PageActions
        {...page}
        refresh={() => {
          onSelection(undefined)
          page.refresh()
        }}
      />
    </div>
  )
}
export function AutomationDeliveryPicker({
  client,
  value,
  disabled,
  onSelection,
}: {
  client: KnowledgeIntegrationClient
  value?: AutomationDestination
  disabled?: boolean
  onSelection: (value: AutomationDestination | undefined) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [external, setExternal] = useState(value?.kind === 'channel')
  const [connectionId, setConnectionId] = useState<string>()
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span>{t('deliveryDestination')}</span>
        <SettingsSelect
          className="w-full rounded-xl border border-border bg-background px-3 py-2"
          disabled={disabled}
          value={external ? 'channel' : 'studio'}
          data-testid="automation-delivery-mode"
          onChange={event => {
            const channel = event.target.value === 'channel'
            setExternal(channel)
            setConnectionId(undefined)
            onSelection(channel ? undefined : { kind: 'studio' })
          }}
        >
          <option value="studio">{t('studioInbox')}</option>
          <option value="channel">{t('authorizedChannelDelivery')}</option>
        </SettingsSelect>
      </label>
      {external && (
        <div className="studio-card-spacing space-y-3 rounded-xl border border-border">
          <p className="text-sm text-text-secondary">{t('channelDeliveryConsentHint')}</p>
          {connectionId ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                  setConnectionId(undefined)
                  onSelection(undefined)
                }}
              >
                {t('back')}
              </Button>
              <Destinations
                key={connectionId}
                client={client}
                connectionId={connectionId}
                value={value}
                disabled={disabled}
                onSelection={onSelection}
              />
            </>
          ) : (
            <Connections client={client} disabled={disabled} onSelection={setConnectionId} />
          )}
        </div>
      )}
    </div>
  )
}
function Connections({
  client,
  disabled,
  onSelection,
}: {
  client: KnowledgeIntegrationClient
  disabled?: boolean
  onSelection: (id: string) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(client.ownerKey, (after, signal) =>
    client.listDeliveryConnections(after, signal)
  )
  return (
    <div className="space-y-3" aria-busy={page.pending}>
      <OperationError error={page.error} />
      {!page.pending && !page.error && !page.items.length && (
        <p className="text-sm text-text-muted">{t('noDeliveryConnections')}</p>
      )}
      {page.items.map(connection => (
        <Button
          key={connection.id}
          type="button"
          variant="outline"
          disabled={disabled || page.pending || !connection.enabled}
          data-testid="automation-delivery-connection"
          onClick={() => onSelection(connection.id)}
        >
          {connection.label}
        </Button>
      ))}
      <PageActions {...page} />
    </div>
  )
}
