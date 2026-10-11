import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CloudFilesView } from './CloudFilesView'

const project = {
  id: 13,
  public_id: 'project-13',
  project_key: 'CLOUD',
  name: 'Cloud project',
  description: '',
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

describe('CloudFilesView', () => {
  it('an older list cannot erase files loaded after a successful upload', async () => {
    let finish!: (value: unknown) => void
    const previous = new Promise(resolve => {
      finish = resolve
    })
    const entry = {
      id: 2,
      path: 'uploaded.txt',
      kind: 'file',
      content_type: 'text/plain',
      size_bytes: 2,
      updated_at: '2026-10-05',
      version: 1,
    }
    const api = {
      listCloudFiles: vi
        .fn()
        .mockReturnValueOnce(previous)
        .mockResolvedValue({ items: [entry] }),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
      uploadCloudFile: vi.fn(async () => ({})),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
    const view = render(<CloudFilesView api={api} project={project} />)
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'uploaded.txt')] },
    })
    await screen.findByText('uploaded.txt')
    await act(async () => {
      finish({ items: [] })
      await previous
    })
    expect(screen.getByText('uploaded.txt')).toBeInTheDocument()
  })

  it('project/API changes discard old files and late replies before rows can act on them', async () => {
    let finish!: (value: unknown) => void
    const previous = new Promise(resolve => {
      finish = resolve
    })
    const first = {
      listCloudFiles: vi.fn(() => previous),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
    const currentFile = {
      id: 2,
      path: 'current.txt',
      kind: 'file',
      content_type: 'text/plain',
      size_bytes: 2,
      updated_at: '2026-10-05',
      version: 1,
    }
    const second = {
      listCloudFiles: vi.fn(async () => ({ items: [currentFile] })),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
    const view = render(<CloudFilesView api={first} project={project} />)
    view.rerender(
      <CloudFilesView api={second} project={{ ...project, id: 14, name: 'Current project' }} />
    )
    await screen.findByText('current.txt')
    await act(async () => {
      finish({ items: [{ ...currentFile, id: 1, path: 'previous.txt' }] })
      await previous
    })
    expect(screen.queryByText('previous.txt')).not.toBeInTheDocument()
    expect(screen.getByText('current.txt')).toBeInTheDocument()
  })

  it('shows immutable delivery assets beside shared workspace files', async () => {
    const api = {
      listCloudFiles: vi.fn(async () => ({ items: [] })),
      listProjectDeliveryFiles: vi.fn(async () => ({
        items: [
          {
            asset_id: 'asset-1',
            delivery_id: 'delivery-1',
            loop_item_id: 'CLOUD-3',
            loop_item_title: 'Prepare report',
            relative_path: 'reports/result.pdf',
            display_name: 'result.pdf',
            content_type: 'application/pdf',
            size_bytes: 128,
            delivered_at: '2026-07-22T12:00:00Z',
          },
        ],
      })),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>

    render(<CloudFilesView api={api} project={project} />)

    expect(await screen.findByTestId('delivery-file-asset-1')).toHaveTextContent('CLOUD-3')
    expect(screen.getByTestId('delivery-file-asset-1')).toHaveTextContent('Prepare report')
    expect(screen.getByTestId('delivery-file-asset-1')).toHaveTextContent('reports/result.pdf')
    expect(screen.getByText('来自已完成任务，只读且不可修改')).toBeInTheDocument()
  })
})
