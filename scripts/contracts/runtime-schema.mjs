const annotations = ['$schema', 'title', 'description', 'default', 'x-known-values', 'x-error-codes', 'x-stderr-prefix'];

/** Keep validation structure intact while excluding metadata from shipping JS. */
export function runtimeSchema(schema) {
  if (typeof schema === 'boolean') return schema;
  const result = { ...schema };
  for (const name of annotations) delete result[name];
  for (const name of ['properties', 'definitions']) {
    if (schema[name]) result[name] = Object.fromEntries(Object.entries(schema[name])
      .map(([key, value]) => [key, runtimeSchema(value)]));
  }
  for (const name of ['anyOf', 'allOf', 'oneOf']) {
    if (schema[name]) result[name] = schema[name].map(runtimeSchema);
  }
  if (schema.items !== undefined) result.items = runtimeSchema(schema.items);
  if (typeof schema.additionalProperties === 'object') result.additionalProperties = runtimeSchema(schema.additionalProperties);
  return result;
}
