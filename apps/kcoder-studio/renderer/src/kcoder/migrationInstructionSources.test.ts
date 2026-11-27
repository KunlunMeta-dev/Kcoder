import { describe, expect, it, vi } from 'vitest'
import { InstructionSourcesController } from '../../../shared/migrationInstructionSources'
import { InstructionPreviewController } from '../../../shared/migrationInstructionPreview'
import { canonicalInstructionMappings, instructionMappingsSignature, validInstructionMappings } from '../../../shared/migrationInstructionMappings'
import type * as C from '../../../shared/generated/contracts'

const id = 'bdaeb662-a7fe-4412-974c-18c4f9e78005'
const input = { source: 'claude-code', format: 'static_v2', sourceRoot: '/owned/source', sourceCwd: '/owned/source/project', confirmStaticSubset: true } as const
const target = { kind: 'source', captureId: id } as const
const row: C.MigrationInstructionItem = { itemId: 'instruction-owned', displayName: 'CLAUDE.md', source: 'claude-code', scoped: true, formatRevision: 'scoped-instructions/v2', sourceRevision: 'a'.repeat(64), relativePath: 'CLAUDE.md', relativeScope: '', role: 'shared', trigger: 'launch', disposition: 'selected', bytes: 5, completeAuthorizedStaticChain: true, reasonCode: null }
const page: C.MigrationInstructionPageResult = { target, pageIndex: 0, items: [row], totalItems: 1, nextPage: null }
const capture: C.MigrationInstructionCaptureResult = { captureId: id, source: 'claude-code', formatRevision: 'scoped-instructions/v2', sourceRevision: 'a'.repeat(64), totalItems: 1, completeAuthorizedStaticChain: true, dynamicScopePresent: false, remainingMs: 600000 }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const api = { open: vi.fn().mockResolvedValue({ status: 'ready', launching: false, ownedChildren: 1 }), close: vi.fn().mockResolvedValue({ status: 'released' }),
    instructionsCapture: vi.fn().mockResolvedValue(capture), instructionsPage: vi.fn().mockResolvedValue(page), instructionsBody: vi.fn() }
  let current = true
  const controller = new InstructionSourcesController({ targetId: 'owned-source', api, cleanup: api, newId: () => id, isCurrent: () => current })
  return { api, controller, switchScope: () => { current = false } }
}

describe('explicit instruction capture ownership and recovery', () => {
  it('observes a lost capture acknowledgement with the same original source handle and never repeats capture', async () => {
    const f = fixture()
    f.api.instructionsCapture.mockRejectedValueOnce(Object.assign(new Error('lost'), { code: 'source_transfer_outcome_unknown' }))
    await f.controller.capture(input)
    expect(f.controller.snapshot().intent?.captureId).toBe(id)
    expect(f.controller.snapshot().page).toBeNull()
    await f.controller.observe()
    expect(f.controller.snapshot().page).toEqual(page)
    expect(f.api.instructionsCapture).toHaveBeenCalledTimes(1)
    expect(f.api.instructionsPage).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'owned-source', workspacePath: input.sourceCwd }), { captureId: id, pageIndex: 0 })
    await f.controller.capture({ ...input, sourceRoot: '/different' })
    expect(f.api.instructionsCapture).toHaveBeenCalledTimes(1)
    expect(f.controller.snapshot().error).toBe('source_transfer_instruction_capture_fixed')
  })
  it('never paints a late source capture after account switch and closes only its original child', async () => {
    const f = fixture(), pending = deferred<C.MigrationInstructionCaptureResult>()
    f.api.instructionsCapture.mockReturnValue(pending.promise)
    const work = f.controller.capture(input)
    await vi.waitFor(() => expect(f.api.instructionsCapture).toHaveBeenCalledTimes(1))
    f.switchScope(); f.controller.dispose(); pending.resolve(capture)
    await work
    expect(f.controller.snapshot().capture).toBeNull()
    expect(f.api.close.mock.calls.every(([session]) => session.sessionId === id && session.targetId === 'owned-source')).toBe(true)
    expect(f.api.instructionsPage).not.toHaveBeenCalled()
  })
  it('reactivation ignores a pending old capture and clears the stale busy gate without fabricating completion', async () => {
    const f = fixture(), pending = deferred<C.MigrationInstructionCaptureResult>()
    f.api.instructionsCapture.mockReturnValue(pending.promise)
    const work = f.controller.capture(input)
    await vi.waitFor(() => expect(f.api.instructionsCapture).toHaveBeenCalledTimes(1))
    f.controller.dispose(); f.controller.activate(); pending.resolve(capture)
    await work
    expect(f.controller.snapshot().busy).toBe(false)
    expect(f.controller.snapshot().capture).toBeNull()
    expect(f.controller.snapshot().intent?.captureId).toBe(id)
    expect(f.controller.snapshot().error).toBe('source_transfer_authority_changed')
  })
  it('successful explicit close returns a clean idle state without reporting an authority failure', async () => {
    const f = fixture()
    await f.controller.capture(input); await f.controller.close()
    expect(f.controller.snapshot()).toMatchObject({ busy: false, session: null, intent: null, page: null, error: null })
  })
})

