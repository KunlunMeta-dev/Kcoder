import test from 'node:test'
import assert from 'node:assert/strict'
import { waitOwnedDesktopControllersStopped } from './owned-desktop-cleanup.mjs'

for (const exitCode of [0, 1]) {
  test(`native controller retirement requires actual probe exit ${exitCode}`, async () => {
    let spawned
    const invoke = waitOwnedDesktopControllersStopped({ packageRoot: '/owned/package', powershell: '/system/powershell', env: {},
      context: { spawnOwned: (...args) => { spawned = args; return { exitCode } } } })
    if (exitCode === 0) assert.equal(await invoke, true)
    else await assert.rejects(invoke, /opaque fixture cannot close/)
    assert.equal(spawned[0], 'desktop-controller-cleanup-check')
    const script = Buffer.from(spawned[2].at(-1), 'base64').toString('utf16le')
    assert.match(script, /Get-CimInstance Win32_Process/)
    assert.doesNotMatch(script, /taskkill|Stop-Process|\.Kill\(/)
  })
}
