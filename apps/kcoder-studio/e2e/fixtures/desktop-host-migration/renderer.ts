import { installLocalWorkspaceOpenListener } from '../../../renderer/src/host/localWorkspaceOpen'

const state = { opened: [] as Array<{ serverId: string; path: string; label?: string }>, errors: [] as string[] }
Object.assign(window, { hostMigration: state })
void installLocalWorkspaceOpenListener(async (serverId, path, label) => {
  console.log('OWNED_WORKSPACE_OPENED', serverId)
  state.opened.push({ serverId, path, label })
}, error => state.errors.push(error))
