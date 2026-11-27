import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { Activity } from 'react'
import { McpInstallForm } from './McpInstallForm'

test('preserves input after a rejected install and closes only after successful save', async () => {
  const install = vi
    .fn()
    .mockRejectedValueOnce(new Error('Duplicate server'))
    .mockResolvedValue(undefined)
  render(<McpInstallForm install={install} disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: /Add MCP|添加 MCP/ }))
  fireEvent.change(screen.getByLabelText(/Server name|服务名称/), { target: { value: 'docs' } })
  fireEvent.change(screen.getByLabelText(/Server URL|服务地址/), {
    target: { value: 'https://example.test/mcp' },
  })
  const save = () => screen.getByRole('button', { name: /Save MCP|保存 MCP/ })
  fireEvent.click(save())
  expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate server')
  expect(screen.getByLabelText(/Server name|服务名称/)).toHaveValue('docs')
  fireEvent.click(save())
  await waitFor(() =>
    expect(screen.queryByTestId('kcoder-mcp-install-form')).not.toBeInTheDocument()
  )
  expect(install).toHaveBeenCalledWith({
    name: 'docs',
    transport: 'http',
    url: 'https://example.test/mcp',
  })
})

test('stdio arguments remain separate strings and invalid JSON is not submitted', async () => {
  const install = vi.fn().mockResolvedValue(undefined)
  render(<McpInstallForm install={install} disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: /Add MCP|添加 MCP/ }))
  fireEvent.change(screen.getByLabelText(/Server name|服务名称/), { target: { value: 'local' } })
  fireEvent.change(screen.getByLabelText(/Transport|连接方式/), { target: { value: 'stdio' } })
  fireEvent.change(screen.getByLabelText(/Command|启动命令/), { target: { value: 'npx' } })
  const args = screen.getByLabelText(/Arguments|参数（/)
  fireEvent.change(args, { target: { value: 'not-json' } })
  fireEvent.click(screen.getByRole('button', { name: /Save MCP|保存 MCP/ }))
  await screen.findByRole('alert')
  expect(install).not.toHaveBeenCalled()
  fireEvent.change(args, { target: { value: '["-y","a package","--flag"]' } })
  fireEvent.click(screen.getByRole('button', { name: /Save MCP|保存 MCP/ }))
  await waitFor(() =>
    expect(install).toHaveBeenCalledWith({
      name: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'a package', '--flag'],
    })
  )
})


test.each(['success', 'failure'] as const)('old install %s cannot close or overwrite the resumed form draft', async outcome => {
  let release!: () => void, reject!: (error: Error) => void
  const install = vi.fn(() => new Promise<void>((resolve, fail) => { release = resolve; reject = fail }))
  const tree = (visible: boolean) => <Activity mode={visible ? 'visible' : 'hidden'}><McpInstallForm install={install} disabled={false} /></Activity>
  const view = render(tree(true))
  try {
    fireEvent.click(screen.getByRole('button', { name: /Add MCP|添加 MCP/ }))
    fireEvent.change(screen.getByLabelText(/Server name|服务名称/), { target: { value: 'old-draft' } })
    fireEvent.change(screen.getByLabelText(/Server URL|服务地址/), { target: { value: 'https://example.test/old' } })
    fireEvent.click(screen.getByRole('button', { name: /Save MCP|保存 MCP/ }))
    await waitFor(() => expect(install).toHaveBeenCalledOnce())
    view.rerender(tree(false)); view.rerender(tree(true))
    fireEvent.change(screen.getByLabelText(/Server name|服务名称/), { target: { value: 'new-draft' } })
    await act(async () => { if (outcome === 'success') release(); else reject(new Error('old install failed')) })
    expect(screen.getByLabelText(/Server name|服务名称/)).toHaveValue('new-draft')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(install).toHaveBeenCalledOnce()
  } finally { release(); view.unmount() }
})
