import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import type { ExtensionsApi, ExtensionsInventoryResult } from './extensionsInventory'
import { larkInventory } from './extensionsInventory.test-fixtures'
import { useExtensionsInventory } from './useExtensionsInventory'
import { ExtensionsAllView } from './KCoderExtensionsView'
import { supportsSelfEvolution } from './evolution/evolutionApi'

vi.mock('./evolution/evolutionApi', async importOriginal => ({
  ...(await importOriginal<typeof import('./evolution/evolutionApi')>()),
  supportsSelfEvolution: vi.fn(),
}))

function Harness({ inventory }: { inventory: ExtensionsInventoryResult }) {
  const api = {
    inventory: vi.fn(async () => inventory),
    updateSkillPreference: vi.fn(),
    previewConflicts: vi.fn(),
    setPluginSkillsEnabled: vi.fn(),
  } satisfies ExtensionsApi
  const state = useExtensionsInventory({ enabled: true, deviceId: 'remote' }, api)
  return (
    <ExtensionsAllView
      state={state}
      query=""
      onShowConflicts={() => undefined}
      evolutionScope={{ deviceId: 'remote', workspacePath: '/repo' }}
    />
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

function withKey(inventory: ExtensionsInventoryResult): ExtensionsInventoryResult {
  return {
    ...inventory,
    items: inventory.items.map(item =>
      item.kind === 'skill' && item.effective ? { ...item, targetKey: 'skill:bundled:lark-doc' } : item
    ),
  } as ExtensionsInventoryResult
}

test('shows the evolution section only for skills with a target-published key on a capable target', async () => {
  vi.mocked(supportsSelfEvolution).mockResolvedValue(true)
  const { unmount } = render(<Harness inventory={withKey(larkInventory())} />)
  await waitFor(() => expect(screen.getAllByTestId('evolution-target-section').length).toBeGreaterThan(0))
  const effective = screen
    .getAllByTestId('extensions-item')
    .find(row => row.dataset.kind === 'skill' && row.dataset.effective === 'true')!
  expect(within(effective).getByTestId('evolution-target-section')).toBeInTheDocument()
  expect(supportsSelfEvolution).toHaveBeenCalledWith('remote', '/repo')
  unmount()

  // No client-built keys: without `targetKey` the section stays hidden.
  render(<Harness inventory={larkInventory()} />)
  await screen.findAllByTestId('extensions-item')
  await waitFor(() => expect(supportsSelfEvolution).toHaveBeenCalledTimes(2))
  expect(screen.queryByTestId('evolution-target-section')).toBeNull()
})

test('hides the section when the target lacks selfEvolutionV1', async () => {
  vi.mocked(supportsSelfEvolution).mockResolvedValue(false)
  render(<Harness inventory={withKey(larkInventory())} />)
  await screen.findAllByTestId('extensions-item')
  await waitFor(() => expect(supportsSelfEvolution).toHaveBeenCalled())
  expect(screen.queryByTestId('evolution-target-section')).toBeNull()
})
