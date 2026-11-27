import { StandaloneFolderProjectDialog } from '../../src/components/projects/StandaloneProjectDialogs'
import type { DeviceInfo } from '../../src/types/api'

const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'preview-h20',
    name: 'H20',
    status: 'online',
    device_type: 'remote',
    bind_shell: 'claudecode',
    executor_version: '2.0.11',
  },
  {
    id: 2,
    device_id: 'preview-long-host',
    name: '远程构建主机 · An unusually long host name for the project selector',
    status: 'online',
    device_type: 'remote',
    bind_shell: 'claudecode',
    executor_version: '2.0.11',
  },
]

// Rendering-only fixture: directory responses are inert and never reach a host.
export function RemoteProjectPreview() {
  return (
    <StandaloneFolderProjectDialog
      open
      mode="remote"
      devices={devices}
      preferredDeviceId="preview-h20"
      onClose={() => {}}
      onGetDeviceHomeDirectory={async () => '/home/preview'}
      onListDeviceDirectories={async () => ['repo']}
      onCreateDeviceDirectory={async () => {}}
    />
  )
}