it('saved/received preview rejects a late old lifecycle result after dispose and reactivation', async () => {
  const pending = deferred<C.MigrationInstructionPageResult>()
  const api = { instructionPage: vi.fn().mockReturnValue(pending.promise), instructionBody: vi.fn() }
  const controller = new InstructionPreviewController(api, target, () => true)
  const work = controller.load()
  controller.dispose(); controller.activate(); pending.resolve(page); await work
  expect(controller.snapshot()).toMatchObject({ busy: false, page: null, error: null })
  api.instructionPage.mockResolvedValue(page); await controller.load()
  expect(controller.snapshot().page).toEqual(page)
})

it('a newly activated read can finish while an old lifecycle read is still pending', async () => {
  const pending = deferred<C.MigrationInstructionPageResult>()
  const api = { instructionPage: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(page), instructionBody: vi.fn() }
  const controller = new InstructionPreviewController(api, target, () => true)
  const old = controller.load()
  controller.dispose(); controller.activate()
  await controller.load()
  expect(controller.snapshot()).toMatchObject({ busy: false, page })
  pending.resolve({ ...page, items: [], totalItems: 0 }); await old
  expect(controller.snapshot()).toMatchObject({ busy: false, page })
})

it('per-item mappings require workspace selection, distinguish changed scopes, and keep empty identity unchanged', () => {
  const selections = [{ entryId: 'e0000-0000', projectMapping: 'current_workspace' as const }]
  const mapping = { entryId: 'e0000-0000', items: [{ itemId: 'instruction-b', targetRelativeScope: 'child' }, { itemId: 'instruction-a', targetRelativeScope: '' }] }
  expect(instructionMappingsSignature()).toBe('')
  expect(instructionMappingsSignature([])).toBe('')
  expect(validInstructionMappings([mapping], selections)).toBe(true)
  expect(validInstructionMappings([mapping], [{ entryId: 'e0000-0000' }])).toBe(false)
  expect(validInstructionMappings([{ ...mapping, items: [{ itemId: 'a', targetRelativeScope: '../outside' }] }], selections)).toBe(false)
  expect(validInstructionMappings([{ ...mapping, items: [mapping.items[0], mapping.items[0]] }], selections)).toBe(false)
  const reverse = { ...mapping, items: [...mapping.items].reverse(), archiveIncompleteChain: false }
  expect(instructionMappingsSignature([mapping])).toBe(instructionMappingsSignature([reverse]))
  expect(canonicalInstructionMappings([mapping])[0].items[0].itemId).toBe('instruction-a')
  expect(instructionMappingsSignature([mapping])).not.toBe(instructionMappingsSignature([{ ...mapping, archiveIncompleteChain: true }]))
  expect(instructionMappingsSignature([mapping])).not.toBe(instructionMappingsSignature([{ ...mapping, items: [{ itemId: 'instruction-a', targetRelativeScope: 'other' }] }]))
})
