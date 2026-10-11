import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnedDesktopModel } from './scenarios/computer-use-recovery.scenario.mjs'
const names = ['DisplayInventory', 'Screenshot', 'Snapshot'].map(name => ({ function: { name: `mcp__kcoder_computer_use__${name}` } }))
const body = prompt => ({ messages: [{ role: 'user', content: prompt }], tools: names })

test('native fixture refuses observation until its complete desktop cover is confirmed', () => {
  const model = createOwnedDesktopModel(() => ({ fullViewIsolated: false }))
  assert.throws(() => model.respond({ body: body('OWNED_DESKTOP_UI') }), /full desktop must be covered/)
  assert.equal(model.calls.length, 0)
})

test('native recovery fixture requests one full observation and never replays initial input', () => {
  const model = createOwnedDesktopModel(() => ({ fullViewIsolated: true, inputLoc: [10, 10], buttonLoc: [20, 20] }))
  for (let count = 0; count < 3; count++) model.respond({ body: body('OWNED_DESKTOP_UI') })
  const first = model.respond({ body: body('Recover desktop control safely. Observe only.') })
  assert.deepEqual(JSON.parse(first[0].delta.tool_calls[0].function.arguments), {})
  const completed = model.respond({ body: body('Recover desktop control safely. Observe only.') })
  assert.equal(completed[0].delta.content, 'P11_RECOVERY_OBSERVED')
  assert.deepEqual(model.calls, [
    { name: 'Screenshot', recovery: false }, { name: 'Type', recovery: false },
    { name: 'Click', recovery: false }, { name: 'Screenshot', recovery: true },
  ])
  assert.throws(() => model.respond({ body: { ...body('Recover desktop control safely.'), tools: [...names, { function: { name: 'mcp__kcoder_computer_use__Click' } }] } }), /deep-equal/)
})
