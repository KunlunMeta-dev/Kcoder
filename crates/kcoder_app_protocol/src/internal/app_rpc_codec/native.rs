//! Concrete decoders for Native RPC and private peer frames.

use super::DecodeJson;
use serde_json::{Result, Value};

request_codecs!(@paths
    kcoder_app_protocol::ApprovalRequestParams,
    kcoder_app_protocol::ThreadExpertResult,
    kcoder_app_protocol::ThreadResumeResult,
    kcoder_app_protocol::ThreadStartParams,
    kcoder_app_protocol::ThreadStartResult,
    kcoder_app_protocol::TurnCompletedParams,
    kcoder_app_protocol::TurnInterruptResult,
    kcoder_app_protocol::TurnStartResult,
    kcoder_app_protocol::integrations::channel_peer::ChannelPeerClientFrame,
    kcoder_app_protocol::integrations::connectivity::ConnectivityTaskBindingQuery,
    kcoder_app_protocol::integrations::connectivity::ConnectivityTaskBindingSummaryQuery,
    kcoder_app_protocol::integrations::connectivity::SdkOriginalMessageObservation,
    kcoder_app_protocol::integrations::connectivity::SdkWorkerReadyObservation,
    kcoder_app_protocol::integrations::connectivity::ServiceConnectionMemberObservations,
    kcoder_app_protocol::integrations::connectivity::ServiceMemberOriginalIngressObservation,
    kcoder_app_protocol::integrations::host::IntegrationOperationReadParams,
    kcoder_app_protocol::integrations::knowledge::MemoryListParams,
    kcoder_app_protocol::integrations::knowledge::MemoryProposeParams,
    kcoder_app_protocol::integrations::knowledge_settings::KnowledgeSettingsSaveParams,
    kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementParams,
    kcoder_app_protocol::integrations::office_settings::OfficeSettingsSaveParams,
    kcoder_types::integrations::connectivity::ConnectivityExternalChatRange,
    kcoder_types::integrations::connectivity::MessagingPlatform,
    kcoder_types::integrations::core::IntegrationDelegationPrepareParams,
    kcoder_types::integrations::core::IntegrationModelHealthReadParams,
    kcoder_types::integrations::core::IntegrationModelResolutionRequest,
    kcoder_types::integrations::core::IntegrationOperationReadResult,
    kcoder_types::integrations::core::IntegrationOwner,
    kcoder_types::integrations::core::IntegrationReply,
    kcoder_types::integrations::core::IntegrationRequest,
    kcoder_types::integrations::core::IntegrationRevisionRef,
    kcoder_types::integrations::core::IntegrationRuntimeReadTaskParams,
    kcoder_types::integrations::core::IntegrationRuntimeTask,
    kcoder_types::integrations::core::IntegrationScope,
    kcoder_types::integrations::core::IntegrationTaskCapabilitySourceChoicesParams,
    kcoder_types::integrations::core::IntegrationTaskCapabilityScopeSnapshot,
    kcoder_types::integrations::core::NativeScopeHostLaunchSpec,
    kcoder_types::integrations::core::NativeRemoteControlFrameV1,
    kcoder_types::integrations::core::NativeRemoteControlReplyV1,
    kcoder_types::integrations::core::NativeRemoteOriginalReadReplyV1,
    kcoder_types::integrations::core::NativeRemoteTargetRefV1,
    kcoder_types::integrations::core::RemoteOperationControlParams,
    kcoder_types::integrations::core::RemoteOperationListParams,
    kcoder_types::integrations::core::TaskWorkspaceReadParams,
    kcoder_types::integrations::knowledge::KnowledgePublication,
    kcoder_types::integrations::office::OfficeArtifactManifest,
    kcoder_types::integrations::office::OfficeArtifactPresentation,
    kcoder_types::integrations::office::OfficeArtifactRef,
    kcoder_types::integrations::office::OfficeAssistantDefinition,
    kcoder_types::integrations::office::OfficeCanonicalSourceReadParams,
    kcoder_types::integrations::office::OfficeGenerationSpec,
    kcoder_types::integrations::office::OfficeGeneratorIdentity,
    kcoder_types::integrations::office::OfficeMaterialReceipt,
    kcoder_types::integrations::office::OfficeTaskRef,
);

#[cfg(test)]
mod tests {
    use crate::decode;
    use kcoder_types::integrations::core::IntegrationRequest;
    use serde_json::{Value, json};

    #[test]
    fn native_envelope_values_and_errors_match_serde() {
        let valid = json!({
            "contractVersion": "parallel-v1",
            "requestId": "request-1",
            "scope": {
                "accountId": "account-1",
                "targetId": "target-1",
                "workspaceId": null,
                "identityGeneration": "generation-1",
                "targetRevision": "revision-1"
            },
            "timeoutMs": 1000,
            "payload": {}
        });
        let mut unknown_field = valid.clone();
        unknown_field["unexpected"] = json!(true);
        let mut invalid_scope = valid.clone();
        invalid_scope["scope"]["targetRevision"] = Value::Null;
        for value in [valid, unknown_field, invalid_scope, Value::Null] {
            let direct = serde_json::from_value::<IntegrationRequest>(value.clone())
                .map_err(|error| error.to_string());
            let moved = decode::<IntegrationRequest>(value).map_err(|error| error.to_string());
            assert_eq!(moved, direct);
        }
    }
}
