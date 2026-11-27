import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { StrictMode } from 'react'

import { StorageLocationsPanel } from '@/components/settings/StorageLocationsPanel'
import type {
  StorageLocationsBridge,
  StorageLocationsSnapshot,
  StorageMigrationPlan,
  StoragePaths,
  StorageMigrationReceipt,
  StorageSourceCleanupPreview,
  StorageSourceCleanupResult,
} from '@/kcoder/storageLocations'
import '@/i18n'

const paths: StoragePaths = {
  dataRoot: '/home/user/.config/kcoder',
  cacheRoot: '/home/user/.cache/kcoder',
  gatewayRoot: '/home/user/.config/kcoder/studio/gateway',
  desktopRoot: '/home/user/.config/kcoder/studio/desktop',
  temporaryRoot: '/home/user/.cache/kcoder/tmp',
  locationFile: '/home/user/.config/kcoder-storage.json',
  layout: 'unified',
  sources: {
    dataRoot: 'selection',
    cacheRoot: 'selection',
    gatewayRoot: 'selection',
    desktopRoot: 'selection',
  },
  externallyConfigured: false,
  selectionRevision: 3,
  operationId: null,
}

const plan: StorageMigrationPlan = {
  version: 1,
  operationId: 'storage-operation-1',
  original: null,
  from: paths,
  target: {
    version: 1,
    revision: 4,
    dataRoot: '/mnt/data/kcoder',
    cacheRoot: '/mnt/cache/kcoder',
    operationId: 'storage-operation-1',
  },
  components: [
    {
      domain: 'gateway',
      source: '/home/user/.config/kcoder-studio',
      destination: '/mnt/data/kcoder/studio/gateway',
      sourceIdentity: 'fixture-source',
      estimatedBytes: 1024,
    },
  ],
  launchIntent: 'desktop',
}

const cleanupPreview: StorageSourceCleanupPreview = {
  operationId: plan.operationId,
  selection: plan.target,
  confirmation: 'c'.repeat(64),
  pending: false,
  entries: [
    { domain: 'gateway', sourceRoot: '/old/gateway', relativePath: 'original.json', status: 'eligibleFile', sizeBytes: 12, observedVersion: 'version' },
    { domain: 'gateway', sourceRoot: '/old/gateway', relativePath: 'changed.json', status: 'retainedChanged', sizeBytes: 14, observedVersion: null },
    { domain: 'gateway', sourceRoot: '/old/gateway', relativePath: 'new.json', status: 'retainedUnknown', sizeBytes: null, observedVersion: null },
  ],
}
const cleanupResult: StorageSourceCleanupResult = {
  operationId: cleanupPreview.operationId,
  confirmation: cleanupPreview.confirmation,
  entries: cleanupPreview.entries.map(entry => ({ ...entry, status: entry.status === 'eligibleFile' ? 'removed' : entry.status })),
}
const completed: StorageMigrationReceipt = { plan, phase: 'verified', disposition: 'complete' }
const deferredPlan: StorageMigrationPlan = {
  ...plan,
  operationId: 'storage-operation-deferred',
  original: {
    version: 1,
    revision: 3,
    dataRoot: paths.dataRoot,
    cacheRoot: paths.cacheRoot,
  },
  target: { ...plan.target, operationId: 'storage-operation-deferred' },
}
const deferredOperation: StorageMigrationReceipt = {
  plan: deferredPlan,
  phase: 'prepared',
  disposition: 'deferred',
  errorCode: 'STORAGE_STOP_TIMEOUT',
}

function cleanupReceipt(version: number, result: StorageSourceCleanupResult | null) {
  if (version === 1) return { version, preview: cleanupPreview, result }
  const { entries, ...preview } = cleanupPreview
  return { version, preview: { ...preview, sources: [{ domain: 'gateway', sourceRoot: '/old/gateway',
    entries: entries.map(entry => ({ relativePath: entry.relativePath, status: entry.status,
      sizeBytes: entry.sizeBytes, observedVersion: entry.observedVersion })) }] },
  resultStatuses: result?.entries.map(entry => entry.status) ?? null }
}

function cleanupBridge(overrides: Partial<StorageLocationsBridge> = {}): StorageLocationsBridge {
  return makeBridge({
    read: vi.fn().mockResolvedValue(snapshot({ operation: completed })),
    cleanupPreview: vi.fn().mockResolvedValue(cleanupPreview),
    cleanupConfirm: vi.fn().mockResolvedValue(cleanupResult),
    ...overrides,
  })
}

