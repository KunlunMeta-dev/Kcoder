import enExperts from './locales/en/experts.json'
import zhExperts from './locales/zh-CN/experts.json'
import { remoteCapabilityResources } from '@/features/remote-capabilities/locales'
import enConnectivity from './locales/en/connectivity.json'
import zhConnectivity from './locales/zh-CN/connectivity.json'
import enTaskCapabilityScope from './locales/en/taskCapabilityScope.json'
import zhTaskCapabilityScope from './locales/zh-CN/taskCapabilityScope.json'
import enMigrationProjects from './locales/en/migrationProjects.json'
import zhMigrationProjects from './locales/zh-CN/migrationProjects.json'
import enMigrationAgents from './locales/en/migrationAgents.json'
import zhMigrationAgents from './locales/zh-CN/migrationAgents.json'
import enMigrationInstructions from './locales/en/migrationInstructions.json'
import zhMigrationInstructions from './locales/zh-CN/migrationInstructions.json'
import enMigrationPrivate from './locales/en/migrationPrivate.json'
import zhMigrationPrivate from './locales/zh-CN/migrationPrivate.json'
import enMigrationResources from './locales/en/migrationResources.json'
import zhMigrationResources from './locales/zh-CN/migrationResources.json'
import enMigrationDefinitions from './locales/en/migrationDefinitions.json'
import zhMigrationDefinitions from './locales/zh-CN/migrationDefinitions.json'
import enMigrationPlugins from './locales/en/migrationPlugins.json'
import zhMigrationPlugins from './locales/zh-CN/migrationPlugins.json'
import enMigrationMemory from './locales/en/migrationMemory.json'
import zhMigrationMemory from './locales/zh-CN/migrationMemory.json'
import enMigrationUpload from './locales/en/migrationUpload.json'
import zhMigrationUpload from './locales/zh-CN/migrationUpload.json'
import enKnowledge from './locales/en/knowledge.json'
import zhKnowledge from './locales/zh-CN/knowledge.json'
import enKnowledgeIntegration from './locales/en/knowledgeIntegration'
import zhKnowledgeIntegration from './locales/zh-CN/knowledgeIntegration'
import enMigration from './locales/en/migration.json'
import zhMigration from './locales/zh-CN/migration.json'
import { officeIntegrationResources } from '@/features/office-integration/locales'
import { modelPolicyResources } from '@/features/model-policies/locales'
import { nativeOfficeWorkspaceResources } from '@/features/runtime-governance/nativeOfficeWorkspaceCopy'
import { taskCapabilityScopeRecordResources } from '@/features/task-workspace/capability-scope/locales'
import { taskInteractionResources } from '@/features/task-workspace/interactions/locales'
import { taskGoalResources } from '@/features/task-workspace/goals/locales'
import { taskWorkspaceResources } from '@/features/task-workspace/locales'
import { taskMemberResources } from '@/features/task-workspace/members/locales'
import { taskCollaborationResources } from '@/features/task-workspace/collaboration/locales'
import enCommon from './locales/en/common'
import zhCommon from './locales/zh-CN/common'
import enChat from './locales/en/chat.json'
import zhChat from './locales/zh-CN/chat.json'
import enLocalRuntime from './locales/en/localRuntime.json'
import zhLocalRuntime from './locales/zh-CN/localRuntime.json'
import enSites from './locales/en/sites.json'
import zhSites from './locales/zh-CN/sites.json'
import enHooks from './locales/en/hooks.json'
import zhHooks from './locales/zh-CN/hooks.json'
import enSshTerminal from './locales/en/sshTerminal.json'
import zhSshTerminal from './locales/zh-CN/sshTerminal.json'
import enTaskComparison from './locales/en/taskComparison.json'
import zhTaskComparison from './locales/zh-CN/taskComparison.json'
import enTaskDelivery from './locales/en/taskDelivery.json'
import zhTaskDelivery from './locales/zh-CN/taskDelivery.json'
import { extensionI18nResources } from '@extensions/i18n'

export const extensionNamespaces = Array.from(
  new Set(Object.values(extensionI18nResources).flatMap(resources => Object.keys(resources ?? {})))
)

export const resources = {
  en: {
    experts: enExperts,
    migration: enMigration,
    migrationProjects: enMigrationProjects,
    migrationPrivate: enMigrationPrivate,
    migrationResources: enMigrationResources,
    migrationPlugins: enMigrationPlugins,
    migrationMemory: enMigrationMemory,
    migrationDefinitions: enMigrationDefinitions,
    migrationAgents: enMigrationAgents,
    migrationInstructions: enMigrationInstructions,
    migrationUpload: enMigrationUpload,
    knowledge: enKnowledge,
    knowledgeIntegration: enKnowledgeIntegration,
    remoteCapabilities: remoteCapabilityResources.en,
    modelPolicies: modelPolicyResources.en,
    officeIntegration: {
      ...officeIntegrationResources.en,
      ...nativeOfficeWorkspaceResources.en,
    },
    taskWorkspace: taskWorkspaceResources.en,
    taskGoal: taskGoalResources.en,
    taskInteractions: taskInteractionResources.en,
    taskCapabilityScopeRecords: taskCapabilityScopeRecordResources.en,
    taskMembers: taskMemberResources.en,
    taskCollaboration: taskCollaborationResources.en,
    chat: enChat,
    common: enCommon,
    localRuntime: enLocalRuntime,
    sites: enSites,
    hooks: enHooks,
    sshTerminal: enSshTerminal,
    taskComparison: enTaskComparison,
    taskDelivery: enTaskDelivery,
    taskCapabilityScope: enTaskCapabilityScope,
    connectivity: enConnectivity,
    ...(extensionI18nResources.en ?? {}),
  },
  'zh-CN': {
    experts: zhExperts,
    migration: zhMigration,
    migrationProjects: zhMigrationProjects,
    migrationPrivate: zhMigrationPrivate,
    migrationResources: zhMigrationResources,
    migrationPlugins: zhMigrationPlugins,
    migrationMemory: zhMigrationMemory,
    migrationDefinitions: zhMigrationDefinitions,
    migrationAgents: zhMigrationAgents,
    migrationInstructions: zhMigrationInstructions,
    migrationUpload: zhMigrationUpload,
    knowledge: zhKnowledge,
    knowledgeIntegration: zhKnowledgeIntegration,
    remoteCapabilities: remoteCapabilityResources['zh-CN'],
    modelPolicies: modelPolicyResources['zh-CN'],
    officeIntegration: {
      ...officeIntegrationResources['zh-CN'],
      ...nativeOfficeWorkspaceResources['zh-CN'],
    },
    taskWorkspace: taskWorkspaceResources['zh-CN'],
    taskGoal: taskGoalResources['zh-CN'],
    taskInteractions: taskInteractionResources['zh-CN'],
    taskCapabilityScopeRecords: taskCapabilityScopeRecordResources['zh-CN'],
    taskMembers: taskMemberResources['zh-CN'],
    taskCollaboration: taskCollaborationResources['zh-CN'],
    chat: zhChat,
    common: zhCommon,
    localRuntime: zhLocalRuntime,
    sites: zhSites,
    hooks: zhHooks,
    sshTerminal: zhSshTerminal,
    taskComparison: zhTaskComparison,
    taskDelivery: zhTaskDelivery,
    taskCapabilityScope: zhTaskCapabilityScope,
    connectivity: zhConnectivity,
    ...(extensionI18nResources['zh-CN'] ?? {}),
  },
}
