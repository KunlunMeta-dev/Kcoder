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

request_codecs!(@paths
    kcoder_app_protocol::cross_session_messages::AgentMessagePolicyReadParams,
    kcoder_app_protocol::cross_session_messages::AgentMessagePolicySaveParams,
    kcoder_app_protocol::cross_session_messages::AgentMessageTargetsRpcParams,
    kcoder_app_protocol::cross_session_messages::AgentMessageSendRpcParams,
    kcoder_app_protocol::cross_session_messages::AgentMessageGetRpcParams,
    kcoder_app_protocol::cross_session_messages::AgentMessageResolveParams,
);

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
    AttachmentDraftRetainParams,
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
    ComputerUseTurnStatusParams,
    DeviceExecuteParams,
    ExecutionDefaultsSaveParams,
    ExtensionConflictsPreviewParams,
    ExtensionSkillPreferenceUpdateParams,
    ExtensionsInventoryParams,
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
    TurnSteerReceiptReadParams,
    UsageStatsParams,
    WebSearchStatusReadParams,
    WikiJobResumeParams,
    WikiPendingOrganizeParams,
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
    CronCreationReadResult,
    CronCreationContext,
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
    fn request_ids_preserve_their_wire_type_and_reject_non_ids() {
        for number in [0, 42, u64::MAX] {
            assert_eq!(
                decode::<RequestId>(json!(number)).unwrap(),
                RequestId::Number(number)
            );
        }
        assert_eq!(
            decode::<RequestId>(json!("42")).unwrap(),
            RequestId::String("42".into())
        );
        for value in [
            Value::Null,
            json!({}),
            json!([]),
            json!(true),
            json!(1.5),
            json!(-1),
        ] {
            assert!(decode::<RequestId>(value).is_err());
        }
    }

    #[test]
    fn model_selection_response_preserves_camel_case_wire_keys() {
        let value = ThreadModelSelectionResult {
            accepted: true,
            model: "provider::model".into(),
            applies_at: "nextTurn".into(),
        };
        assert_eq!(
            encode(value).unwrap(),
            json!({ "accepted": true, "model": "provider::model", "appliesAt": "nextTurn" })
        );
    }
}