function snapshot(overrides: Partial<StorageLocationsSnapshot> = {}): StorageLocationsSnapshot {
  return { paths, readOnly: false, operation: null, ...overrides }
}

function makeBridge(overrides: Partial<StorageLocationsBridge> = {}): StorageLocationsBridge {
  return {
    read: vi.fn().mockResolvedValue(snapshot()),
    pick: vi.fn().mockResolvedValue(null),
    preview: vi.fn().mockResolvedValue(plan),
    migrate: vi.fn().mockResolvedValue({ operationId: plan.operationId, state: 'ready' }),
    retry: vi.fn().mockResolvedValue({ operationId: plan.operationId, state: 'ready' }),
    cleanupPreview: vi.fn(),
    cleanupConfirm: vi.fn(),
    cleanupStatus: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

function installBridge(bridge: StorageLocationsBridge) {
  Object.assign(window, { kcoderDesktopHost: { storageLocations: bridge } })
}

afterEach(() => {
  delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
})

test('old copies require a separate preview and explicit confirmation; cancellation removes nothing', async () => {
  const user = userEvent.setup()
  const bridge = cleanupBridge()
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-source-cleanup')
  expect(bridge.cleanupPreview).not.toHaveBeenCalled()
  expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('storage-cleanup-preview'))
  expect(bridge.cleanupPreview).toHaveBeenCalledWith({ operationId: plan.operationId })
  expect(await screen.findByTestId('storage-cleanup-plan')).toHaveTextContent('可清理 1 项，保留 2 项')
  expect(screen.getByTestId('storage-cleanup-entries')).toHaveTextContent('保留已变更或无法核对的对象')
  expect(screen.getByTestId('storage-cleanup-entries')).toHaveTextContent('保留新增或未知内容')
  await user.click(screen.getByTestId('storage-cleanup-confirm'))
  expect(await screen.findByTestId('storage-cleanup-confirm-dialog')).toHaveTextContent(plan.operationId)
  await user.click(screen.getByTestId('storage-cleanup-cancel'))
  expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('storage-cleanup-confirm'))
  await user.click(screen.getByTestId('storage-cleanup-submit'))
  expect(await screen.findByTestId('storage-cleanup-result')).toHaveTextContent('已删除 1 项，保留 2 项')
  expect(bridge.cleanupConfirm).toHaveBeenCalledExactlyOnceWith({ operationId: plan.operationId, confirmation: cleanupPreview.confirmation })
  expect(bridge.migrate).not.toHaveBeenCalled()
})

test('a lost cleanup reply reads its original receipt and never replays the deletion', async () => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({
    cleanupConfirm: vi.fn().mockRejectedValue(new Error('native reply lost')),
    cleanupStatus: vi.fn().mockResolvedValue({ ...completed, ownerReceipts: {
      'source-cleanup': { version: 1, preview: cleanupPreview, result: cleanupResult },
    } }),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-cleanup-preview'))
  await user.click(await screen.findByTestId('storage-cleanup-confirm'))
  await user.click(screen.getByTestId('storage-cleanup-submit'))
  expect(await screen.findByTestId('storage-cleanup-result')).toHaveTextContent('已删除 1 项')
  expect(bridge.cleanupStatus).toHaveBeenCalledExactlyOnceWith({ operationId: plan.operationId })
  expect(bridge.cleanupConfirm).toHaveBeenCalledTimes(1)
  expect(bridge.cleanupPreview).toHaveBeenCalledTimes(1)
  expect(screen.queryByTestId('storage-cleanup-unknown')).not.toBeInTheDocument()
})

test.each([1, 2])('reopening the panel restores the original v%s completed cleanup result without scanning or deleting', async version => {
  const bridge = cleanupBridge({ read: vi.fn().mockResolvedValue(snapshot({ operation: {
    ...completed, ownerReceipts: { 'source-cleanup': cleanupReceipt(version, cleanupResult) },
  } })) })
  installBridge(bridge)
  render(<StrictMode><StorageLocationsPanel /></StrictMode>)
  expect(await screen.findByTestId('storage-cleanup-result')).toHaveTextContent('已删除 1 项，保留 2 项')
  expect(bridge.cleanupPreview).not.toHaveBeenCalled()
  expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
})

test.each([1, 2])('reopening an unfinished v%s cleanup restores the original receipt query instead of retrying deletion', async version => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({ read: vi.fn().mockResolvedValue(snapshot({ operation: {
    ...completed, ownerReceipts: { 'source-cleanup': cleanupReceipt(version, null) },
  } })) })
  installBridge(bridge)
  render(<StrictMode><StorageLocationsPanel /></StrictMode>)
  expect(await screen.findByTestId('storage-cleanup-unknown')).toHaveTextContent(plan.operationId)
  await user.click(screen.getByTestId('storage-cleanup-status'))
  expect(bridge.cleanupStatus).toHaveBeenCalledExactlyOnceWith({ operationId: plan.operationId })
  expect(bridge.cleanupPreview).not.toHaveBeenCalled()
  expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
})

