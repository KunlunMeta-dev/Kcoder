import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowPendingPanel } from './WorkflowPendingPanel'
import { workflowApi } from './workflowApi'
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('./workflowApi', () => ({ workflowApi: { requests: vi.fn(), respond: vi.fn() } }))
test('human reply is submitted to the selected run and refreshed after acceptance', async () => {
  vi.mocked(workflowApi.requests).mockResolvedValue({ supported: true, requests: [{
    runId: 'run', requestId: 'reply', nodeId: 'approval', status: 'pending',
    // Target deadlines cannot be judged using an unrelated client clock.
    deadlineUnixMs: 1,
    request: {kind:'human', prompt:'Approve this result', schema:{type:'object',properties:{approved:{type:'boolean',default:false}},required:['approved']}}
  }] })
  vi.mocked(workflowApi.respond).mockImplementation(async () => {
    vi.mocked(workflowApi.requests).mockResolvedValue({supported:true,requests:[]})
    return {accepted:true}
  })
  const view = render(<WorkflowPendingPanel serverId="target" runId="run" isCurrent={() => true} />)
  fireEvent.change(await screen.findByTestId('workflow-arg-approved'),{target:{value:'0'}})
  fireEvent.click(screen.getByTestId('workflow-submit-response'))
  await waitFor(() => expect(workflowApi.respond).toHaveBeenCalledWith('target','run','reply',{approved:true}))
  await waitFor(() => expect(screen.queryByTestId('workflow-pending-approval')).not.toBeInTheDocument())
  view.unmount()
})
