// Native Windows protocol/UI recovery assertions. Fixed tool selection is not a
// model-quality claim; all input stays inside the run's full-screen fixture.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitFor } from '../../../../e2e/harness/run-context.mjs'
import { requestOwnedPageRpc } from '../../../../e2e/harness/owned-page-rpc.mjs'

export function createOwnedDesktopModel(getDesktop, { tailOnly = false } = {}) {
  const calls = []
  let initialStage = 0
  let recoveryStage = 0
  let continuationStage = 0
  let revokedStage = 0
  const call = (name, args, recovery) => {
    calls.push({ name, recovery })
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `owned-${calls.length}`,
      type: 'function', function: { name: `mcp__kcoder_computer_use__${name}`, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' }]
  }
  const respond = ({ body }) => {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const userText = messages.filter(message => message.role === 'user' && typeof message.content === 'string')
    const prompt = userText.at(-1)?.content ?? ''
    if (prompt.startsWith('P11_POST_RECOVERY_UI')) {
      const desktop = getDesktop()
      assert.ok(desktop?.fullViewIsolated)
      if (continuationStage++ === 0) return call('Screenshot', {}, false)
      if (continuationStage === 2) return call('Type', { loc: desktop.inputLoc, text: 'P11_FRESH_INPUT', clear: true }, false)
      if (continuationStage === 3) return call('Click', { loc: desktop.buttonLoc }, false)
      return [{ delta: { content: 'P11_FRESH_INPUT_CONFIRMED' }, finishReason: 'stop' }]
    }
    if (prompt.startsWith('P11_REVOKED_UI')) {
      assert.equal((body.tools ?? []).some(tool => tool.function?.name?.startsWith('mcp__kcoder_computer_use__')), false)
      if (revokedStage++ === 0) return call('Type', { loc: getDesktop().inputLoc, text: 'P11_REVOKED_MUST_NOT_APPEAR', clear: true }, false)
      const result = messages.filter(message => message.role === 'tool').at(-1)
      assert.match(JSON.stringify(result), /unknown|not found|not available|not registered|unavailable|未找到|不存在|无法找到/i)
      return [{ delta: { content: 'P11_REVOKED_INPUT_REFUSED' }, finishReason: 'stop' }]
    }
    const recovery = prompt.startsWith('Recover desktop control safely.')
    if (recovery) {
      const desktopTools = body.tools.map(tool => tool.function?.name).filter(name => name?.startsWith('mcp__kcoder_computer_use__'))
      assert.deepEqual(desktopTools.slice().sort(), ['DisplayInventory', 'Screenshot', 'Snapshot'].map(name => `mcp__kcoder_computer_use__${name}`).sort())
      if (recoveryStage++ === 0) return call('Screenshot', {}, true)
      return [{ delta: { content: 'P11_RECOVERY_OBSERVED' }, finishReason: 'stop' }]
    }
    if (!JSON.stringify(messages).includes('OWNED_DESKTOP_UI')) return [{ delta: { content: 'fixture' }, finishReason: 'stop' }]
    const desktop = getDesktop()
    assert.ok(desktop?.fullViewIsolated, 'full desktop must be covered before any native observation')
    if (initialStage === 0) { initialStage++; return call('Screenshot', {}, false) }
    if (initialStage === 1) { initialStage++; return call('Type', { loc: desktop.inputLoc, text: 'P11_OWNED_INPUT', clear: true }, false) }
    if (initialStage === 2) { initialStage++; return call('Click', { loc: desktop.buttonLoc }, false) }
    if (tailOnly) return [{ delta: { content: 'DESKTOP_IMAGE_RECEIVED P11_INPUT_CONFIRMED' }, finishReason: 'stop' }]
    return [{ delta: { content: 'DESKTOP_IMAGE_RECEIVED P11_INPUT_CONFIRMED' } }, { ready: () => false, finishReason: 'stop' }]
  }
  return { calls, respond }
}

export async function verifyOwnedDesktopRecovery({ context, page, status, lifecycle, model, packageRoot, fixtureOutput, powershell, env, workspace }) {
  const input = await waitFor(async () => {
    try { return JSON.parse((await readFile(join(fixtureOutput, 'input-result.json'), 'utf8')).replace(/^\uFEFF/, '')) }
    catch { return null }
  }, 15000, 'owned native input receipt')
  assert.deepEqual(input, { text: 'P11_OWNED_INPUT', clicked: true, clickCount: 1 })
  const identity = await waitFor(() => lifecycle.slice().reverse().find(value => value.state === 'active' && Number.isSafeInteger(value.workerPid) && Number.isSafeInteger(value.hostPid)), 10000, 'owned worker identity')
  assert.ok(identity.threadId, 'actual owner thread is required for foreign-client rejection')
  const foreign = await requestOwnedPageRpc(page, { workspace, requests: [
    { method: 'computerUse/recover', params: { threadId: identity.threadId, previousTurnId: identity.turnId } },
    { method: 'computerUse/revoke', params: { threadId: identity.threadId } },
  ] })
  assert.deepEqual(foreign.map(frame => frame.error?.code), [-32023, -32023])
  const componentRoot = (join(packageRoot, 'resources/computer-use') + '\\').replace(/'/g, "''")
  // Check both the retained host lineage and the unique owned package path
  // before terminating this exact worker; never kill by process name or glob.
  const script = `$ErrorActionPreference='Stop';$process=Get-Process -Id ${identity.workerPid} -ErrorAction Stop;$null=$process.Handle;$worker=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.workerPid}';$workerPath=[string]$worker.ExecutablePath;$verbatim=[string]([char]92)+[char]92+'?'+[char]92;if($workerPath.StartsWith($verbatim,[StringComparison]::Ordinal)){$workerPath=$workerPath.Substring(4)};if(!$worker -or $worker.ParentProcessId -ne ${identity.hostPid} -or !$workerPath.StartsWith('${componentRoot}',[StringComparison]::OrdinalIgnoreCase)){throw 'owned worker identity mismatch'};[PSCustomObject]@{workerPid=$worker.ProcessId;parentPid=$worker.ParentProcessId;hostPid=${identity.hostPid};workerSource=$workerPath;processHandleRetained=$true;ownedPackageSourceMatched=$true}|ConvertTo-Json -Compress;$process.Kill();$process.WaitForExit()`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const fault = context.spawnOwned('desktop-worker-fault', powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env })
  let lineageOutput = ''
  fault.stdout.on('data', data => { lineageOutput = (lineageOutput + data).slice(-8192) })
  await waitFor(() => fault.exitCode !== null, 10000, 'owned worker fault process')
  assert.equal(fault.exitCode, 0)
  await context.writeArtifactJson('native-worker-lineage.json', JSON.parse(lineageOutput.trim()))
  await waitFor(async () => (await status.getAttribute('data-state')) !== 'active', 20000, 'native worker exit state')
  assert.match(await page.getByTestId('computer-use-authorization').innerText(), /会话授权有效|Session authorization valid/)
  await page.getByTestId('computer-use-recover').waitFor({ timeout: 30000 })
  await page.getByTestId('computer-use-recover').click()
  assert.equal(await page.getByTestId('computer-use-approval').count(), 0, 'valid original grant must not prompt again')
  await page.getByTestId('desktop-chat-scroll-content').getByText('P11_RECOVERY_OBSERVED', { exact: true }).waitFor({ timeout: 90000 })
  await waitFor(() => lifecycle.some(value => value.state === 'stopped' && value.turnId !== identity.turnId && value.cleanup === 'confirmed'), 30000, 'replacement cleanup receipt')
  const after = JSON.parse((await readFile(join(fixtureOutput, 'input-result.json'), 'utf8')).replace(/^\uFEFF/, ''))
  assert.deepEqual(after, input, 'recovery must not repeat native input or clicks')
  assert.deepEqual(model.calls.filter(value => value.recovery).map(value => value.name), ['Screenshot'])
  assert.equal(model.calls.filter(value => value.name === 'Type').length, 1)
  assert.equal(model.calls.filter(value => value.name === 'Click').length, 1)
  await page.getByTestId('chat-message-input').fill('P11_POST_RECOVERY_UI: send fresh input only to the owned fixture')
  await page.getByTestId('send-message-button').click()
  assert.equal(await page.getByTestId('computer-use-approval').count(), 0)
  await page.getByTestId('desktop-chat-scroll-content').getByText('P11_FRESH_INPUT_CONFIRMED', { exact: true }).waitFor({ timeout: 90000 })
  const fresh = JSON.parse((await readFile(join(fixtureOutput, 'input-result.json'), 'utf8')).replace(/^\uFEFF/, ''))
  assert.deepEqual(fresh, { text: 'P11_FRESH_INPUT', clicked: true, clickCount: 2 })
  assert.equal(model.calls.filter(value => value.name === 'Screenshot').length, 3)
  assert.equal(model.calls.filter(value => value.name === 'Type').length, 2)
  assert.equal(model.calls.filter(value => value.name === 'Click').length, 2)
  await page.getByTestId('computer-use-submit').click()
  await waitFor(async () => /已撤销|revoked/.test(await page.getByTestId('computer-use-authorization').innerText()), 10000, 'host grant revocation')
  assert.equal(await page.getByTestId('computer-use-recover').count(), 0)
  await page.getByTestId('chat-message-input').fill('P11_REVOKED_UI: refuse desktop input after revocation')
  await page.getByTestId('send-message-button').click()
  await page.getByTestId('desktop-chat-scroll-content').getByText('P11_REVOKED_INPUT_REFUSED', { exact: true }).waitFor({ timeout: 90000 })
  const revokedReceipt = JSON.parse((await readFile(join(fixtureOutput, 'input-result.json'), 'utf8')).replace(/^\uFEFF/, ''))
  assert.deepEqual(revokedReceipt, fresh, 'revocation must prevent the deliberately fresh input attempt')
  return { nativeInputOnce: true, workerExitObserved: true, recoveredWithOriginalGrant: true, observationOnly: true, inputNotReplayed: true, freshInputAfterRecovery: true, foreignOwnerRejected: true, revokePreventsRecovery: true, revokedInputRefused: true }
}

// Narrow final clear/revoke check; no worker fault, foreign owner or recovery.
export async function verifyOwnedDesktopClearRevokeTail({ context, page, model, fixtureOutput }) {
  const input = JSON.parse((await readFile(join(fixtureOutput, 'input-result.json'), 'utf8')).replace(/^\uFEFF/, ''))
  assert.deepEqual(input, { text: 'P11_OWNED_INPUT', clicked: true, clickCount: 1 })
  await page.getByTestId('chat-message-input').fill('P11_POST_RECOVERY_UI: send fresh input only to the owned fixture')
  await page.getByTestId('send-message-button').click()
  assert.equal(await page.getByTestId('computer-use-approval').count(), 0)
  await page.getByTestId('desktop-chat-scroll-content').getByText('P11_FRESH_INPUT_CONFIRMED', { exact: true }).waitFor({ timeout: 90000 })
  const fresh = JSON.parse((await readFile(join(fixtureOutput, 'input-result.json'), 'utf8')).replace(/^\uFEFF/, ''))
  assert.deepEqual(fresh, { text: 'P11_FRESH_INPUT', clicked: true, clickCount: 2 })
  assert.equal(model.calls.filter(value => value.name === 'Screenshot').length, 2)
  assert.equal(model.calls.filter(value => value.name === 'Type').length, 2)
  assert.equal(model.calls.filter(value => value.name === 'Click').length, 2)
  await page.getByTestId('computer-use-submit').click()
  await waitFor(async () => /已撤销|revoked/.test(await page.getByTestId('computer-use-authorization').innerText()), 10000, 'host grant revocation')
  assert.equal(await page.getByTestId('computer-use-recover').count(), 0)
  await page.getByTestId('chat-message-input').fill('P11_REVOKED_UI: refuse desktop input after revocation')
  await page.getByTestId('send-message-button').click()
  await page.getByTestId('desktop-chat-scroll-content').getByText('P11_REVOKED_INPUT_REFUSED', { exact: true }).waitFor({ timeout: 90000 })
  const revokedReceipt = JSON.parse((await readFile(join(fixtureOutput, 'input-result.json'), 'utf8')).replace(/^\uFEFF/, ''))
  assert.deepEqual(revokedReceipt, fresh, 'revocation must prevent the deliberately fresh input attempt')
  await context.writeArtifactJson('native-clear-revoke-receipts.json', { initial: input, fresh, afterRevocation: revokedReceipt })
  return { nativeClearExactFreshReceipt: true, revokePreventsRecovery: true, revokedInputRefused: true, repeatedFaultForeignRecovery: false }
}