test('an unfinished original preview exposes its receipt read without replaying cleanup', async () => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({ cleanupPreview: vi.fn().mockResolvedValue({ ...cleanupPreview, pending: true }) })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-cleanup-preview'))
  expect(await screen.findByTestId('storage-cleanup-unknown')).toHaveTextContent(plan.operationId)
  await user.click(screen.getByTestId('storage-cleanup-status'))
  expect(bridge.cleanupStatus).toHaveBeenCalledExactlyOnceWith({ operationId: plan.operationId })
  expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
})

test('an unrelated cleanup result cannot settle uncertainty or change the original id', async () => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({
    cleanupConfirm: vi.fn().mockRejectedValue(new Error('lost reply')),
    cleanupStatus: vi.fn().mockResolvedValue({ ...completed, ownerReceipts: {
      'source-cleanup': { version: 1, result: { ...cleanupResult, confirmation: 'another-token' } },
    } }),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-cleanup-preview'))
  await user.click(await screen.findByTestId('storage-cleanup-confirm'))
  await user.click(screen.getByTestId('storage-cleanup-submit'))
  expect(await screen.findByTestId('storage-cleanup-unknown')).toHaveTextContent(plan.operationId)
  expect(screen.queryByTestId('storage-cleanup-result')).not.toBeInTheDocument()
  expect(screen.getByTestId('storage-cleanup-operation-id')).toBeDisabled()
  await user.click(screen.getByTestId('storage-cleanup-status'))
  expect(bridge.cleanupStatus).toHaveBeenNthCalledWith(2, { operationId: plan.operationId })
  expect(bridge.cleanupConfirm).toHaveBeenCalledTimes(1)
  expect(bridge.cleanupPreview).toHaveBeenCalledTimes(1)
})

test('a known earlier operation can be previewed without changing the current storage operation', async () => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({ cleanupPreview: vi.fn().mockResolvedValue({ ...cleanupPreview, operationId: 'older-migration' }) })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-cleanup-original-operation'))
  await user.clear(screen.getByTestId('storage-cleanup-operation-id'))
  await user.type(screen.getByTestId('storage-cleanup-operation-id'), 'older-migration')
  await user.click(screen.getByTestId('storage-cleanup-preview'))
  await screen.findByTestId('storage-cleanup-plan')
  expect(bridge.cleanupPreview).toHaveBeenCalledWith({ operationId: 'older-migration' })
  expect(screen.getByTestId('storage-location-operation')).toHaveTextContent(plan.operationId)
})

test('an oversized cleanup fails without a partial confirmation or mutation', async () => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({ cleanupPreview: vi.fn().mockRejectedValue(Object.assign(
    new Error('STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT'), { code: 'STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT' })) })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-cleanup-preview'))
  expect(await screen.findByTestId('storage-location-action-error')).toHaveTextContent('超出预览上限')
  expect(screen.queryByTestId('storage-cleanup-confirm')).not.toBeInTheDocument()
  expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
})

