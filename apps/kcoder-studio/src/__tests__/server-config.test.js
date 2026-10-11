import assert from 'node:assert/strict'
import test from 'node:test'
import { storedServer, stripWindowsNamespace, normalizeServerEntryForSave } from '../server-config.js'

// The desktop host persists entries with
// `JSON.stringify(values.map(storedServer))`, so this pins the serialized form
// the store will contain after the next save.
test('persisted server JSON never carries a verbatim workspace path', () => {
  const serialized = JSON.stringify(
    storedServer({
      id: 'local',
      label: 'Windows',
      description: '本机 KCoder app-server',
      runtime: 'kcoder',
      transport: 'local',
      command: 'kcoder',
      cwd: '\\\\?\\C:\\Users\\x\\proj',
    })
  )
  const persisted = JSON.parse(serialized)
  assert.equal(persisted.workspace, 'C:\\Users\\x\\proj')
  assert.equal(persisted.workspace.includes('\\\\?\\'), false)
})

test('UNC workspaces keep their share root when the namespace is stripped', () => {
  assert.equal(stripWindowsNamespace('\\\\?\\UNC\\server\\share\\proj'), '\\\\server\\share\\proj')
  assert.equal(
    normalizeServerEntryForSave({ remoteCwd: '\\\\?\\UNC\\server\\share\\proj' }).remoteCwd,
    '\\\\server\\share\\proj'
  )
})