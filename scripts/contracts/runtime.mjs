// Small Draft-07 evaluator for the reviewed public contract schemas. Unsupported
// schema keywords are rejected by the generator before this runtime is emitted.
export function matchesSchema(schema, value, root = schema) {
  if (typeof schema === 'boolean') return schema;
  if (schema.$ref) {
    const prefix = '#/definitions/';
    if (!schema.$ref.startsWith(prefix)) return false;
    const name = schema.$ref.slice(prefix.length).replaceAll('~1', '/').replaceAll('~0', '~');
    return matchesSchema(root.definitions[name], value, root);
  }
  if (schema.anyOf && !schema.anyOf.some(item => matchesSchema(item, value, root))) return false;
  if (schema.allOf && !schema.allOf.every(item => matchesSchema(item, value, root))) return false;
  if (schema.oneOf && schema.oneOf.filter(item => matchesSchema(item, value, root)).length !== 1) return false;
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) return false;
  if (schema.type) {
    const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!kinds.some(kind => kind === actual || (kind === 'integer' && actual === 'number' && Number.isSafeInteger(value)))) return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    if (schema.format === 'uint8' && (value < 0 || value > 255)) return false;
    if (schema.format === 'uint32' && (value < 0 || value > 4294967295)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    // Rust strings contain Unicode scalar values; lone JS surrogates have no
    // valid UTF-8 equivalent and must not be silently replaced by TextEncoder.
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) return false;
    }
    if (schema['x-max-utf8-bytes'] !== undefined && new TextEncoder().encode(value).byteLength > schema['x-max-utf8-bytes']) return false;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.items && !value.every(item => matchesSchema(schema.items, item, root))) return false;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const properties = schema.properties ?? {};
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!matchesSchema(properties[key], item, root)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (typeof schema.additionalProperties === 'object' && !matchesSchema(schema.additionalProperties, item, root)) return false;
    }
  }
  return true;
}