test.each([
  ['STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED', '无法安全判定旧数据的归属'],
  ['STORAGE_LEGACY_ENTRY_OWNER_UNKNOWN', '无法安全判定旧数据的归属'],
  ['STORAGE_LEGACY_ENTRY_OWNER_NOT_DECLARED', '无法安全判定旧数据的归属'],
  ['STORAGE_LEGACY_ENTRY_KIND_MISMATCH', '无法安全判定旧数据的归属'],
  ['STORAGE_LEGACY_CONTROL_PAYLOAD_UNCONFIRMED', '无法安全判定旧数据的归属'],
  ['STORAGE_LEGACY_REGISTERED_CATALOG_UNSUPPORTED', '无法安全判定旧数据的归属'],
  ['STORAGE_LEGACY_SOURCE_CHANGED', '无法确认源数据或目录身份'],
  ['STORAGE_TREE_MANIFEST_UNKNOWN', '无法确认源数据或目录身份'],
  ['STORAGE_LEGACY_REGISTRATION_INPUT_CHANGED', '无法确认源数据或目录身份'],
  ['STORAGE_TARGET_NOT_EMPTY', '目标目录不为空'],
  ['STORAGE_BROWSER_PROFILE_PATH_TOO_LONG', '目录层级过深'],
  ['STORAGE_INSUFFICIENT_SPACE', '释放目标磁盘空间'],
  ['STORAGE_SOURCE_TARGET_OVERLAP', '目录与待搬迁的数据或缓存重叠'],
  ['STORAGE_ROOTS_OVERLAP', '目录与待搬迁的数据或缓存重叠'],
  ['STORAGE_RECORD_UNAVAILABLE', '无法读取已保存的目录位置'],
  ['STORAGE_LEGACY_REGISTRATION_UNAVAILABLE', '无法读取已保存的目录位置'],
  ['STORAGE_OWNER_RUNTIME_REQUIRED', '本机迁移执行者尚未就绪'],
  ['STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED', '暂不支持迁移这类引用'],
  ['STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED', '托管 worktree 的内部位置使用了目录别名'],
  ['STORAGE_GATEWAY_REFERENCE_METADATA_INVALID', 'Gateway 连接目录或设备账本的格式无效'],
  ['STORAGE_GATEWAY_REFERENCE_METADATA_TOO_LARGE', '超出预检上限'],
  ['CREDENTIAL_RELOCATION_KEYRING_UNAVAILABLE', '请使用原操作系统账户和凭据存储'],
  ['CREDENTIAL_RELOCATION_KEYRING_ENTRY_MISSING', '请使用原操作系统账户和凭据存储'],
  ['CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED', '请使用原操作系统账户和凭据存储'],
  ['STORAGE_SOURCE_CLEANUP_NOT_COMPLETE', '原迁移或旧目录写入者的状态尚未确认'],
  ['STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN', '原迁移或旧目录写入者的状态尚未确认'],
  ['STORAGE_SOURCE_CLEANUP_UNKNOWN', '原迁移或旧目录写入者的状态尚未确认'],
])('known storage failure %s has a localized recovery message without raw diagnostics', async (code, text) => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({ cleanupPreview: vi.fn().mockRejectedValue(Object.assign(
    new Error('private worker diagnostic must stay hidden'), { code })) })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-cleanup-preview'))
  const alert = await screen.findByTestId('storage-location-action-error')
  expect(alert).toHaveTextContent(text)
  expect(alert).not.toHaveTextContent('private worker diagnostic')
  expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
})

test('a changed preview is a known rejection and permits a new preview of the same original operation', async () => {
  const user = userEvent.setup()
  const bridge = cleanupBridge({ cleanupConfirm: vi.fn().mockRejectedValue(Object.assign(
    new Error('STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED'), { code: 'STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED' })) })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-cleanup-preview'))
  await user.click(await screen.findByTestId('storage-cleanup-confirm'))
  await user.click(screen.getByTestId('storage-cleanup-submit'))
  expect(await screen.findByTestId('storage-location-action-error')).toHaveTextContent('旧副本与预览时不同')
  expect(screen.queryByTestId('storage-cleanup-unknown')).not.toBeInTheDocument()
  expect(bridge.cleanupStatus).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('storage-cleanup-preview'))
  expect(bridge.cleanupPreview).toHaveBeenNthCalledWith(2, { operationId: plan.operationId })
  expect(bridge.cleanupConfirm).toHaveBeenCalledTimes(1)
})

