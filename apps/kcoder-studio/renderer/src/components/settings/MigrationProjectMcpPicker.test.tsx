import { act, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { expect, it, vi } from 'vitest'
import { ProjectMcpCatalogController } from '../../../../shared/migrationProjectMcp'
import { MigrationProjectMcpPicker } from './MigrationProjectMcpPicker'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('requires confirmation and disables every choice while the parent is publishing', async () => {
  const controller = new ProjectMcpCatalogController('owned', async () => ({ jobId: 'owned', status: 'selection_required', names: ['docs'], totalNames: 1, revision: 'a'.repeat(64), nextPageIndex: null }), () => true)
  await controller.load()
  const Picker = ({ disabled = false }: { disabled?: boolean }) => <MigrationProjectMcpPicker controller={controller} state={useSyncExternalStore(controller.subscribe, controller.snapshot)} disabled={disabled}/>
  const view = render(<Picker/>)
  fireEvent.click(screen.getByRole('checkbox', { name: 'docs' }))
  expect(controller.selection()).toBeUndefined()
  fireEvent.click(screen.getByRole('checkbox', { name: 'project_mcp.confirm' }))
  expect(controller.selection()?.names).toEqual(['docs'])
  view.rerender(<Picker disabled/>)
  expect((screen.getByRole('checkbox', { name: 'docs' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('checkbox', { name: 'project_mcp.confirm' }) as HTMLInputElement).disabled).toBe(true)
  await act(async () => controller.invalidate())
  expect(controller.selection()).toBeUndefined()
  expect(screen.queryByRole('checkbox')).toBeNull()
})
