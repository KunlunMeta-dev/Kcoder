import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MigrationAgentChoice } from './MigrationAgentChoice'
const { agentPreview } = vi.hoisted(() => ({ agentPreview: vi.fn() }))
vi.mock('@/kcoder/gatewayMigration', () => ({ createMigrationApi: () => ({ agentPreview }) }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const response = { jobId: 'owned-job', itemId: 'owned-agent', compatibility: { sourceSha256: 'a'.repeat(64), canAdapt: true, availableTools: ['read'], sourceModelReference: true, problem: null } }
const current = () => true
beforeEach(() => { vi.clearAllMocks(); agentPreview.mockResolvedValue(response) })
it('requires inspection, explicit model mapping and user review before returning an executable choice', async () => {
  const changed = vi.fn()
  render(<MigrationAgentChoice deviceId="owned" jobId="owned-job" itemId="owned-agent" isCurrent={current} onChange={changed}/>)
  expect(agentPreview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('adapt')); await waitFor(() => expect(changed).toHaveBeenLastCalledWith(null, false))
  fireEvent.click(screen.getByTestId('migration-agent-inspect'))
  await screen.findByTestId('migration-agent-model-kind')
  fireEvent.change(screen.getByTestId('migration-agent-model-kind'), { target: { value: 'target' } })
  fireEvent.change(screen.getByTestId('migration-agent-provider'), { target: { value: 'native-provider' } })
  fireEvent.change(screen.getByTestId('migration-agent-model'), { target: { value: 'native-model' } })
  expect(changed).toHaveBeenLastCalledWith(null, false)
  fireEvent.click(screen.getByTestId('migration-agent-confirm'))
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ reviewedSourceSha256: 'a'.repeat(64), model: { kind: 'target', provider: 'native-provider', model: 'native-model' }, tools: ['read'] }, true))
  fireEvent.change(screen.getByTestId('migration-agent-model'), { target: { value: 'different' } })
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith(null, false))
})
it('unsupported definitions remain pending without model controls or an implicit fallback', async () => {
  agentPreview.mockResolvedValue({ ...response, compatibility: { ...response.compatibility, canAdapt: false, availableTools: [], problem: 'unsupported_semantics' } })
  const changed = vi.fn()
  render(<MigrationAgentChoice deviceId="owned" jobId="owned-job" itemId="owned-agent" isCurrent={current} onChange={changed}/>)
  fireEvent.click(screen.getByLabelText('adapt')); fireEvent.click(screen.getByTestId('migration-agent-inspect'))
  await screen.findByText('unsupported'); expect(screen.queryByTestId('migration-agent-confirm')).toBeNull()
  expect(changed).toHaveBeenLastCalledWith(null, false)
  fireEvent.click(screen.getByLabelText('adapt')); await waitFor(() => expect(changed).toHaveBeenLastCalledWith(null, true))
})
