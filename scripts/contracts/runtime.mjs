// Small Draft-07 evaluator for the reviewed public contract schemas. Unsupported
// schema keywords are rejected by the generator before this runtime is emitted.
// Matches kcoder_types::continuous_work's conservative opaque JSON weight. It
// bounds escaped UTF-8 output without depending on object property order.
function opaqueJsonWithinWeight(value, limit) {
  const active = new WeakSet();
  const utf8Length = text => {
    for (const character of text) {
      const point = character.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) return Infinity;
    }
    return new TextEncoder().encode(text).byteLength;
  };
  const weight = (item, depth) => {
    if (depth > 64) return Infinity;
    if (item === null) return 4;
    if (typeof item === 'boolean') return 5;
    if (typeof item === 'number') return Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)) ? 32 : Infinity;
    if (typeof item === 'string') return 2 + 6 * utf8Length(item);
    if (typeof item !== 'object' || active.has(item)) return Infinity;
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) return Infinity;
    active.add(item);
    let total = 2;
    if (array) {
      for (const entry of item) {
        total += 1 + weight(entry, depth + 1);
        if (total > limit) break;
      }
    } else {
      for (const [key, entry] of Object.entries(item)) {
        total += 4 + 6 * utf8Length(key) + weight(entry, depth + 1);
        if (total > limit) break;
      }
    }
    active.delete(item);
    return total;
  };
  return weight(value, 0) <= limit;
}

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
  if (schema['x-max-opaque-json-weight'] !== undefined && !opaqueJsonWithinWeight(value, schema['x-max-opaque-json-weight'])) return false;
  if (schema.type) {
    const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!kinds.some(kind => kind === actual || (kind === 'integer' && actual === 'number' && Number.isSafeInteger(value)))) return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    if (schema.format === 'uint8' && (value < 0 || value > 255)) return false;
    if (schema.format === 'uint16' && (value < 0 || value > 65535)) return false;
    if (schema.format === 'uint32' && (value < 0 || value > 4294967295)) return false;
    if (schema.format === 'int32' && (value < -2147483648 || value > 2147483647)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    // Rust strings contain Unicode scalar values; lone JS surrogates have no
    // valid UTF-8 equivalent and must not be silently replaced by TextEncoder.
    let length = 0;
    for (const character of value) {
      const point = character.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) return false;
      length += 1;
    }
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
    if (schema['x-max-utf8-bytes'] !== undefined && new TextEncoder().encode(value).byteLength > schema['x-max-utf8-bytes']) return false;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
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
