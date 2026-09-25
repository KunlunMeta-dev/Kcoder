import { expect, test } from 'vitest'
import {
  argumentFields,
  argumentIssues,
  defaultArguments,
  parseArguments,
} from './workflowArguments'
test('unsupported constraints retain JSON editing rather than silently dropping semantics', () => {
  expect(
    argumentFields({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } })
  ).toBeNull()
  expect(argumentFields({ type: 'object', properties: { a: { type: 'object' } } })).toBeNull()
  expect(argumentFields({ type: 'object', properties: {}, allOf: [] })).toBeNull()
})
test('defaults preserve false and zero; validate required, enum, type, range and Unicode lengths', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['topic'],
    properties: {
      topic: { type: 'string', minLength: 2 },
      count: { type: 'integer', minimum: 0, maximum: 5, default: 0 },
      flag: { type: 'boolean', default: false },
      style: { type: 'string', enum: ['brief'] },
    },
  }
  const fields = argumentFields(schema)
  expect(parseArguments(defaultArguments(fields))).toEqual({ count: 0, flag: false })
  expect(
    argumentIssues(
      fields,
      { topic: '😀', count: 1.5, flag: 'false', style: 'other', extra: 1 },
      schema
    ).map(item => item.reason)
  ).toEqual(['minLength', 'type', 'type', 'enum', 'extra'])
  expect(argumentIssues(fields, { count: 6 }, schema).map(item => item.reason)).toEqual([
    'required',
    'maximum',
  ])
  expect(argumentIssues(fields, { topic: '你好', count: 0, flag: false }, schema)).toEqual([])
})
test('object editing preserves own special property names without mutating prototypes', () => {
  const schema = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string","default":"safe"}}}'
  )
  const args = parseArguments(defaultArguments(argumentFields(schema)))!
  expect(Object.hasOwn(args, '__proto__')).toBe(true)
  expect(args.__proto__).toBe('safe')
  expect(parseArguments('[]')).toBeNull()
})
