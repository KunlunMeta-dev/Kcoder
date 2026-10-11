import { requestLocalExecutor } from '@/tauri/localExecutor'

/** One saved session settings template as shown in the settings catalog. */
export interface SettingsTemplateSummary {
  id: string
  name: string
  description?: string
  updatedAt: string
  sizeBytes: number
  revisionSha256: string
}

export interface SettingsTemplateCatalog {
  templates: SettingsTemplateSummary[]
  defaultId?: string
}

export interface SettingsTemplateContent {
  summary: SettingsTemplateSummary
  content: string
  defaultId?: string
}

export interface SettingsTemplateDraft {
  id?: string
  name: string
  description?: string
  content: string
}

export function listSettingsTemplates(serverId: string) {
  return requestLocalExecutor<SettingsTemplateCatalog>('runtime.settings.request', {
    serverId,
    method: 'settings/templates/list',
    params: {},
  })
}

export function readSettingsTemplate(serverId: string, id: string) {
  return requestLocalExecutor<SettingsTemplateContent>('runtime.settings.request', {
    serverId,
    method: 'settings/templates/read',
    params: { id },
  })
}

export function saveSettingsTemplate(serverId: string, draft: SettingsTemplateDraft) {
  return requestLocalExecutor<{ template: SettingsTemplateSummary; defaultId?: string }>(
    'runtime.settings.request',
    { serverId, method: 'settings/templates/save', params: draft },
  )
}

export function deleteSettingsTemplate(serverId: string, id: string) {
  return requestLocalExecutor<SettingsTemplateCatalog>('runtime.settings.request', {
    serverId,
    method: 'settings/templates/delete',
    params: { id },
  })
}

export function setDefaultSettingsTemplate(serverId: string, id: string | null) {
  return requestLocalExecutor<SettingsTemplateCatalog>('runtime.settings.request', {
    serverId,
    method: 'settings/templates/default',
    params: { id },
  })
}
