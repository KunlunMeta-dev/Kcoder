/** Storage domains organize reviewable data; they never redefine Rust wire types. */
export const CONTRACT_DOMAINS = Object.freeze(['core', 'knowledge', 'mcp', 'web-search', 'web-sources', 'mcp-authorization', 'task-comparison', 'task-delivery', 'review-evidence', 'turn-file-capture', 'agents', 'continuous-work', 'task-interactions', 'browser-profiles', 'widgets', 'mcp-apps', 'workflow-collaboration', 'migration', 'migration-source', 'migration-source-credentials', 'migration-lifecycle', 'migration-batch', 'migration-batch-control', 'migration-credentials', 'migration-history', 'migration-history-budget', 'migration-transcript', 'migration-branches', 'migration-attachments', 'migration-memory', 'migration-source-upload', 'migration-definitions', 'migration-agents', 'migration-projects', 'migration-items', 'migration-instructions', 'migration-source-sessions', 'integrations-core', 'integrations-services', 'integrations-remotes', 'integrations-models', 'integrations-tasks', 'integrations-task-capability-scope', 'integrations-office', 'integrations-office-exports', 'integrations-office-assistants', 'integrations-office-generation', 'integrations-connectivity', 'integrations-knowledge', 'integrations-knowledge-memory', 'integrations-knowledge-automation', 'integrations-knowledge-subscriptions']);

