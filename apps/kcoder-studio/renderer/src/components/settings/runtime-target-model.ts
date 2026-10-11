import type { GatewayServer, GatewayServerConfig } from '@/kcoder/gatewayRpc'

export type RuntimeTargetField =
  | 'label'
  | 'id'
  | 'transport'
  | 'host'
  | 'user'
  | 'accountMode'
  | 'port'
  | 'workspacePath'
  | 'command'
  | 'profile'
  | 'settingsFile'
  | 'chromiumBin'
  | 'acceptNewHostKey'
  | 'chromiumNoSandbox'

export type RuntimeTargetValidationCode =
  | 'requiredLabel'
  | 'requiredId'
  | 'invalidId'
  | 'duplicateId'
  | 'requiredHost'
  | 'invalidPort'
  | 'invalidWorkspace'
  | 'requiredCommand'
  | 'invalidSettingsFile'

export interface RuntimeTargetDraft {
  id: string
  label: string
  transport: 'local' | 'ssh'
  host: string
  user: string
  accountMode: boolean
  port: string
  workspacePath: string
  command: string
  profile: string
  settingsFile: string
  chromiumBin: string
  acceptNewHostKey: boolean
  chromiumNoSandbox: boolean
}

export interface RuntimeTargetEditorSession {
  mode: 'create' | 'edit'
  labelKey?: 'currentComputer'
  originalId: string | null
  baseline: RuntimeTargetDraft
  draft: RuntimeTargetDraft
  revision: number
  advancedOpen: boolean
}

export type RuntimeTargetErrors = Partial<Record<RuntimeTargetField, RuntimeTargetValidationCode>>

export const RUNTIME_TARGET_FIELD_ORDER: RuntimeTargetField[] = [
  'label',
  'id',
  'transport',
  'host',
  'user',
  'accountMode',
  'port',
  'workspacePath',
  'command',
  'profile',
  'settingsFile',
  'chromiumBin',
  'acceptNewHostKey',
  'chromiumNoSandbox',
]

export function createRuntimeTargetSession(): RuntimeTargetEditorSession {
  const draft: RuntimeTargetDraft = {
    id: '',
    label: '',
    transport: 'ssh',
    host: '',
    user: '',
    accountMode: false,
    port: '',
    workspacePath: '',
    command: 'kcoder',
    profile: '',
    settingsFile: '',
    chromiumBin: '',
    acceptNewHostKey: false,
    chromiumNoSandbox: false,
  }
  return {
    mode: 'create',
    originalId: null,
    baseline: draft,
    draft,
    revision: 0,
    advancedOpen: false,
  }
}

export function editRuntimeTargetSession(server: GatewayServer): RuntimeTargetEditorSession {
  const draft = runtimeTargetDraftFromServer(server)
  return {
    mode: 'edit',
    labelKey: server.labelKey,
    originalId: server.id,
    baseline: draft,
    draft,
    revision: 0,
    advancedOpen: false,
  }
}

export function runtimeTargetDraftFromServer(server: GatewayServer): RuntimeTargetDraft {
  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    host: server.host ?? '',
    user: server.user ?? '',
    accountMode: Boolean(server.security),
    port: server.port === undefined ? '' : String(server.port),
    workspacePath: server.workspacePath ?? '',
    command: server.command ?? 'kcoder',
    profile: server.profile ?? '',
    settingsFile: server.settingsFile ?? '',
    chromiumBin: server.chromiumBin ?? '',
    acceptNewHostKey: server.acceptNewHostKey === true,
    chromiumNoSandbox: server.chromiumNoSandbox === true,
  }
}

export function runtimeTargetSessionIsDirty(session: RuntimeTargetEditorSession): boolean {
  return JSON.stringify(session.draft) !== JSON.stringify(session.baseline)
}

export function updateRuntimeTargetSession(
  session: RuntimeTargetEditorSession,
  field: RuntimeTargetField,
  value: RuntimeTargetDraft[RuntimeTargetField]
): RuntimeTargetEditorSession {
  const nextDraft = { ...session.draft, [field]: value }
  if (field === 'transport' && value === 'local') {
    nextDraft.host = ''
    nextDraft.user = ''
    nextDraft.accountMode = false
    nextDraft.port = ''
    nextDraft.acceptNewHostKey = false
  }
  if (field === 'accountMode') {
    if (value) {
      nextDraft.command = 'kcoder-account'
      nextDraft.user ||= 'root'
      nextDraft.profile = ''
      nextDraft.settingsFile = ''
      nextDraft.chromiumBin = ''
      nextDraft.chromiumNoSandbox = false
    } else if (nextDraft.command === 'kcoder-account') nextDraft.command = 'kcoder'
  }
  return { ...session, draft: nextDraft, revision: session.revision + 1 }
}

export function validateRuntimeTarget(
  session: RuntimeTargetEditorSession,
  configured: GatewayServer[]
): RuntimeTargetErrors {
  const draft = session.draft
  const errors: RuntimeTargetErrors = {}
  if (!draft.label.trim()) errors.label = 'requiredLabel'
  if (!draft.id.trim()) errors.id = 'requiredId'
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(draft.id.trim())) errors.id = 'invalidId'
  else if (session.mode === 'create' && configured.some(server => server.id === draft.id.trim())) {
    errors.id = 'duplicateId'
  }
  if (draft.transport === 'ssh' && !draft.host.trim()) errors.host = 'requiredHost'
  if (draft.port) {
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'invalidPort'
  }
  const absolutePath = (path: string) => {
    const value = path.trim()
    return (
      value.startsWith('/') ||
      (draft.transport === 'local' &&
        (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)))
    )
  }
  if (draft.workspacePath && !absolutePath(draft.workspacePath)) {
    errors.workspacePath = 'invalidWorkspace'
  }
  if (!draft.command.trim()) errors.command = 'requiredCommand'
  if (draft.settingsFile && !absolutePath(draft.settingsFile)) {
    errors.settingsFile = 'invalidSettingsFile'
  }
  return errors
}

export function runtimeTargetConfigFromDraft(
  session: RuntimeTargetEditorSession
): GatewayServerConfig {
  const draft = session.draft
  const config: GatewayServerConfig = {
    id: session.originalId ?? draft.id.trim(),
    label: draft.label.trim(),
    description: `${draft.transport === 'local' ? 'Local' : 'SSH'} KCoder app-server`,
    runtime: 'kcoder',
    transport: draft.transport,
    command: draft.command.trim(),
  }
  if (draft.label === session.baseline.label && draft.transport === 'local' && session.labelKey) {
    config.labelKey = session.labelKey
  }
  if (draft.workspacePath.trim()) config.workspacePath = draft.workspacePath.trim()
  if (draft.profile.trim()) config.profile = draft.profile.trim()
  if (draft.settingsFile.trim()) config.settingsFile = draft.settingsFile.trim()
  if (draft.chromiumBin.trim()) config.chromiumBin = draft.chromiumBin.trim()
  if (draft.chromiumNoSandbox) config.chromiumNoSandbox = true
  if (draft.transport === 'ssh') {
    if (draft.accountMode) config.security = { identity: { mode: 'kcoder-account' } }
    config.host = draft.host.trim()
    if (draft.user.trim()) config.user = draft.user.trim()
    if (draft.port) config.port = Number(draft.port)
    if (draft.acceptNewHostKey) config.acceptNewHostKey = true
  }
  return config
}
