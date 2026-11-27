import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtimeSchema } from './runtime-schema.mjs';
import { matchesSchema } from './runtime.mjs';

test('annotation projection preserves property names, literal enum values, recursive refs and real constraints', () => {
  const source = {
    title: 'Documented input', description: 'Kept in public schemas', default: {},
    type: 'object', additionalProperties: false, required: ['title', 'description', 'default'],
    definitions: { bounded: { description: 'Unsigned byte', type: 'integer', format: 'uint8', minimum: 2 } },
    properties: {
      title: { title: 'Title', type: 'string', minLength: 2, pattern: '^OK', 'x-max-utf8-bytes': 8 },
      description: { description: 'Nested array', type: 'array', minItems: 1, maxItems: 2, uniqueItems: true,
        items: { anyOf: [{ $ref: '#/definitions/bounded' }, { type: 'null' }] } },
      default: { default: 'literal', enum: ['title', 'description', 'default'] },
      extras: { type: 'object', additionalProperties: { title: 'Value', allOf: [{ type: 'string', maxLength: 3 }] } },
      exclusive: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
    },
  };
  const before = JSON.stringify(source), projected = runtimeSchema(source);
  assert.equal(projected.title, undefined);
  assert.deepEqual(Object.keys(projected.properties), Object.keys(source.properties));
  assert.deepEqual(projected.properties.default.enum, ['title', 'description', 'default']);
  const valid = { title: 'OK', description: [2, null], default: 'title', extras: { title: 'abc' }, exclusive: 1 };
  for (const [value, accepted] of [[valid, true],
    [{ ...valid, description: [256] }, false], [{ ...valid, description: [2, 2] }, false],
    [{ ...valid, title: 'bad' }, false], [{ ...valid, title: 'OK-longer-than-eight' }, false],
    [{ ...valid, extras: { title: 'abcd' } }, false], [{ ...valid, exclusive: true }, false],
    [{ ...valid, unknown: true }, false], [{ ...valid, default: 'other' }, false]]) {
    assert.equal(matchesSchema(source, value), accepted);
    assert.equal(matchesSchema(projected, value), accepted);
  }
  assert.equal(JSON.stringify(source), before);
  assert.equal(runtimeSchema(true), true); assert.equal(runtimeSchema(false), false);
});

const generated = readFileSync(new URL('../../apps/kcoder-studio/shared/generated/validator.mjs', import.meta.url), 'utf8');
const prefix = '\nconst schemas = ', suffix = ';\nexport function isContract';
const start = generated.indexOf(prefix), end = generated.indexOf(suffix, start);
assert.ok(start >= 0 && end > start, 'generated validator exposes its schema literal before the public dispatcher');
const schemas = JSON.parse(generated.slice(start + prefix.length, end));

test('shipping runtime schemas omit documentation annotations', () => {
  let annotations = 0;
  const visit = schema => {
    if (typeof schema === 'boolean') return;
    for (const name of ['$schema', 'title', 'description', 'default', 'x-known-values', 'x-error-codes', 'x-stderr-prefix'])
      if (Object.hasOwn(schema, name)) annotations++;
    for (const child of Object.values(schema.properties ?? {})) visit(child);
    for (const child of Object.values(schema.definitions ?? {})) visit(child);
    for (const keyword of ['anyOf', 'allOf', 'oneOf']) for (const child of schema[keyword] ?? []) visit(child);
    if (schema.items !== undefined) visit(schema.items);
    if (typeof schema.additionalProperties === 'object') visit(schema.additionalProperties);
  };
  for (const schema of Object.values(schemas)) visit(schema);
  assert.equal(annotations, 0);
});