export function contractDomain(name) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`Invalid contract name: ${name}`);
  if (name.startsWith('AsyncQuestion')) return 'task-interactions';
  if (name.startsWith('TaskComparison')) return 'task-comparison';
  if (name.startsWith('TaskDelivery')) return 'task-delivery';
  if (name === 'TurnReviewEvidence' || /^Review(?:Artifact|Evidence|Process|Tool|Validation)/.test(name)) return 'review-evidence';
  if (name === 'TurnFileChangesCapture' || name.startsWith('TurnFileCapture')) return 'turn-file-capture';
  if (/^Browser(?:AccountProfile|Control|Handoff|HumanAction|Profile)/.test(name)) return 'browser-profiles';
  if (name.startsWith('Agent') || name.startsWith('ThreadExpert') || name === 'ChannelTaskSource') return 'agents';
  if (name.startsWith('ContinuousWork')) return 'continuous-work';
  if (name.startsWith('TaskInteraction')) return 'task-interactions';
  if (name.startsWith('WorkflowCollaboration') || ['WorkflowAgentModelSelection', 'WorkflowArtifactRequirement'].includes(name)) return 'workflow-collaboration';
  if (name.startsWith('TaskWorkspace')) return 'integrations-tasks';
  if (name.startsWith('TaskCapabilityScope') || name.startsWith('TaskCapabilitySource') || name.startsWith('IntegrationTaskCapabilityScope') || name.startsWith('IntegrationTaskCapabilitySource') || name.startsWith('IntegrationTaskResource')) return 'integrations-task-capability-scope';
  if (name.startsWith('RemoteCapability') || name.startsWith('RemoteOperation')) return 'integrations-remotes';
  if (name.startsWith('IntegrationModel') || ['ModelPoliciesMethod', 'ModelPolicySettingsMethod'].includes(name)) return 'integrations-models';
  if (name.startsWith('NativeCode')) return 'integrations-services';
  if (name.startsWith('Integration') || name.startsWith('TaskWorkspace')) return 'integrations-core';
  if (name.startsWith('OfficeExportAcknowledgement')) return 'integrations-office-exports';
  if (/^Office(?:Assistant|Adopt|SaveDraft|SaveVersion)/.test(name)) return 'integrations-office-assistants';
  if (/^Office(?:Generat|Canonical|Sheet|Slide|Png|Paragraph|Formula|TextTable|Chart)/.test(name)) return 'integrations-office-generation';
  if (name.startsWith('Office')) return 'integrations-office';
  if (name.startsWith('Memory') || name.startsWith('ReviewedMemory')) return 'integrations-knowledge-memory';
  if (name.startsWith('Subscription') || name.startsWith('AutomationSubscription')) return 'integrations-knowledge-subscriptions';
  if (name.startsWith('Automation') || name.startsWith('Subscription')) return 'integrations-knowledge-automation';
  if (name.startsWith('KnowledgeSettings')) return 'integrations-knowledge';
  if (name.startsWith('KnowledgeAdopt')) return 'integrations-knowledge';
  if (name.startsWith('KnowledgeSource')) return 'integrations-knowledge';
  if (name.startsWith('Connectivity') || name.startsWith('Readiness') || ['MessagingPlatform', 'ConnectionState', 'ChannelDeliveryState'].includes(name)) return 'integrations-connectivity';
  if (name.startsWith('Memory') || name.startsWith('ReviewedMemory') || name.startsWith('Publication') || name.startsWith('KnowledgePublication') || name.startsWith('KnowledgeVisibility') || name.startsWith('KnowledgeRetriev') || name.startsWith('KnowledgePage') || name.startsWith('PublishedKnowledge') || name.startsWith('Subscription') || name.startsWith('Automation') || name.startsWith('CitationRead') || name.startsWith('KnowledgePublish') || name.startsWith('KnowledgeRevoke')) return 'integrations-knowledge';
  if (name.startsWith('McpProviderRevocation')) return 'mcp-authorization';
  if (name.startsWith('McpApp')) return 'mcp-apps';
  if (name.startsWith('MigrationInstruction') || name.startsWith('MigrationSourceInstruction')) return 'migration-instructions';
  if (name.startsWith('MigrationItems')) return 'migration-items';
  if (name.startsWith('MigrationAgent') || name.startsWith('ImportedAgent')) return 'migration-agents';
  if ((name.startsWith('MigrationProject') && !name.startsWith('MigrationProjectMcp')) || name === 'MigrationBatchProjectSource') return 'migration-projects';
  if (name.startsWith('MigrationDefinition')) return 'migration-definitions';
  if (name.startsWith('MigrationMemory') || name.startsWith('ImportedMemory')) return 'migration-memory';
  if (name.startsWith('MigrationSourceUpload') || name.startsWith('MigrationSourceProduct')) return 'migration-source-upload';
  if (name.startsWith('MigrationSourceSession')) return 'migration-source-sessions';
  if (name.startsWith('MigrationSourceCredential')) return 'migration-source-credentials';
  if (name.startsWith('MigrationSource')) return 'migration-source';
  if (name.startsWith('MigrationHistoryResource') || name.startsWith('MigrationHistoryParentResource')) return 'migration-history-budget';
  if (name.startsWith('MigrationHistoryView') || name.startsWith('MigrationArchiveRetirement')) return 'migration-lifecycle';
  if (name.startsWith('MigrationUploadCollection')) return 'migration-attachments';
  if (name.startsWith('MigrationHistoryAttachment') || name.startsWith('MigrationHistoryToolAttachment') || name.startsWith('MigrationLocalAttachment')) return 'migration-attachments';
  if (name.startsWith('MigrationBranch')) return 'migration-branches';
  if (name.startsWith('MigrationTranscript')) return 'migration-transcript';
  if (name.startsWith('MigrationHistory') || name.startsWith('MigrationContinuation')) return 'migration-history';
  if (name.startsWith('MigrationCredential') || name.startsWith('MigrationMcpCredential')) return 'migration-credentials';
  if (name.startsWith('MigrationBatchControl')) return 'migration-batch-control';
  if (name.startsWith('MigrationBatch') || name.startsWith('MigrationJobs') || name.startsWith('MigrationResource') || name.startsWith('MigrationProjectMcp')) return 'migration-batch';
  if (name.startsWith('Migration')) return 'migration';
  if (name.startsWith('Widget') || ['StudioWorkMode', 'ClientPresentationV1', 'ThreadStreamContextV1'].includes(name)) return 'widgets';
  if (name.startsWith('WebSource')) return 'web-sources';
  if (name.startsWith('WebSearch')) return 'web-search';
  if (name.startsWith('Wiki') || name.startsWith('KnowledgeFile') || name.startsWith('KnowledgeImage')) return 'knowledge';
  if (name.startsWith('Mcp') || name.startsWith('ThreadMcp')) return 'mcp';
  return 'core';
}

export function domainFile(stem, domain) {
  if (!CONTRACT_DOMAINS.includes(domain)) throw new Error(`Unknown contract storage domain: ${domain}`);
  return `${stem}${domain === 'core' ? '' : `.${domain}`}.json`;
}

export function splitContractDomains(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Contract data must be a keyed object');
  const groups = Object.fromEntries(CONTRACT_DOMAINS.map(domain => [domain, {}]));
  for (const [name, value] of Object.entries(records)) groups[contractDomain(name)][name] = value;
  return groups;
}

export function mergeContractDomains(groups) {
  const merged = {};
  for (const [domain, records] of Object.entries(groups)) {
    if (!CONTRACT_DOMAINS.includes(domain) || !records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid contract storage domain');
    for (const [name, value] of Object.entries(records)) {
      if (Object.hasOwn(merged, name)) throw new Error(`Duplicate contract across storage domains: ${name}`);
      if (contractDomain(name) !== domain) throw new Error(`Contract belongs to another storage domain: ${name}`);
      merged[name] = value;
    }
  }
  return merged;
}
