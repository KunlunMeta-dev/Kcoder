import { expect, it, vi } from 'vitest'
import examples from '../../../shared/generated/examples.migration-source-credentials.json'
import { createCredentialSourcesApi, CREDENTIAL_SOURCES_CAPABILITY, CREDENTIAL_SOURCES_METHOD, validCredentialSources } from '../../../shared/migrationCredentialSources'
import { createTestGatewayRuntime, FakeGatewayClient } from './gatewayRuntime.test-support'

const params = { jobId: 'mig-owned', pageIndex: 0 }
const result = examples.MigrationSourceCredentialSourcesResult[0].value
const target = { id: 'owned-target', label: 'Owned target', description: '', runtime: 'kcoder' as const, transport: 'local' as const }

it('requires the independent metadata capability and forwards cancellation only as a read', async () => {
  const client = new FakeGatewayClient(null)
  const support = vi.spyOn(client, 'supportsExperimental').mockImplementation(name => name !== CREDENTIAL_SOURCES_CAPABILITY)
  const request = vi.spyOn(client, 'request').mockResolvedValue(result as never)
  const runtime = createTestGatewayRuntime('fixture', { loadServers: async () => [target], createClient: () => client })
  const options = { signal: new AbortController().signal }
  const invoke = () => runtime.request('runtime.migration.request', { deviceId: target.id, method: CREDENTIAL_SOURCES_METHOD, params }, options)
  try {
    await expect(invoke()).rejects.toThrow('private_credentials_update_required')
    expect(request).not.toHaveBeenCalled()
    support.mockReturnValue(true)
    await expect(invoke()).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith(CREDENTIAL_SOURCES_METHOD, params, options)
  } finally { await runtime.dispose() }
})

it('accepts only the original job and an exact ten-item page without duplicate locators', async () => {
  const invoke = vi.fn(), api = createCredentialSourcesApi(invoke)
  for (const value of [undefined, { ...result, jobId: 'peer-job' }, { ...result, items: [] }, { ...result, nextPage: 1 },
    { ...result, items: [result.items[0], result.items[0]], totalItems: 2 }, { ...result, privateKey: 'SYNTHETIC_REJECTED_VALUE' }]) {
    invoke.mockResolvedValueOnce(value)
    await expect(api.credentialSources(params)).rejects.toThrow('migration_invalid_response')
  }
  invoke.mockResolvedValueOnce(result)
  await expect(api.credentialSources(params)).resolves.toEqual(result)
  expect(validCredentialSources(params)).toBe(true)
  expect(validCredentialSources(params, undefined)).toBe(false)
})

it('rejects injected paths and invalid pages before opening an executor', async () => {
  const invoke = vi.fn(), api = createCredentialSourcesApi(invoke)
  for (const value of [{ ...params, path: '/peer' }, { ...params, pageIndex: -1 }, { ...params, pageIndex: 1025 }]) {
    await expect(api.credentialSources(value)).rejects.toThrow('migration_invalid_parameters')
  }
  expect(invoke).not.toHaveBeenCalled()
})
