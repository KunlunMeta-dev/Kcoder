import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  KCoderOrganizationResources,
  type OrganizationResource,
} from './KCoderOrganizationResources'
import { knowledgeSourceReference } from './organizationKnowledgeSource'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const accounts = [
  { id: 'admin-id', username: 'operator' },
  { id: 'alice-id', username: 'alice' },
]
const resource: OrganizationResource = {
  id: 'knowledge:original',
  kind: 'knowledge',
  owner: 'alice-id',
  visibility: 'organization',
  grants: [],
}
const props = { accounts, currentPrincipalId: 'admin-id', revision: 7, busy: false }

test('native source declaration keeps management owner separate and sends only finite publication metadata', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const dataOwner = {
    accountId: 'native-profile',
    targetId: 'native-target',
    workspaceId: 'native-workspace',
    organizationId: 'organization-one',
  }
  render(<KCoderOrganizationResources {...props} resources={[resource]} save={save} />)
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.id'), {
    target: { value: 'knowledge:source-reference' },
  })
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.owner'), {
    target: { value: 'admin-id' },
  })
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.visibility'), {
    target: { value: 'organization' },
  })
  fireEvent.click(screen.getByText('organization.resourceEditor.nativeSource'))
  fireEvent.click(screen.getByLabelText('organization.resourceEditor.nativeSourceEnabled'))
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.nativePublisher'), {
    target: { value: 'alice-id' },
  })
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.nativeReference'), {
    target: {
      value: JSON.stringify({
        owner: dataOwner,
        publicationId: 'original-publication',
        version: 2,
      }),
    },
  })
  fireEvent.click(screen.getByText('organization.resourceEditor.save'))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save.mock.calls[0][0].resource).toMatchObject({
    owner: 'admin-id',
    grants: [],
    nativeKnowledgeSource: {
      version: 1,
      publisherPrincipalId: 'alice-id',
      publicationOwner: dataOwner,
      publicationId: 'original-publication',
    },
  })
  expect(
    knowledgeSourceReference(
      JSON.stringify({
        owner: dataOwner,
        publicationId: 'original-publication',
        body: 'private-body',
      })
    )
  ).toBeNull()
  expect(
    knowledgeSourceReference(
      JSON.stringify({
        owner: { ...dataOwner, path: '/private' },
        publicationId: 'original-publication',
      })
    )
  ).toBeNull()
  expect(
    knowledgeSourceReference(
      JSON.stringify({ owner: dataOwner, publicationId: 'original-publication', version: false })
    )
  ).toBeNull()
})

test('resource edit keeps immutable identity and sends finite grants with the observed revision', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<KCoderOrganizationResources {...props} resources={[resource]} save={save} />)
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.select'), {
    target: { value: resource.id },
  })
  expect(screen.getByLabelText('organization.resourceEditor.id')).toBeDisabled()
  expect(screen.getByLabelText('organization.resourceEditor.kind')).toBeDisabled()
  expect(screen.getByLabelText('organization.resourceEditor.owner')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.subject'), {
    target: { value: 'role:knowledgePublisher' },
  })
  fireEvent.click(screen.getByText('organization.resourceEditor.addGrant'))
  expect(screen.getByText('organization.resourceEditor.save')).toBeDisabled()
  fireEvent.click(screen.getByLabelText('organization.resourceEditor.actions.read'))
  fireEvent.click(screen.getByText('organization.resourceEditor.save'))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      operation: 'organization.resource',
      expectedRevision: 7,
      resource: {
        ...resource,
        grants: [{ subject: 'role:knowledgePublisher', actions: ['read'] }],
      },
    })
  )
})

test('administrator cannot edit another member private boundary or grant itself access', () => {
  const save = vi.fn()
  render(
    <KCoderOrganizationResources
      {...props}
      resources={[{ ...resource, visibility: 'private' }]}
      save={save}
    />
  )
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.select'), {
    target: { value: resource.id },
  })
  expect(screen.getByText('organization.resourceEditor.privateLocked')).toBeInTheDocument()
  expect(screen.getByLabelText('organization.resourceEditor.visibility')).toBeDisabled()
  expect(screen.getByText('organization.resourceEditor.save')).toBeDisabled()
  expect(screen.queryByText('organization.resourceEditor.addGrant')).not.toBeInTheDocument()
  expect(save).not.toHaveBeenCalled()
})

test('a refreshed policy revision cannot silently overwrite a draft from the earlier revision', () => {
  const save = vi.fn()
  const rendered = render(
    <KCoderOrganizationResources {...props} resources={[resource]} save={save} />
  )
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.select'), {
    target: { value: resource.id },
  })
  rendered.rerender(
    <KCoderOrganizationResources
      {...props}
      revision={8}
      resources={[{ ...resource, grants: [{ subject: 'alice-id', actions: ['read'] }] }]}
      save={save}
    />
  )
  expect(screen.getByText('organization.resourceEditor.changed')).toBeInTheDocument()
  expect(screen.getByText('organization.resourceEditor.save')).toBeDisabled()
  fireEvent.click(screen.getByText('organization.resourceEditor.reload'))
  expect(screen.getByLabelText('organization.resourceEditor.actions.read')).toBeChecked()
  expect(save).not.toHaveBeenCalled()
})

test('audit policy requires an explicit selected scope and export grant rather than defaulting to the organization', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<KCoderOrganizationResources {...props} resources={[resource]} save={save} />)
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.id'), {
    target: { value: 'audit:knowledge' },
  })
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.owner'), {
    target: { value: 'admin-id' },
  })
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.kind'), {
    target: { value: 'audit' },
  })
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.visibility'), {
    target: { value: 'organization' },
  })
  fireEvent.change(screen.getByLabelText('organization.resourceEditor.subject'), {
    target: { value: 'role:auditor' },
  })
  fireEvent.click(screen.getByText('organization.resourceEditor.addGrant'))
  fireEvent.click(screen.getByLabelText('organization.resourceEditor.actions.export'))
  expect(screen.getByText('organization.resourceEditor.save')).toBeDisabled()
  fireEvent.click(screen.getByLabelText(resource.id))
  fireEvent.click(screen.getByText('organization.resourceEditor.save'))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      operation: 'organization.resource',
      expectedRevision: 7,
      resource: {
        id: 'audit:knowledge',
        kind: 'audit',
        owner: 'admin-id',
        visibility: 'organization',
        grants: [{ subject: 'role:auditor', actions: ['export'] }],
        auditScope: { resourceIds: [resource.id] },
      },
    })
  )
})
