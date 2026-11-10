//! Default App Server advertisement. Connection-specific grants are negotiated by the caller.
use kcoder_app_protocol::ServerCapabilities;
use std::collections::BTreeMap;

pub fn server_capabilities(thread_resume: bool, browser_sessions: bool) -> ServerCapabilities {
    ServerCapabilities {
        approvals: true,
        questions: true,
        thread_resume,
        experimental: BTreeMap::from([
            (
                kcoder_app_protocol::CAPABILITY_TASK_COMPARISON_V1.into(),
                true,
            ),
            (kcoder_app_protocol::CAPABILITY_TURN_STEER_V1.into(), true),
            (
                kcoder_app_protocol::CAPABILITY_TASK_DELIVERY_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_FILE_CAPTURE_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::MIGRATION_SOURCE_CREDENTIAL_SOURCES_CAPABILITY.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_PLUGIN_PROJECTS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_TRANSFER_PLUGINS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_UPLOADED_PLUGINS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_DEFINITIONS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_AGENT_ADAPTATION_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_INSTRUCTION_SOURCES_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_TRANSFER_INSTRUCTIONS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_UPLOADED_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_MEMORY_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_UPLOAD_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_VIEW_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_ARCHIVE_RETIREMENT_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_BINDINGS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_DIRECTORY_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_CONFIGURATION_LAYERS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_SOURCE_CODEX_LAYERS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_CODEX_LAYERS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_UPLOAD_COLLECTION_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_CONFIGURATION_LAYERS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_LOCAL_ATTACHMENTS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_REINTERPRETATION_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_CONTINUATION_UNDO_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_SEARCH_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_CONTINUATION_SOURCE_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_TOOL_ATTACHMENTS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_CONTINUATION_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_ATTACHMENTS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_BRANCH_TOOLS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_RECONSTRUCTION_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_BRANCHES_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_READ_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_FAMILY_INDEX_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_JOBS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_CONCURRENCY_32_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_CONCURRENCY_64_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_PROVIDERS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_MCP_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_ASSETS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_LOCAL_PLUGINS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_RESOURCE_ATTACHMENT_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_HISTORY_RESOURCE_BUDGET_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_RESOURCE_BUDGET_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_PROJECTS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_PROJECT_MCP_INHERITANCE_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_CONTROL_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_WORKERS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_PLUGINS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_REUSE_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_CREDENTIALS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_MCP_CREDENTIALS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_BATCH_MCP_CREDENTIALS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_CREDENTIALS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_TEMPLATES_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_MIGRATION_TEMPLATE_REUSE_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_ISOLATED_WIDGETS_V1.into(),
                true,
            ),
            (kcoder_app_protocol::CAPABILITY_MCP_APPS_V1.into(), true),
            (
                kcoder_app_protocol::CAPABILITY_STUDIO_WORK_MODES_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_INLINE_WIDGETS_V1.into(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_AGENT_CONVERSATION_STREAM_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_AGENT_EXACT_RUN_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_IMAGE_IMPORT_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_HTML_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_FILES_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_INGEST_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_CATALOG_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_ARCHIVE_STREAM_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_COMPUTER_USE_TURN_V1.to_string(),
                cfg!(windows),
            ),
            (
                kcoder_app_protocol::CAPABILITY_COMPUTER_USE_STATUS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_COMPUTER_USE_RECOVERY_V1.to_string(),
                cfg!(windows),
            ),
            (
                kcoder_app_protocol::CAPABILITY_COMPUTER_USE_SESSION_AUTHORIZATION_V1.to_string(),
                cfg!(windows),
            ),
            ("toolPathPreviewV1".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_STREAM_CONTEXT_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CONDITIONAL_READ_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_VERIFICATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_STORAGE_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_VERSION_HISTORY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_SCENARIOS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_TRANSFORM_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_INTERACTIONS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_FAILURE_POLICY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_SUBGRAPH_LOOPS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_SUBWORKFLOW_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_TOOL_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_NODE_CONTRACTS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CODE_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CANVAS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_COLLABORATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_LAYOUT_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CONVERSATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_RUNS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_RUN_ARCHIVE_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_GRAPH_V2.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_SWITCH_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_GOAL_CANCELLATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_PRESENCE_READ_V1.to_string(),
                false,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_GOAL_STATUS_BATCH_V1.to_string(),
                false,
            ),
            (
                kcoder_app_protocol::CAPABILITY_INTERACTION_BINDING_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_INTERACTION_STATUS_READ_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_APPROVAL_TOOL_CALL_IDENTITY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_DISABLE_USER_ELICITATION_V1.to_string(),
                true,
            ),
            // The client declares this one, but it is answered here as well: a
            // client reads the negotiated set before it decides whether it may
            // send `resubmit`, and an unanswered declaration looks like a server
            // that would refuse the field.
            (
                kcoder_app_protocol::CAPABILITY_TURN_SUBMISSION_V1.to_string(),
                true,
            ),
            ("toolsCatalog".to_string(), true),
            ("settingsTemplatesV1".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_EXECUTION_DEFAULTS_V1.to_string(),
                true,
            ),
            ("storageDiagnosticsV1".to_string(), true),
            ("browserAttachments".to_string(), true),
            ("browserPreflight".to_string(), true),
            ("ephemeralThreads".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_RUNTIME_HANDOFF_V1.to_string(),
                cfg!(any(target_os = "linux", windows)),
            ),
            ("browserSessions".to_string(), browser_sessions),
            ("terminalSessions".to_string(), true),
            ("workspaceFiles".to_string(), true),
            ("workspaceFileImportV1".to_string(), true),
            ("workspaceBinaryRevisionV1".to_string(), true),
            ("skillActivationV1".to_string(), true),
            ("mcpActivationV1".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_MCP_PROVIDER_REVOCATION_V1.to_string(),
                true,
            ),
            ("workspaceRegistry".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_WORKSPACE_OPERATION_RECEIPTS_V1.to_string(),
                true,
            ),
            ("sidebarRootPinning".to_string(), true),
            ("residentThreads".to_string(), true),
            ("agentDefinitionsV1".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_AGENT_TURN_CONFIGURATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_MCP_SERVERS_V1.to_string(),
                cfg!(any(unix, windows)),
            ),
            (
                kcoder_app_protocol::CAPABILITY_FAILED_TURN_CONTINUATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_RETRY_OPERATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_ATTEMPT_RETRY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_CREATION_RECEIPTS_V1.to_string(),
                thread_resume,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_RECEIPTS_V1.to_string(),
                true,
            ),
            ("threadListCompleteness".to_string(), true),
            ("threadHistoryIndexRefresh".to_string(), true),
            ("threadIndexedPagesV1".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_TRANSCRIPT_SNAPSHOT_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_TRANSCRIPT_OBSERVATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_RESUME_HISTORY_PAGE_V1.to_string(),
                true,
            ),
            ("serverResourceSnapshotV1".to_string(), true),
            ("serverIdleShutdownV1".to_string(), true),
            ("goalContinuation".to_string(), true),
            ("sessionModes".to_string(), true),
            ("agentSteering".to_string(), true),
            ("agentArtifactPagesV1".to_string(), true),
            ("agentCommandReceiptsV1".to_string(), true),
            ("agentLiveViewV1".to_string(), true),
            ("agentRunControlV1".to_string(), true),
            ("agentStopV1".to_string(), true),
            ("plugins".to_string(), true),
            ("providerConfiguration".to_string(), true),
            ("providerConnectionValidation".to_string(), true),
            ("providerIndependentProbeV1".to_string(), true),
            ("providerModelDiscoveryV1".to_string(), true),
            ("providerEffectiveConfigurationV1".to_string(), true),
            ("providerClearUserOverridesV1".to_string(), true),
            ("providerRuntimeScopeV1".to_string(), true),
            ("providerTemplates".to_string(), true),
            ("providerAuthenticationPolicy".to_string(), true),
            ("providerModelCapabilities".to_string(), true),
            ("qualifiedModelSelectionV1".to_string(), true),
            ("providerDeletion".to_string(), true),
            ("marketplaces".to_string(), true),
            ("pluginDownloadProxy".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_WORKBUDDY_MARKETPLACE.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_PLUGIN_PROXY_DISCOVERY.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TRAE_CN_MARKETPLACE.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_HOSTED_PLUGIN_MARKETPLACES.to_string(),
                true,
            ),
            ("marketplaceDirectoryTrust".to_string(), true),
            (
                kcoder_app_protocol::HOOK_CONFIGURATION_CAPABILITY.to_string(),
                true,
            ),
            ("pluginTrustManagement".to_string(), true),
            ("pluginInstallCancellation".to_string(), true),
            ("backgroundRunIdentityV1".to_string(), true),
            ("pluginIcons".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_PLUGIN_REVALIDATION.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_PLUGIN_PRIVATE_CREDENTIALS.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_PLUGIN_ACTIVATION.to_string(),
                true,
            ),
            ("marketplaceGitRefresh".to_string(), true),
            ("turnPermissions".to_string(), true),
            ("scheduledTasks".to_string(), true),
            ("projectAutomations".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_CRON_HISTORY_DELETE_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_CRON_EXECUTION_DIAGNOSTICS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_CRON_TIMEZONE_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_CRON_PREVIEW_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_CRON_DELIVERY_DIAGNOSTICS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_STORAGE_SCAN_CANCELLATION_V1.to_string(),
                true,
            ),
            ("agentArtifactsV1".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_FILE_CAPABILITIES_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CONDITIONAL_READ_V1.to_string(),
                true,
            ),
            ("usageHistory".to_string(), true),
        ]),
    }
}
