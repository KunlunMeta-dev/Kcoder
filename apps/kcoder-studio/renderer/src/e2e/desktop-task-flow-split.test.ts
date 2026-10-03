import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'

const root = resolve(import.meta.dirname, '../../e2e/desktop')
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(resolve(root, name)).href)

describe('desktop task-flow module boundaries', () => {
  test('imports the existing runner without allocating its result directory', async () => {
    const [{ main }, config] = await Promise.all([
      load('task-flow/runner.mjs'),
      load('task-flow/config.mjs'),
    ])
    expect(typeof main).toBe('function')
    expect(config.rendererDir).toBe(resolve(root, '../..'))
    await expect(access(config.resultDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps abort state live across imported helpers and resets it after a run', async () => {
    const runtime = await load('task-flow/runtime.mjs')
    const controller = new AbortController()
    const reason = new Error('owned run cancelled')
    runtime.setOperationSignal(controller.signal)
    controller.abort(reason)
    try {
      await expect(runtime.abortable(Promise.resolve('ignored'))).rejects.toBe(reason)
    } finally {
      runtime.setOperationSignal(undefined)
    }
    await expect(runtime.abortable(Promise.resolve('next operation'))).resolves.toBe(
      'next operation'
    )
  })

  test('retains model protocol methods and closes both ephemeral listener ports', async () => {
    const { DesktopE2EServer } = await load('task-flow/model-server.mjs')
    const { MODEL_API_KEY } = await load('task-flow/config.mjs')
    const server = new DesktopE2EServer('/unused-desktop-unit-workspace')
    let origin: string
    try {
      await server.start()
      origin = server.url
      expect(typeof server.handleModelProtocolMatrixResponse).toBe('function')
      expect(typeof server.writeAnthropicMessage).toBe('function')
      const catalog = await fetch(`${origin}/v1/models`, {
        headers: { authorization: `Bearer ${MODEL_API_KEY}` },
      })
      expect(catalog.status).toBe(200)
      expect(await catalog.json()).toEqual({ models: [] })
      const denied = await fetch(`${origin}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: [] }),
      })
      expect(denied.status).toBe(401)
      expect(server.catalogRequests).toHaveLength(1)
    } finally {
      await server.close()
    }
    await expect(fetch(`${origin}/v1/models`)).rejects.toThrow()
  })

  test('keeps all ordered phases on the original CLI entry path', async () => {
    const entry = await readFile(resolve(root, 'task-flow.e2e.mjs'), 'utf8')
    const runner = await readFile(resolve(root, 'task-flow/runner.mjs'), 'utf8')
    expect(entry).toContain('legacy-task-flow.e2e.mjs')
    expect(entry).toContain('process.exit(0)')
    expect(entry).toContain('process.exit(1)')
    expect([...runner.matchAll(/await (run\w+Phase)\(/g)].map(match => match[1])).toEqual([
      'runSelectionPhase',
      'runProjectsPhase',
      'runInitialTaskPhase',
      'runForksNavigationPhase',
      'runRecoveryPhase',
      'runWorkspaceSessionPhase',
      'runWorkspaceCreationPhase',
    ])
  })
})
