export type FieldSchema = { type?: string; title?: string; description?: string; default?: unknown; enum?: unknown[]; items?: FieldSchema; properties?: Record<string, FieldSchema>; required?: string[]; minimum?: number; maximum?: number; minItems?: number; maxItems?: number }
export function readInputFields(schema: unknown): { fields: [string, FieldSchema][]; required: Set<string> } {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { fields: [], required: new Set() }
  const object = schema as FieldSchema
  if (object.type !== 'object' || !object.properties || typeof object.properties !== 'object') return { fields: [], required: new Set() }
  return { fields: Object.entries(object.properties).slice(0, 64), required: new Set(object.required ?? []) }
}
export function fieldValue(field: FieldSchema, value: string): unknown {
  if (field.type === 'array') {
    if (field.items?.type === 'string') return value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    return JSON.parse(value)
  }
  if (field.type === 'number' || field.type === 'integer') {
    if (!value.trim()) return undefined
    const number = Number(value)
    if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isSafeInteger(number))) throw new Error('OFFICE_INVALID_INPUT')
    return number
  }
  if (field.type === 'object') return JSON.parse(value)
  if (field.type === 'boolean') return value === 'true'
  return value
}
export function initialFieldValue(field: FieldSchema): string {
  if (field.default === undefined || field.default === null) return ''
  return Array.isArray(field.default) ? field.default.join('\n') : typeof field.default === 'object' ? JSON.stringify(field.default, null, 2) : String(field.default)
}