test.each([snapshot({ readOnly: true, operation: completed }), snapshot({ operation: { ...completed, phase: 'stopping', disposition: 'active' } })])(
  'read-only or active storage cannot expose old-copy deletion', async value => {
    const bridge = cleanupBridge({ read: vi.fn().mockResolvedValue(value) })
    installBridge(bridge)
    render(<StorageLocationsPanel />)
    await screen.findByTestId('storage-location-actual-paths')
    expect(screen.queryByTestId('storage-source-cleanup')).not.toBeInTheDocument()
    expect(bridge.cleanupPreview).not.toHaveBeenCalled()
    expect(bridge.cleanupConfirm).not.toHaveBeenCalled()
  }
)

test('a cancelled folder picker leaves the actual location and preview state unchanged', async () => {
  const user = userEvent.setup()
  const bridge = makeBridge()
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-location-actual-paths')

  await user.click(screen.getByTestId('storage-location-pick-data'))

  expect(bridge.pick).toHaveBeenCalledWith({ kind: 'data' })
  expect(screen.getByTestId('storage-location-path-dataRoot')).toHaveTextContent(paths.dataRoot)
  expect(screen.queryByTestId('storage-location-preview')).not.toBeInTheDocument()
})

test('a preview error is visible and does not produce a migration confirmation', async () => {
  const user = userEvent.setup()
  const bridge = makeBridge({
    pick: vi.fn().mockResolvedValue('/mnt/data/kcoder'),
    preview: vi.fn().mockRejectedValue(new Error('directory is not writable')),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-location-actual-paths')

  await user.click(screen.getByTestId('storage-location-pick-data'))
  await user.click(await screen.findByTestId('storage-location-preview'))

  expect(await screen.findByTestId('storage-location-action-error')).toHaveTextContent('directory is not writable')
  expect(screen.queryByTestId('storage-location-plan')).not.toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-confirm')).not.toBeInTheDocument()
})

test.each([
  'SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED',
  'SERVICE_LEASE_LEGACY_HOST_RELOCATION_UNSUPPORTED',
])('unsupported service preview %s explains the cache option without exposing helper details', async code => {
  const user = userEvent.setup()
  const bridge = makeBridge({
    pick: vi.fn().mockResolvedValue('/mnt/data/kcoder'),
    preview: vi.fn().mockRejectedValue(Object.assign(new Error(`Error: ${code} at /private/user/data`), { code })),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-location-actual-paths')

  await user.click(screen.getByTestId('storage-location-pick-data'))
  await user.click(await screen.findByTestId('storage-location-preview'))

  const error = await screen.findByTestId('storage-location-action-error')
  expect(error).toHaveTextContent('当前部分服务状态暂不支持搬迁')
  expect(error).toHaveTextContent('原有数据未改动')
  expect(error).toHaveTextContent('单独更改缓存目录')
  expect(error).not.toHaveTextContent(code)
  expect(error).not.toHaveTextContent('/private/user/data')
  expect(screen.queryByTestId('storage-location-plan')).not.toBeInTheDocument()
})

test('known domains use localized labels, unknown domains use a safe fallback, and zero estimates stay hidden', async () => {
  const user = userEvent.setup()
  const previewPlan: StorageMigrationPlan = {
    ...plan,
    components: [
      { ...plan.components[0], domain: 'persistent-root', estimatedBytes: 0 },
      { ...plan.components[0], domain: 'constructor', estimatedBytes: 1024 },
    ],
  }
  const bridge = makeBridge({
    pick: vi.fn().mockResolvedValue('/mnt/data/kcoder'),
    preview: vi.fn().mockResolvedValue(previewPlan),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-location-actual-paths')

  await user.click(screen.getByTestId('storage-location-pick-data'))
  await user.click(await screen.findByTestId('storage-location-preview'))
  const previewPanel = await screen.findByTestId('storage-location-plan')

  expect(previewPanel).toHaveTextContent('配置与数据目录')
  expect(previewPanel).toHaveTextContent('其他存储数据')
  expect(previewPanel).not.toHaveTextContent('persistent-root')
  expect(previewPanel).not.toHaveTextContent('constructor')
  expect(previewPanel).not.toHaveTextContent('function')
  expect(previewPanel).toHaveTextContent('1.0 KiB')
  expect(previewPanel).not.toHaveTextContent('0 B')
})

test('a late plan response is ignored after the selected folder revision changes', async () => {
  const user = userEvent.setup()
  let resolvePreview!: (value: StorageMigrationPlan | null) => void
  const previewResponse = new Promise<StorageMigrationPlan | null>(resolve => { resolvePreview = resolve })
  const bridge = makeBridge({
    pick: vi.fn()
      .mockResolvedValueOnce('/mnt/data/kcoder')
      .mockResolvedValueOnce('/mnt/cache/kcoder'),
    preview: vi.fn().mockReturnValue(previewResponse),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-location-actual-paths')

  await user.click(screen.getByTestId('storage-location-pick-data'))
  await user.click(await screen.findByTestId('storage-location-preview'))
  await waitFor(() => expect(bridge.preview).toHaveBeenCalledWith({
    dataRoot: '/mnt/data/kcoder',
    cacheRoot: paths.cacheRoot,
  }))
  await user.click(screen.getByTestId('storage-location-pick-cache'))

  resolvePreview(plan)
  await waitFor(() => expect(screen.queryByTestId('storage-location-plan')).not.toBeInTheDocument())
  expect(screen.getByTestId('storage-location-path-dataRoot')).toHaveTextContent(paths.dataRoot)
})

test('read-only external paths are shown without folder selection controls', async () => {
  const bridge = makeBridge({ read: vi.fn().mockResolvedValue(snapshot({
    readOnly: true,
    paths: { ...paths, externallyConfigured: true },
    operation: deferredOperation,
  })) })
  installBridge(bridge)
  render(<StorageLocationsPanel />)

  expect(await screen.findByTestId('storage-locations-readonly')).toBeInTheDocument()
  expect(screen.getByTestId('storage-location-path-dataRoot')).toHaveTextContent(paths.dataRoot)
  expect(screen.queryByTestId('storage-location-pick-data')).not.toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-pick-cache')).not.toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-retry-original')).not.toBeInTheDocument()
  expect(bridge.retry).not.toHaveBeenCalled()
  expect(bridge.migrate).not.toHaveBeenCalled()
})

test('web without the local desktop bridge explains the boundary and has no picker', async () => {
  render(<StorageLocationsPanel />)

  expect(await screen.findByTestId('storage-locations-desktop-only')).toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-pick-data')).not.toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-preview')).not.toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-stop-migrate')).not.toBeInTheDocument()
})

test('migration confirmation explicitly stops the instance and a ready handoff is not shown as complete', async () => {
  const user = userEvent.setup()
  const bridge = makeBridge({
    pick: vi.fn().mockResolvedValue('/mnt/data/kcoder'),
    preview: vi.fn().mockResolvedValue(plan),
    migrate: vi.fn().mockResolvedValue({ operationId: plan.operationId, state: 'ready' }),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-location-actual-paths')

  await user.click(screen.getByTestId('storage-location-pick-data'))
  await user.click(await screen.findByTestId('storage-location-preview'))
  await screen.findByTestId('storage-location-plan')
  await user.click(screen.getByTestId('storage-location-stop-migrate'))
  expect(screen.getByTestId('storage-location-confirm')).toHaveTextContent('所有窗口')
  expect(bridge.migrate).not.toHaveBeenCalled()

  await user.click(screen.getByTestId('storage-location-confirm-submit'))
  expect(bridge.migrate).toHaveBeenCalledWith({ operationId: plan.operationId })
  expect(await screen.findByTestId('storage-location-handoff-ready')).toHaveTextContent('已就绪')
  expect(screen.queryByText(/已完成核验/)).not.toBeInTheDocument()
})

test('cancelling the native stop confirmation is not presented as an error or completion', async () => {
  const user = userEvent.setup()
  const bridge = makeBridge({
    pick: vi.fn().mockResolvedValue('/mnt/data/kcoder'),
    migrate: vi.fn().mockResolvedValue({ operationId: plan.operationId, state: 'cancelled' }),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)
  await screen.findByTestId('storage-location-actual-paths')

  await user.click(screen.getByTestId('storage-location-pick-data'))
  await user.click(await screen.findByTestId('storage-location-preview'))
  await screen.findByTestId('storage-location-plan')
  await user.click(screen.getByTestId('storage-location-stop-migrate'))
  await user.click(screen.getByTestId('storage-location-confirm-submit'))

  expect(await screen.findByTestId('storage-location-notice')).toHaveTextContent('已取消')
  expect(screen.queryByTestId('storage-location-action-error')).not.toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-handoff-ready')).not.toBeInTheDocument()
})

test('a Deferred receipt waits for explicit confirmation and retries its original operation id', async () => {
  const user = userEvent.setup()
  const bridge = makeBridge({
    read: vi.fn().mockResolvedValue(snapshot({ operation: deferredOperation })),
    retry: vi.fn().mockResolvedValue({ operationId: deferredPlan.operationId, state: 'ready' }),
  })
  installBridge(bridge)
  render(<StorageLocationsPanel />)

  await screen.findByTestId('storage-location-operation')
  expect(screen.getByTestId('storage-location-retry-original')).toBeInTheDocument()
  expect(bridge.preview).not.toHaveBeenCalled()
  expect(bridge.migrate).not.toHaveBeenCalled()
  expect(bridge.retry).not.toHaveBeenCalled()

  await user.click(screen.getByTestId('storage-location-retry-original'))
  expect(await screen.findByTestId('storage-location-confirm')).toBeInTheDocument()
  expect(bridge.preview).not.toHaveBeenCalled()
  expect(bridge.migrate).not.toHaveBeenCalled()
  expect(bridge.retry).not.toHaveBeenCalled()

  await user.click(screen.getByTestId('storage-location-confirm-submit'))
  await waitFor(() => expect(bridge.retry).toHaveBeenCalledExactlyOnceWith({ operationId: deferredPlan.operationId }))
  expect(bridge.migrate).not.toHaveBeenCalled()
  expect(bridge.preview).not.toHaveBeenCalled()
})

test('cancelling an original Deferred retry confirmation does not call retry or migrate', async () => {
  const user = userEvent.setup()
  const bridge = makeBridge({ read: vi.fn().mockResolvedValue(snapshot({ operation: deferredOperation })) })
  installBridge(bridge)
  render(<StorageLocationsPanel />)

  await user.click(await screen.findByTestId('storage-location-retry-original'))
  await user.click(screen.getByTestId('storage-location-confirm-cancel'))

  expect(screen.queryByTestId('storage-location-confirm')).not.toBeInTheDocument()
  expect(bridge.retry).not.toHaveBeenCalled()
  expect(bridge.migrate).not.toHaveBeenCalled()
  expect(bridge.preview).not.toHaveBeenCalled()
})

test('a late Deferred retry result from an old host cannot change the newly loaded host', async () => {
  const user = userEvent.setup()
  let resolveRetry!: (value: { operationId: string; state: 'ready' | 'cancelled' }) => void
  const pendingRetry = new Promise<{ operationId: string; state: 'ready' | 'cancelled' }>(resolve => { resolveRetry = resolve })
  const oldHost = makeBridge({
    read: vi.fn().mockResolvedValue(snapshot({ operation: deferredOperation })),
    retry: vi.fn().mockReturnValue(pendingRetry),
  })
  installBridge(oldHost)
  const oldPanel = render(<StorageLocationsPanel />)
  await user.click(await screen.findByTestId('storage-location-retry-original'))
  await user.click(screen.getByTestId('storage-location-confirm-submit'))
  await waitFor(() => expect(oldHost.retry).toHaveBeenCalledWith({ operationId: deferredPlan.operationId }))

  const newHostPaths = { ...paths, dataRoot: '/new-host/data', cacheRoot: '/new-host/cache' }
  const newHost = makeBridge({ read: vi.fn().mockResolvedValue(snapshot({ paths: newHostPaths })) })
  installBridge(newHost)
  await act(async () => {
    resolveRetry({ operationId: deferredPlan.operationId, state: 'ready' })
  })
  expect(screen.getByTestId('storage-location-path-dataRoot')).toHaveTextContent(paths.dataRoot)
  expect(screen.queryByTestId('storage-location-handoff-ready')).not.toBeInTheDocument()
  expect(screen.queryByTestId('storage-location-notice')).not.toBeInTheDocument()
  expect(oldHost.read).toHaveBeenCalledTimes(1)
  expect(newHost.read).not.toHaveBeenCalled()
  expect(newHost.retry).not.toHaveBeenCalled()

  oldPanel.unmount()
  render(<StorageLocationsPanel />)
  expect(await screen.findByTestId('storage-location-path-dataRoot')).toHaveTextContent('/new-host/data')
  expect(newHost.read).toHaveBeenCalledTimes(1)
})
