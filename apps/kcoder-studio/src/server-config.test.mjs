import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeServerEntryForSave,
  publicServer,
  storedServer,
  stripWindowsNamespace,
} from './server-config.js'

test('stripWindowsNamespace removes verbatim prefixes and keeps UNC share form', () => {
  assert.equal(stripWindowsNamespace('\\\\?\\C:\\Users\\x\\proj'), 'C:\\Users\\x\\proj')
  assert.equal(stripWindowsNamespace('\\\\?\\UNC\\server\\share\\proj'), '\\\\server\\share\\proj')
  assert.equal(stripWindowsNamespace('C:\\Users\\x\\proj'), 'C:\\Users\\x\\proj')
  assert.equal(stripWindowsNamespace('/home/x/proj'), '/home/x/proj')
})

test('publicServer reports a workspacePath without the Windows namespace', () => {
  assert.equal(
    publicServer({
      id: 'local',
      label: '本机',
      description: '本机 KCoder app-server',
      runtime: 'kcoder',
      transport: 'local',
      command: 'kcoder',
      cwd: '\\\\?\\C:\\Users\\x\\proj',
    }).workspacePath,
    'C:\\Users\\x\\proj'
  )
})

test('saved server entries never persist verbatim paths', () => {
  const saved = normalizeServerEntryForSave({ cwd: '\\\\?\\C:\\Users\\x\\proj' })
  assert.equal(saved.cwd, 'C:\\Users\\x\\proj')
  const stored = normalizeServerEntryForSave({
    workspace: '\\\\?\\C:\\Users\\x\\proj',
    host: 'build-01',
  })
  assert.equal(stored.workspace, 'C:\\Users\\x\\proj')
  assert.equal(stored.host, 'build-01')
})

test('storedServer normalizes the workspace path the host serializes to disk', () => {
  const persisted = storedServer({
    id: 'local',
    label: 'Windows',
    description: '本机 KCoder app-server',
    runtime: 'kcoder',
    transport: 'local',
    command: 'kcoder',
    cwd: '\\\\?\\C:\\Users\\x\\proj',
  })
  assert.equal(persisted.workspace, 'C:\\Users\\x\\proj')
})