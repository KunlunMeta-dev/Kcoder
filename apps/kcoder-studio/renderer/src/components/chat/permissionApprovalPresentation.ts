/** Presentation metadata only; canonical answers remain unchanged on the wire. */
export interface PermissionApprovalPresentation {
  kind: 'command' | 'file_change' | 'permission' | 'tool'
  subject: string | null
  input: string | null
  reason: string | null
}
const choices: Record<string, string> = {
  'Allow once': 'allowOnce',
  'Always allow for this session': 'allowSession',
  Decline: 'decline',
}
export function permissionChoiceKey(label: string, description = false): string | null {
  const key = choices[label]
  return key ? `approvalUi.${key}${description ? 'Description' : ''}` : null
}
