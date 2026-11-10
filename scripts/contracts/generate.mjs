#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { writeGeneratedArtifact } from './artifact-files.mjs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { matchesSchema } from './runtime.mjs';
import { CONTRACT_DOMAINS, splitContractDomains, mergeContractDomains, domainFile } from './domains.mjs';
import { generateTypeDomains, schemaTypeReferences } from './type-domains.mjs';
import { protocolSourceReceipt, validateExporterReceipt } from './source-receipt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'apps/kcoder-studio/shared/generated');
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: generate.mjs [--check]');
const sourceFixtures = mergeContractDomains(Object.fromEntries(CONTRACT_DOMAINS.map(domain => [
  domain, JSON.parse(readFileSync(resolve(root, 'scripts/contracts', domainFile('fixtures', domain)), 'utf8')),
])));
const rust = spawnSync('cargo', ['run', '--locked', '--quiet', '-p', 'kcoder_app_protocol', '--example', 'export_contracts', '--features', 'json-schema'], {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
if (rust.status !== 0) { process.stderr.write(rust.stderr ?? 'Rust exporter failed\n'); process.exit(1); }
const exported = JSON.parse(rust.stdout);
validateExporterReceipt(exported, protocolSourceReceipt(root), sourceFixtures);
const { schemas, fixtures } = exported;
const keywordNames = new Set(['$schema', '$ref', 'title', 'description', 'default', 'format', 'definitions', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'allOf', 'oneOf', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'uniqueItems', 'minItems', 'maxItems', 'x-max-utf8-bytes', 'x-max-opaque-json-weight', 'x-known-values', 'x-error-codes']);
function inspect(schema) {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) if (!keywordNames.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) throw new Error('Invalid string length bound');
  }
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) throw new Error('Inverted array length bounds');
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) throw new Error('Inverted string length bounds');
  if (schema['x-max-utf8-bytes'] !== undefined && (!Number.isSafeInteger(schema['x-max-utf8-bytes']) || schema['x-max-utf8-bytes'] < 0)) throw new Error('Invalid UTF-8 byte limit');
  if (schema['x-max-opaque-json-weight'] !== undefined && (!Number.isSafeInteger(schema['x-max-opaque-json-weight']) || schema['x-max-opaque-json-weight'] < 0)) throw new Error('Invalid opaque JSON weight limit');
  if (schema['x-known-values'] && (!Array.isArray(schema['x-known-values']) || !schema['x-known-values'].every(value => typeof value === 'string'))) throw new Error('Invalid known value metadata');
  if (schema['x-error-codes'] && Object.values(schema['x-error-codes']).some(value => typeof value !== 'string')) throw new Error('Invalid error code metadata');
  if (schema.$ref && !schema.$ref.startsWith('#/definitions/')) throw new Error('Only local schema references are supported');
  if (schema.pattern) new RegExp(schema.pattern, 'u');
  if (schema.format && !['uint', 'uint8', 'uint16', 'uint32', 'uint64', 'int32', 'int64', 'double'].includes(schema.format)) throw new Error(`Unsupported format: ${schema.format}`);
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
        if (fields.length && schema.additionalProperties === true) return `({\n${fields.join('\n')}\n} & Record<string, unknown>)`;
        if (fields.length) throw new Error('Mixed named fields and typed map unsupported');
        return `Record<string, ${ts(schema.additionalProperties)}>`;
      }
      return `{\n${fields.join('\n')}\n}`;
    }
    default: throw new Error(`Unsupported schema type: ${JSON.stringify(schema)}`);
  }
}
const types = new Map();
const typeDependencies = new Map();
const allowed = {};
const knownValues = {};
const errorCodes = {};
for (const [name, schema] of Object.entries(schemas)) {
  inspect(schema);
  for (const [typeName, definition] of [[name, schema], ...Object.entries(schema.definitions ?? {})]) {
    const type = ts(definition);
    if (types.has(typeName) && types.get(typeName) !== type) throw new Error(`Conflicting schema: ${typeName}`);
    types.set(typeName, type);
    typeDependencies.set(typeName, schemaTypeReferences(definition));
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
const partitionedTypes = generateTypeDomains(types, typeDependencies, header);
const guardFiles = Object.fromEntries(Object.entries(splitContractDomains(schemas)).map(([domain, records]) => [
  `contractGuards.${domain}.mjs`,
  `${header}import { isContract } from './validator.mjs';\n\n${Object.keys(records).map(name => `export function is${name}(value) {\n  return isContract(${JSON.stringify(name)}, value);\n}`).join('\n\n')}\n`,
]));
const guardTypes = Object.keys(schemas).map(name => `export function is${name}(value: unknown): value is Contracts.${name};`).join('\n');
const runtime = readFileSync(resolve(root, 'scripts/contracts/runtime.mjs'), 'utf8');
const artifacts = {
  'contracts.ts': `${header}export { allowedFields, knownValues, errorCodes } from './validator.mjs';\nexport * from './contractGuards.mjs';\n\n${partitionedTypes.facade}`,
  ...partitionedTypes.files,
  'contractGuards.mjs': `${header}${CONTRACT_DOMAINS.map(domain => `export * from './contractGuards.${domain}.mjs';`).join('\n')}\n`,
  ...guardFiles,
  'contractGuards.d.mts': `${header}import type * as Contracts from './contracts.js';\n${guardTypes}\n`,
  'validator.mjs': `${header}${runtime}\nconst schemas = ${JSON.stringify(schemas)};\nexport function isContract(name, value) {\n  return Object.hasOwn(schemas, name) && matchesSchema(schemas[name], value);\n}\nexport const allowedFields = ${JSON.stringify(allowed)};\nexport const knownValues = ${JSON.stringify(knownValues)};\nexport const errorCodes = ${JSON.stringify(errorCodes)};\n`,
  'validator.d.mts': `${header}export function isContract(name: string, value: unknown): boolean;\nexport function matchesSchema(schema: unknown, value: unknown, root?: unknown): boolean;\nexport const allowedFields: Readonly<Record<string, readonly string[]>>;\nexport const knownValues: Readonly<Record<string, readonly string[]>>;\nexport const errorCodes: Readonly<Record<string, Readonly<Record<string, string>>>>;\n`,
};
for (const [stem, records] of [
  ['schemas', schemas],
  ['examples', Object.fromEntries(Object.entries(fixtures).map(([name, cases]) => [name, cases.valid]))],
]) {
  for (const [domain, values] of Object.entries(splitContractDomains(records))) {
    artifacts[domainFile(stem, domain)] = JSON.stringify(values, null, 2) + '\n';
  }
}
if (!check) mkdirSync(output, { recursive: true });
for (const [name, content] of Object.entries(artifacts)) {
  const path = resolve(output, name);
  if (check) {
    let existing;
    try { existing = readFileSync(path, 'utf8'); } catch { throw new Error(`Missing generated file: ${name}`); }
    if (existing !== content) throw new Error(`Generated contract drift: ${name}; run node scripts/contracts/generate.mjs`);
  } else writeGeneratedArtifact(path, content);
}
console.log(`${check ? 'Checked' : 'Generated'} ${Object.keys(schemas).length} Rust contracts and shared compatibility examples.`);
