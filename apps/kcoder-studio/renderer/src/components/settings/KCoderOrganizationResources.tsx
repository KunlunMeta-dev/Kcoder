import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeSourceReference, type NativeKnowledgeSource } from './organizationKnowledgeSource'

const kinds = [
  'model',
  'workspace',
  'connection',
  'knowledge',
  'artifact',
  'desktop',
  'automation',
  'audit',
] as const
const actions = ['read', 'use', 'write', 'publish', 'export', 'deliver', 'execute'] as const
const roles = [
  'member',
  'projectMaintainer',
  'knowledgePublisher',
  'applicationAdmin',
  'auditor',
] as const
export interface OrganizationResource {
  id: string
  kind: (typeof kinds)[number]
  owner: string
  visibility: 'private' | 'organization'
  grants: { subject: string; actions: string[] }[]
  auditScope?: 'organization' | { resourceIds: string[] }
  nativeKnowledgeSource?: NativeKnowledgeSource
}
interface Props {
  resources: OrganizationResource[]
  accounts: { id: string; username: string }[]
  currentPrincipalId?: string | null
  revision: number
  busy: boolean
  save: (operation: Record<string, unknown>) => Promise<void>
}

export function KCoderOrganizationResources({
  resources,
  accounts,
  currentPrincipalId,
  revision,
  busy,
  save,
}: Props) {
  const { t } = useTranslation('localRuntime')
  const [selected, setSelected] = useState('')
  const [editingRevision, setEditingRevision] = useState(revision)
  const [id, setId] = useState('')
  const [kind, setKind] = useState<OrganizationResource['kind']>('knowledge')
  const [owner, setOwner] = useState('')
  const [visibility, setVisibility] = useState<OrganizationResource['visibility']>('private')
  const [grants, setGrants] = useState<OrganizationResource['grants']>([])
  const [subject, setSubject] = useState('')
  const [scope, setScope] = useState<'resources' | 'organization'>('resources')
  const [scopeIds, setScopeIds] = useState<string[]>([])
  const [sourceEnabled, setSourceEnabled] = useState(false)
  const [publisher, setPublisher] = useState('')
  const [sourceReference, setSourceReference] = useState('')
  const existing = resources.find(resource => resource.id === selected)
  const parsedSource = knowledgeSourceReference(sourceReference)
  const privateLocked = Boolean(
    existing?.visibility === 'private' && existing.owner !== currentPrincipalId
  )
  const choose = (value: string) => {
    setEditingRevision(revision)
    setSelected(value)
    const resource = resources.find(item => item.id === value)
    setId(resource?.id ?? '')
    setKind(resource?.kind ?? 'knowledge')
    setOwner(resource?.owner ?? currentPrincipalId ?? '')
    setVisibility(resource?.visibility ?? 'private')
    setGrants(resource?.grants?.map(grant => ({ ...grant, actions: [...grant.actions] })) ?? [])
    setScope(resource?.auditScope === 'organization' ? 'organization' : 'resources')
    setScopeIds(
      typeof resource?.auditScope === 'object' ? [...resource.auditScope.resourceIds] : []
    )
    setSubject('')
    setSourceEnabled(Boolean(resource?.nativeKnowledgeSource))
    setPublisher(resource?.nativeKnowledgeSource?.publisherPrincipalId ?? '')
    setSourceReference(
      resource?.nativeKnowledgeSource
        ? JSON.stringify(
            {
              owner: resource.nativeKnowledgeSource.publicationOwner,
              publicationId: resource.nativeKnowledgeSource.publicationId,
            },
            null,
            2
          )
        : ''
    )
  }
  const valid = Boolean(
    editingRevision === revision &&
    id.trim() &&
    owner &&
    !privateLocked &&
    (visibility !== 'private' || owner === currentPrincipalId) &&
    (kind !== 'audit' || scope === 'organization' || scopeIds.length > 0) &&
    grants.every(grant => grant.actions.length > 0) &&
    (kind !== 'knowledge' ||
      !sourceEnabled ||
      (kind === 'knowledge' &&
        accounts.some(account => account.id === publisher) &&
        parsedSource !== null))
  )
  const toggleAction = (index: number, action: string) =>
    setGrants(values =>
      values.map((grant, current) =>
        current === index
          ? {
              ...grant,
              actions: grant.actions.includes(action)
                ? grant.actions.filter(value => value !== action)
                : [...grant.actions, action],
            }
          : grant
      )
    )
  return (
    <div
      className="mt-3 space-y-3 border-t border-border pt-3"
      data-testid="organization-resource-editor"
    >
      <p className="text-xs text-text-secondary">{t('organization.resourceEditor.help')}</p>
      {editingRevision !== revision && (
        <div role="status" className="space-y-2 text-sm text-text-secondary">
          <p>{t('organization.resourceEditor.changed')}</p>
          <Button type="button" variant="outline" disabled={busy} onClick={() => choose(selected)}>
            {t('organization.resourceEditor.reload')}
          </Button>
        </div>
      )}
      <label className="block text-sm">
        {t('organization.resourceEditor.select')}
        <SettingsSelect
          aria-label={t('organization.resourceEditor.select')}
          value={selected}
          disabled={busy}
          onChange={event => choose(event.target.value)}
          className="mt-1 h-9 max-w-full rounded border border-border bg-background px-2 max-md:h-11"
        >
          <option value="">{t('organization.resourceEditor.new')}</option>
          {resources.map(resource => (
            <option key={resource.id} value={resource.id}>
              {resource.id}
            </option>
          ))}
        </SettingsSelect>
      </label>
      {privateLocked && (
        <p role="status" className="text-sm text-text-secondary">
          {t('organization.resourceEditor.privateLocked')}
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault()
          if (!valid) return
          void save({
            operation: 'organization.resource',
            expectedRevision: editingRevision,
            resource: {
              id: id.trim(),
              kind,
              owner,
              visibility,
              grants: visibility === 'private' ? [] : grants,
              ...(kind === 'knowledge' && sourceEnabled && parsedSource
                ? {
                    nativeKnowledgeSource: {
                      version: 1,
                      publisherPrincipalId: publisher,
                      ...parsedSource,
                    },
                  }
                : {}),
              ...(kind === 'audit'
                ? {
                    auditScope:
                      scope === 'organization' ? 'organization' : { resourceIds: scopeIds },
                  }
                : {}),
            },
          })
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="min-w-0 text-sm">
            {t('organization.resourceEditor.id')}
            <input
              aria-label={t('organization.resourceEditor.id')}
              value={id}
              required
              maxLength={256}
              disabled={busy || Boolean(existing)}
              onChange={event => setId(event.target.value)}
              className="mt-1 block h-9 w-full rounded border border-border bg-background px-2 max-md:h-11"
            />
          </label>
          <label className="text-sm">
            {t('organization.resourceEditor.kind')}
            <SettingsSelect
              aria-label={t('organization.resourceEditor.kind')}
              value={kind}
              disabled={busy || Boolean(existing)}
              onChange={event => setKind(event.target.value as OrganizationResource['kind'])}
              className="mt-1 block h-9 rounded border border-border bg-background px-2 max-md:h-11"
            >
              {kinds.map(value => (
                <option key={value} value={value}>
                  {t(`organization.resourceEditor.kinds.${value}`)}
                </option>
              ))}
            </SettingsSelect>
          </label>
          <label className="text-sm">
            {t('organization.resourceEditor.owner')}
            <SettingsSelect
              aria-label={t('organization.resourceEditor.owner')}
              value={owner}
              required
              disabled={busy || Boolean(existing)}
              onChange={event => setOwner(event.target.value)}
              className="mt-1 block h-9 rounded border border-border bg-background px-2 max-md:h-11"
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
            {t('organization.resourceEditor.visibility')}
            <SettingsSelect
              aria-label={t('organization.resourceEditor.visibility')}
              value={visibility}
              disabled={busy || privateLocked}
              onChange={event => {
                setVisibility(event.target.value as OrganizationResource['visibility'])
                if (event.target.value === 'private') setGrants([])
              }}
              className="mt-1 block h-9 rounded border border-border bg-background px-2 max-md:h-11"
            >
              <option value="private">{t('organization.visibility.private')}</option>
              <option value="organization">{t('organization.visibility.organization')}</option>
            </SettingsSelect>
          </label>
        </div>
        {visibility === 'organization' && !privateLocked && (
          <fieldset className="space-y-2">
            <legend className="text-sm">{t('organization.resourceEditor.grants')}</legend>
            {grants.map((grant, index) => (
              <div key={grant.subject} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="break-all">
                  {accounts.find(account => account.id === grant.subject)?.username ??
                    (grant.subject.startsWith('role:')
                      ? t(`organization.roles.${grant.subject.slice(5)}`)
                      : grant.subject)}
                </span>
                {actions.map(action => (
                  <label key={action} className="flex min-h-11 items-center gap-1 md:min-h-9">
                    <input
                      type="checkbox"
                      checked={grant.actions.includes(action)}
                      disabled={busy}
                      onChange={() => toggleAction(index, action)}
                    />
                    {t(`organization.resourceEditor.actions.${action}`)}
                  </label>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setGrants(values => values.filter((_, current) => current !== index))
                  }
                >
                  {t('organization.resourceEditor.removeGrant')}
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <SettingsSelect
                aria-label={t('organization.resourceEditor.subject')}
                value={subject}
                disabled={busy}
                onChange={event => setSubject(event.target.value)}
                className="h-9 max-w-full rounded border border-border bg-background px-2 max-md:h-11"
              >
                <option value="">{t('organization.resourceEditor.subject')}</option>
                {accounts
                  .filter(account => !grants.some(grant => grant.subject === account.id))
                  .map(account => (
                    <option key={account.id} value={account.id}>
                      {account.username}
                    </option>
                  ))}
                {roles
                  .filter(role => !grants.some(grant => grant.subject === `role:${role}`))
                  .map(role => (
                    <option key={role} value={`role:${role}`}>
                      {t(`organization.roles.${role}`)}
                    </option>
                  ))}
              </SettingsSelect>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !subject}
                onClick={() => {
                  setGrants(values => [...values, { subject, actions: [] }])
                  setSubject('')
                }}
              >
                {t('organization.resourceEditor.addGrant')}
              </Button>
            </div>
          </fieldset>
        )}
        {kind === 'knowledge' && (
          <details
            className="studio-card-spacing space-y-3 rounded-lg border border-border"
            data-testid="organization-knowledge-source-editor"
          >
            <summary className="cursor-pointer text-sm">
              {t('organization.resourceEditor.nativeSource')}
            </summary>
            <p className="text-sm text-text-secondary">
              {t('organization.resourceEditor.nativeSourceHelp')}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={sourceEnabled}
                disabled={busy || privateLocked || Boolean(existing?.nativeKnowledgeSource)}
                onChange={event => setSourceEnabled(event.target.checked)}
              />
              {t('organization.resourceEditor.nativeSourceEnabled')}
            </label>
            {sourceEnabled && (
              <>
                <label className="block text-sm">
                  {t('organization.resourceEditor.nativePublisher')}
                  <SettingsSelect
                    className="mt-1 block h-10 w-full rounded-lg border border-border bg-background px-3"
                    aria-label={t('organization.resourceEditor.nativePublisher')}
                    value={publisher}
                    disabled={busy || privateLocked || Boolean(existing?.nativeKnowledgeSource)}
                    onChange={event => setPublisher(event.target.value)}
                  >
                    <option value="">{t('organization.selectMember')}</option>
                    {accounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {account.username}
                      </option>
                    ))}
                  </SettingsSelect>
                </label>
                <label className="block text-sm">
                  {t('organization.resourceEditor.nativeReference')}
                  <textarea
                    rows={6}
                    aria-label={t('organization.resourceEditor.nativeReference')}
                    value={sourceReference}
                    disabled={busy || privateLocked || Boolean(existing?.nativeKnowledgeSource)}
                    className="mt-1 block w-full rounded-lg border border-border bg-background p-3 font-mono text-sm"
                    onChange={event => setSourceReference(event.target.value)}
                  />
                </label>
                {!parsedSource && (
                  <p role="status" className="text-sm text-text-secondary">
                    {t('organization.resourceEditor.nativeReferenceInvalid')}
                  </p>
                )}
              </>
            )}
          </details>
        )}
        {kind === 'audit' && (
          <fieldset className="space-y-2 text-sm">
            <legend>{t('organization.resourceEditor.auditScope')}</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="auditScope"
                checked={scope === 'resources'}
                onChange={() => setScope('resources')}
                disabled={busy || privateLocked}
              />
              {t('organization.resourceEditor.scopedAudit')}
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="auditScope"
                checked={scope === 'organization'}
                onChange={() => setScope('organization')}
                disabled={busy || privateLocked}
              />
              {t('organization.resourceEditor.wholeAudit')}
            </label>
            {scope === 'resources' &&
              resources
                .filter(resource => resource.kind !== 'audit')
                .map(resource => (
                  <label key={resource.id} className="flex min-h-11 items-center gap-2 break-all">
                    <input
                      type="checkbox"
                      checked={scopeIds.includes(resource.id)}
                      disabled={busy || privateLocked}
                      onChange={() =>
                        setScopeIds(values =>
                          values.includes(resource.id)
                            ? values.filter(id => id !== resource.id)
                            : [...values, resource.id]
                        )
                      }
                    />
                    {resource.id}
                  </label>
                ))}
          </fieldset>
        )}
        <Button type="submit" disabled={busy || !valid}>
          {t('organization.resourceEditor.save')}
        </Button>
      </form>
    </div>
  )
}
