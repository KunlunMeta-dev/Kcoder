//! JSON value codecs for app-server contracts.

use serde_json::{Result, Value};

pub trait DecodeJson: Sized {
    fn decode_json(value: Value) -> Result<Self>;
}

pub trait EncodeJson {
    fn encode_json(self) -> Result<Value>;
}

pub fn decode<T: DecodeJson>(value: Value) -> Result<T> {
    T::decode_json(value)
}

pub fn encode<T: EncodeJson>(value: T) -> Result<Value> {
    value.encode_json()
}

// Keep serde's concrete instantiations in this crate so Cargo can compile
// them alongside the runtime's other dependencies.
macro_rules! request_codecs {
    ($($type:ident),+ $(,)?) => {
        request_codecs!(@paths $(kcoder_app_protocol::$type),+);
    };
    (@paths $($type:path),+ $(,)?) => {$(
        impl DecodeJson for $type {
            fn decode_json(value: Value) -> Result<Self> {
                serde_json::from_value(value)
            }
        }
    )+};
}

macro_rules! response_codecs {
    ($($type:ident),+ $(,)?) => {$(
        impl EncodeJson for kcoder_app_protocol::$type {
            fn encode_json(self) -> Result<Value> {
                serde_json::to_value(self)
            }
        }
    )+};
}

request_codecs!(
    AgentArtifactReadParams,
    AgentListParams,
    AgentLiveReadParams,
    AgentMessageReadParams,
    AgentMessagesArchiveParams,
    AgentMessagesListParams,
    AgentSteerParams,
    AsyncQuestionAnswerParams,
    AsyncQuestionCancelParams,
    AsyncQuestionListParams,
    AttachmentDeleteParams,
    AttachmentReadChunkParams,
    AttachmentReadParams,
    AttachmentRetentionConsumeParams,
    AttachmentRetentionReadParams,
    AttachmentRetentionReleaseParams,
    AttachmentRetentionReserveParams,
    AttachmentSaveParams,
    AttachmentUploadCancelParams,
    AttachmentUploadChunkParams,
    AttachmentUploadFinishParams,
    AttachmentUploadStartParams,
    BrowserActionParams,
    BrowserEvaluateParams,
    BrowserSessionParams,
    BrowserStartParams,
    ComputerUseRecoverParams,
    ComputerUseRevokeParams,
    ComputerUseStatusParams,
    DeviceExecuteParams,
    ExecutionDefaultsSaveParams,
    HookConfigurationReadParams,
    HookConfigurationUpdateParams,
    InitializeParams,
    KnowledgeDirectoryParams,
    KnowledgeImageImportParams,
    KnowledgeImportAttachmentParams,
    KnowledgeJobParams,
    KnowledgeJobStartParams,
    McpCallbackParams,
    McpCancelParams,
    McpInstallParams,
    McpLoginParams,
    McpProviderRevocationParams,
    McpServerParams,
    McpSetEnabledParams,
    PluginActivationParams,
    ProviderClearUserOverrideParams,
    ProviderListParams,
    ProviderProbeParams,
    ProviderTemplatesParams,
    RequestId,
    ServerIdleShutdownParams,
    SessionModesParams,
    SettingsTemplateDefaultParams,
    SettingsTemplateDeleteParams,
    SettingsTemplateReadParams,
    SettingsTemplateSaveParams,
    SkillImportParams,
    SkillListParams,
    SkillRemoveParams,
    SkillSetEnabledParams,
    StorageCleanParams,
    StorageScanCancelParams,
    StorageScanParams,
    TaskComparisonBindParams,
    TaskComparisonReadParams,
    TaskComparisonSelectParams,
    TerminalAttachParams,
    TerminalCloseParams,
    TerminalListParams,
    TerminalResizeParams,
    TerminalStartParams,
    TerminalWriteParams,
    ThreadCompactParams,
    ThreadCreationReadParams,
    ThreadDeleteParams,
    ThreadExpertParams,
    ThreadForkParams,
    ThreadGoalParams,
    ThreadGoalSetParams,
    ThreadHistoryRefreshParams,
    ThreadListParams,
    ThreadMetadataUpdateParams,
    ThreadModelSelectionParams,
    ThreadReadParams,
    ThreadRollbackParams,
    ToolSelectionsReadParams,
    ToolSelectionsSaveParams,
    ToolsSettingsReadParams,
    ToolsSettingsSaveParams,
    Turn,
    TurnInterruptParams,
    TurnStartParams,
    TurnSteerParams,
    UsageStatsParams,
    WebSearchStatusReadParams,
    WorkflowCollaborationCatalogParams,
    WorkspaceImportAttachmentParams,
);

response_codecs!(
    AgentSteerResult,
    ApprovalResolvedParams,
    AsyncQuestionAnswerResult,
    AsyncQuestionCancelResult,
    AsyncQuestionChangedNotification,
    AsyncQuestionListResult,
    ComputerUseRecoverResult,
    CronPreviewResult,
    ProviderDiscoveredModels,
    ProviderProbeResult,
    ProviderTemplatesResult,
    QuestionResolvedParams,
    RetentionInitializeResultV1,
    ThreadGoalGetResult,
    ThreadModelSelectionResult,
    TurnSteerResult,
    WidgetContentReadResult,
    WidgetListResult,
    WidgetReadResult,
    WidgetRenderReceiptResult,
);

#[path = "native.rs"]
mod native;

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_app_protocol::{RequestId, ThreadModelSelectionResult};
    use serde_json::json;

    #[test]
    fn request_id_values_and_errors_match_serde() {
        for value in [json!(42), json!("42"), Value::Null, json!(-1), json!({})] {
            let direct = serde_json::from_value::<RequestId>(value.clone())
                .map_err(|error| error.to_string());
            let moved = decode::<RequestId>(value).map_err(|error| error.to_string());
            assert_eq!(moved, direct);
        }
    }

    #[test]
    fn model_selection_response_matches_serde() {
        let value = ThreadModelSelectionResult {
            accepted: true,
            model: "provider::model".into(),
            applies_at: "nextTurn".into(),
        };
        assert_eq!(
            encode(value.clone()).unwrap(),
            serde_json::to_value(value).unwrap()
        );
    }
}
