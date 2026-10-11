#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { matchesSchema } from './runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'apps/kcoder-studio/shared/generated');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: generate.mjs [--check]');
const rust = spawnSync('cargo', ['run', '--locked', '--quiet', '-p', 'kcoder_app_protocol', '--example', 'export_contracts', '--features', 'json-schema'], {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
if (rust.status !== 0) { process.stderr.write(rust.stderr ?? 'Rust exporter failed\n'); process.exit(1); }
const { schemas, fixtures } = JSON.parse(rust.stdout);
const keywordNames = new Set(['$schema', '$ref', 'title', 'description', 'default', 'format', 'definitions', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'allOf', 'oneOf', 'minimum', 'maximum', 'pattern', 'uniqueItems', 'x-max-utf8-bytes', 'x-known-values', 'x-error-codes']);
function inspect(schema) {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) if (!keywordNames.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (schema['x-max-utf8-bytes'] !== undefined && (!Number.isSafeInteger(schema['x-max-utf8-bytes']) || schema['x-max-utf8-bytes'] < 0)) throw new Error('Invalid UTF-8 byte limit');
  if (schema['x-known-values'] && (!Array.isArray(schema['x-known-values']) || !schema['x-known-values'].every(value => typeof value === 'string'))) throw new Error('Invalid known value metadata');
  if (schema['x-error-codes'] && Object.values(schema['x-error-codes']).some(value => typeof value !== 'string')) throw new Error('Invalid error code metadata');
  if (schema.$ref && !schema.$ref.startsWith('#/definitions/')) throw new Error('Only local schema references are supported');
  if (schema.pattern) new RegExp(schema.pattern, 'u');
  if (schema.format && !['uint', 'uint8', 'uint32', 'uint64', 'int64'].includes(schema.format)) throw new Error(`Unsupported format: ${schema.format}`);
  for (const value of Object.values(schema.definitions ?? {})) inspect(value);
  for (const value of Object.values(schema.properties ?? {})) inspect(value);
  if (schema.items) { if (Array.isArray(schema.items)) throw new Error('Tuple schema unsupported'); inspect(schema.items); }
  if (typeof schema.additionalProperties === 'object') inspect(schema.additionalProperties);
  for (const kind of ['anyOf', 'allOf', 'oneOf']) for (const part of schema[kind] ?? []) inspect(part);
}
function ts(schema) {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (schema.$ref) return schema.$ref.split('/').at(-1);
  for (const kind of ['anyOf', 'oneOf', 'allOf']) if (schema[kind]) return `(${schema[kind].map(ts).join(kind === 'allOf' ? ' & ' : ' | ')})`;
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map(type => ts({ ...schema, type })).join(' | ');
  switch (schema.type) {
    case 'string': return 'string';
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return `Array<${ts(schema.items ?? true)}>`;
    case 'object': {
      const fields = Object.entries(schema.properties ?? {}).map(([name, property]) => `  ${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${ts(property)};`);
      if (schema.additionalProperties && schema.additionalProperties !== false) {
        if (fields.length) throw new Error('Mixed named fields and map unsupported');
        return `Record<string, ${ts(schema.additionalProperties)}>`;
      }
      return `{\n${fields.join('\n')}\n}`;
    }
    default: throw new Error(`Unsupported schema type: ${JSON.stringify(schema)}`);
  }
}
const types = new Map();
const allowed = {};
const knownValues = {};
const errorCodes = {};
for (const [name, schema] of Object.entries(schemas)) {
  inspect(schema);
  for (const [typeName, definition] of [[name, schema], ...Object.entries(schema.definitions ?? {})]) {
    const type = ts(definition);
    if (types.has(typeName) && types.get(typeName) !== type) throw new Error(`Conflicting schema: ${typeName}`);
    types.set(typeName, type);
    if (definition['x-known-values'] ?? definition.enum) knownValues[typeName] = definition['x-known-values'] ?? definition.enum;
    if (definition['x-error-codes']) {
      errorCodes[typeName] = definition['x-error-codes'];
      types.set(`${typeName}ErrorCode`, [...new Set(Object.values(definition['x-error-codes']))].sort().map(value => JSON.stringify(value)).join(' | '));
    }
    if (definition.properties) allowed[typeName] = Object.keys(definition.properties).sort();
  }
  for (const [kind, expected] of [['valid', true], ['invalid', false]]) {
    for (const fixture of fixtures[name][kind]) {
      if (matchesSchema(schema, fixture.value) !== expected) throw new Error(`Rust/JS incompatibility: ${name}/${fixture.name}`);
      if (expected && !matchesSchema(schema, fixture.decoded)) throw new Error(`Rust serialization/JS incompatibility: ${name}/${fixture.name}`);
    }
  }
}
const header = '// Generated by scripts/contracts/generate.mjs from Rust serde/schemars. Do not edit.\n';
const orderedTypes = [...types].sort(([a], [b]) => a.localeCompare(b));
const declarations = orderedTypes.map(([name, type]) => `export type ${name} = ${type};`).join('\n\n');
const guards = Object.keys(schemas).map(name => `export function is${name}(value: unknown): value is ${name} {\n  return isContract(${JSON.stringify(name)}, value);\n}`).join('\n\n');
const runtime = readFileSync(resolve(root, 'scripts/contracts/runtime.mjs'), 'utf8');
const artifacts = {
  'contracts.ts': `${header}import { isContract } from './validator.mjs';\nexport { allowedFields, knownValues, errorCodes } from './validator.mjs';\n\n${declarations}\n\n${guards}\n`,
  'validator.mjs': `${header}${runtime}\nconst schemas = ${JSON.stringify(schemas)};\nexport function isContract(name, value) {\n  return Object.hasOwn(schemas, name) && matchesSchema(schemas[name], value);\n}\nexport const allowedFields = ${JSON.stringify(allowed)};\nexport const knownValues = ${JSON.stringify(knownValues)};\nexport const errorCodes = ${JSON.stringify(errorCodes)};\n`,
  'validator.d.mts': `${header}export function isContract(name: string, value: unknown): boolean;\nexport function matchesSchema(schema: unknown, value: unknown, root?: unknown): boolean;\nexport const allowedFields: Readonly<Record<string, readonly string[]>>;\nexport const knownValues: Readonly<Record<string, readonly string[]>>;\nexport const errorCodes: Readonly<Record<string, Readonly<Record<string, string>>>>;\n`,
  'schemas.json': JSON.stringify(schemas, null, 2) + '\n',
  'examples.json': JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([name, cases]) => [name, cases.valid])), null, 2) + '\n',
};
if (!check) mkdirSync(output, { recursive: true });
for (const [name, content] of Object.entries(artifacts)) {
  const path = resolve(output, name);
  if (check) {
    let existing;
    try { existing = readFileSync(path, 'utf8'); } catch { throw new Error(`Missing generated file: ${name}`); }
    if (existing !== content) throw new Error(`Generated contract drift: ${name}; run node scripts/contracts/generate.mjs`);
  } else writeFileSync(path, content);
}
console.log(`${check ? 'Checked' : 'Generated'} ${Object.keys(schemas).length} Rust contracts and shared compatibility examples.`);
