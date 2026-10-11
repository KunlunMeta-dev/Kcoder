/** Conservative form projection. Other JSON Schema shapes stay in the JSON editor;
 * the target runtime remains the authoritative validator. */
export interface ArgumentField {
  name: string
  title: string
  description?: string
  type: 'string' | 'number' | 'integer' | 'boolean'
  required: boolean
  enum?: Array<string | number | boolean>
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const rootKeys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'title',
  'description',
  '$schema',
])
const fieldKeys = new Set([
  'type',
  'title',
  'description',
  'default',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
])
export function argumentFields(schema: unknown): ArgumentField[] | null {
  if (!record(schema) || schema.type !== 'object' || !record(schema.properties)) return null
  if (
    Object.keys(schema).some(key => !rootKeys.has(key)) ||
    Object.keys(schema.properties).length > 32
  )
    return null
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
    return null
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some(
        name => typeof name !== 'string' || !Object.hasOwn(schema.properties as object, name)
      ))
  )
    return null
  const required = new Set(schema.required as string[] | undefined)
  const fields: ArgumentField[] = []
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!record(property) || Object.keys(property).some(key => !fieldKeys.has(key))) return null
    const type = property.type
    if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean')
      return null
    if (
      property.enum !== undefined &&
      (!Array.isArray(property.enum) ||
        !property.enum.length ||
        property.enum.some(value => !matchesType(type, value)))
    )
      return null
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength']) {
      if (
        property[key] !== undefined &&
        (typeof property[key] !== 'number' || !Number.isFinite(property[key]))
      )
        return null
    }
    fields.push({
      ...property,
      name,
      type,
      title: typeof property.title === 'string' ? property.title : name,
      description: typeof property.description === 'string' ? property.description : undefined,
      required: required.has(name),
    } as ArgumentField)
  }
  return fields
}
function matchesType(type: ArgumentField['type'], value: unknown) {
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}
export function defaultArguments(fields: ArgumentField[] | null): string {
  return JSON.stringify(
    Object.fromEntries(
      (fields ?? [])
        .filter(field => field.default !== undefined && matchesType(field.type, field.default))
        .map(field => [field.name, field.default])
    ),
    null,
    2
  )
}
export function parseArguments(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim() || '{}')
    return record(value) ? value : null
  } catch {
    return null
  }
}
export type ArgumentIssue = {
  field: string
  reason: 'required' | 'type' | 'enum' | 'minimum' | 'maximum' | 'minLength' | 'maxLength' | 'extra'
  limit?: number
}
export function argumentIssues(
  fields: ArgumentField[] | null,
  args: Record<string, unknown>,
  schema: unknown
): ArgumentIssue[] {
  if (!fields) return []
  const issues: ArgumentIssue[] = []
  for (const field of fields) {
    if (!Object.hasOwn(args, field.name)) {
      if (field.required) issues.push({ field: field.title, reason: 'required' })
      continue
    }
    const value = args[field.name]
    if (!matchesType(field.type, value)) {
      issues.push({ field: field.title, reason: 'type' })
      continue
    }
    if (field.enum && !field.enum.includes(value as never))
      issues.push({ field: field.title, reason: 'enum' })
    if (typeof value === 'number') {
      if (field.minimum !== undefined && value < field.minimum)
        issues.push({ field: field.title, reason: 'minimum', limit: field.minimum })
      if (field.maximum !== undefined && value > field.maximum)
        issues.push({ field: field.title, reason: 'maximum', limit: field.maximum })
    }
    if (typeof value === 'string') {
      const length = Array.from(value).length
      if (field.minLength !== undefined && length < field.minLength)
        issues.push({ field: field.title, reason: 'minLength', limit: field.minLength })
      if (field.maxLength !== undefined && length > field.maxLength)
        issues.push({ field: field.title, reason: 'maxLength', limit: field.maxLength })
    }
  }
  if (record(schema) && schema.additionalProperties === false) {
    const known = new Set(fields.map(field => field.name))
    for (const key of Object.keys(args))
      if (!known.has(key)) issues.push({ field: key, reason: 'extra' })
  }
  return issues
}
