import { TextInputDialog } from '@/components/common/TextInputDialog'
import { LocalProjectEditDialog } from '@/components/projects/LocalProjectEditDialog'
import { StandaloneFolderProjectDialog } from '@/components/projects/StandaloneProjectDialogs'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { ArchiveConversationsConfirmDialog } from './ArchiveConversationsConfirmDialog'
import type { SidebarModel } from './useSidebarModel'

export function SidebarDialogs({ model }: { model: SidebarModel }) {
  const {
    devices,
    preferredDeviceId,
    onRefreshDevices,
    onOpenStandaloneWorkspace,
    onGetRemoteDeviceStartupCommand,
    onUpdateProjectName,
    onUpdateLocalRuntimeProject,
    onRemoveProject,
    onGetDeviceHomeDirectory,
    onListDeviceDirectories,
    onCreateDeviceDirectory,
    onOpenSettings,
    t,
    accountCloudDialogOpen,
    setAccountCloudDialogOpen,
    archiveSectionMode,
    forceArchiveSectionMode,
    standaloneWorkspaceDialogMode,
    setStandaloneWorkspaceDialogMode,
    standaloneRemoteDialogIntent,
    renamingProject,
    setRenamingProject,
    editingLocalProject,
    setEditingLocalProject,
    isArchiveSectionSubmitting,
    archiveSectionDialogTestId,
    archiveSectionDialogCount,
    closeArchiveSectionDialog,
    forceArchiveSectionDialogTestId,
    confirmArchiveSectionConversations,
    closeForceArchiveSectionDialog,
    confirmForceArchiveSectionConversations,
  } = model
  return (
    <>
      {accountCloudDialogOpen && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={0}
          onClose={() => setAccountCloudDialogOpen(false)}
          onOpenSettings={() => {
            setAccountCloudDialogOpen(false)
            onOpenSettings({ settingsPage: 'connections' })
          }}
        />
      )}

      <StandaloneFolderProjectDialog
        key={standaloneWorkspaceDialogMode ?? 'standalone-folder-closed'}
        open={standaloneWorkspaceDialogMode !== null}
        mode={standaloneWorkspaceDialogMode ?? 'existing'}
        remoteIntent={standaloneRemoteDialogIntent}
        devices={devices}
        preferredDeviceId={preferredDeviceId}
        onClose={() => setStandaloneWorkspaceDialogMode(null)}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        onGetRemoteDeviceStartupCommand={onGetRemoteDeviceStartupCommand}
        onRefreshDevices={onRefreshDevices}
      />
      <ArchiveConversationsConfirmDialog
        open={archiveSectionMode !== null}
        title={t(
          archiveSectionMode === 'chats'
            ? 'workbench.archive_chats_dialog_title'
            : 'workbench.archive_projects_dialog_title',
          {
            defaultValue: '归档 {{count}} 个对话?',
            count: archiveSectionDialogCount,
          }
        )}
        description={t(
          archiveSectionMode === 'chats'
            ? 'workbench.archive_chats_dialog_desc'
            : 'workbench.archive_projects_dialog_desc',
          {
            defaultValue:
              archiveSectionMode === 'chats'
                ? '这会将对话列表中的对话归档。之后你可以在已归档对话中找到它们'
                : '这会将项目中的对话归档。之后你可以在已归档对话中找到它们',
          }
        )}
        confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={isArchiveSectionSubmitting}
        testId={archiveSectionDialogTestId}
        onClose={closeArchiveSectionDialog}
        onConfirm={confirmArchiveSectionConversations}
      />
      <ArchiveConversationsConfirmDialog
        open={forceArchiveSectionMode !== null}
        title={t('workbench.archive_runtime_task_dirty_worktree_title')}
        description={t('workbench.archive_runtime_tasks_dirty_worktree_force_desc')}
        confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={isArchiveSectionSubmitting}
        testId={forceArchiveSectionDialogTestId}
        onClose={closeForceArchiveSectionDialog}
        onConfirm={confirmForceArchiveSectionConversations}
      />
      <TextInputDialog
        open={renamingProject !== null}
        title={t('workbench.rename_project', '重命名项目')}
        label={t('workbench.project_name', '项目名称')}
        initialValue={renamingProject?.name ?? ''}
        confirmLabel={t('workbench.save', '保存')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={() => setRenamingProject(null)}
        onSubmit={name =>
          renamingProject ? onUpdateProjectName(renamingProject.id, name) : Promise.resolve()
        }
      />
      <LocalProjectEditDialog
        open={editingLocalProject !== null}
        projectWork={editingLocalProject}
        device={
          devices.find(
            device =>
              device.device_id ===
              (editingLocalProject?.project.stateDeviceId ||
                editingLocalProject?.deviceWorkspaces[0]?.deviceId)
          ) ?? null
        }
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onClose={() => setEditingLocalProject(null)}
        onSave={data =>
          onUpdateLocalRuntimeProject
            ? onUpdateLocalRuntimeProject(data)
            : Promise.reject(new Error('Local project editing is unavailable'))
        }
        onDelete={() => {
          if (!editingLocalProject) return
          const projectId = runtimeProjectUiId(editingLocalProject.project)
          setEditingLocalProject(null)
          void onRemoveProject(projectId)
        }}
      />
    </>
  )
}
