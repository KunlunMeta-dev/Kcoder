//! Pure protocol feature negotiation using readiness supplied by the connection host.

use kcoder_app_protocol::{self as protocol, ClientCapabilities, ServerCapabilities};
use std::collections::BTreeMap;

fn opted_in(client: &ClientCapabilities, name: &str) -> bool {
    client.experimental.get(name) == Some(&true)
}

/// Preserve the distinction between an omitted key and an explicit opt-out.
pub fn advertise_requested(
    client: &ClientCapabilities,
    advertised: &mut BTreeMap<String, bool>,
    name: &str,
    ready: bool,
) -> bool {
    let Some(requested) = client.experimental.get(name) else {
        return false;
    };
    let enabled = *requested && ready;
    advertised.insert(name.into(), enabled);
    enabled
}

/// Client opt-ins used by the connection after initialize completes.
pub struct ClientOptIns {
    pub isolated_widgets_v1: bool,
    pub mcp_apps_v1: bool,
    pub agent_turn_configuration_v1: bool,
    pub agent_definitions_v1: bool,
    pub studio_work_modes_v1: bool,
    pub inline_widgets_v1: bool,
    pub tool_path_preview_v1: bool,
    pub computer_use_session_authorization_v1: bool,
    pub computer_use_recovery_v1: bool,
    pub run_summary_v1: bool,
    pub thread_runtime_handoff_v1: bool,
    pub transcript_snapshot_v1: bool,
    pub transcript_observation_v1: bool,
    pub interaction_binding_v1: bool,
    pub interaction_status_read_v1: bool,
    pub approval_tool_call_identity_v1: bool,
    pub client_questions: bool,
    pub temporary_mcp_servers_v1: bool,
    pub session_lifetime_v1: bool,
    pub stream_context_v1: bool,
}
impl ClientOptIns {
    pub fn read(client: &ClientCapabilities) -> Self {
        Self {
            isolated_widgets_v1: opted_in(client, protocol::CAPABILITY_ISOLATED_WIDGETS_V1),
            mcp_apps_v1: opted_in(client, protocol::CAPABILITY_MCP_APPS_V1),
            agent_turn_configuration_v1: opted_in(
                client,
                protocol::CAPABILITY_AGENT_TURN_CONFIGURATION_V1,
            ),
            agent_definitions_v1: opted_in(client, "agentDefinitionsV1"),
            studio_work_modes_v1: opted_in(client, protocol::CAPABILITY_STUDIO_WORK_MODES_V1),
            inline_widgets_v1: opted_in(client, protocol::CAPABILITY_INLINE_WIDGETS_V1),
            tool_path_preview_v1: opted_in(client, "toolPathPreviewV1"),
            computer_use_session_authorization_v1: opted_in(
                client,
                protocol::CAPABILITY_COMPUTER_USE_SESSION_AUTHORIZATION_V1,
            ),
            computer_use_recovery_v1: opted_in(
                client,
                protocol::CAPABILITY_COMPUTER_USE_RECOVERY_V1,
            ),
            run_summary_v1: opted_in(client, protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1),
            thread_runtime_handoff_v1: opted_in(
                client,
                protocol::CAPABILITY_THREAD_RUNTIME_HANDOFF_V1,
            ) && cfg!(any(target_os = "linux", windows)),
            transcript_snapshot_v1: opted_in(
                client,
                protocol::CAPABILITY_THREAD_TRANSCRIPT_SNAPSHOT_V1,
            ),
            transcript_observation_v1: opted_in(
                client,
                protocol::CAPABILITY_THREAD_TRANSCRIPT_OBSERVATION_V1,
            ),
            interaction_binding_v1: opted_in(client, protocol::CAPABILITY_INTERACTION_BINDING_V1),
            interaction_status_read_v1: opted_in(
                client,
                protocol::CAPABILITY_INTERACTION_STATUS_READ_V1,
            ),
            approval_tool_call_identity_v1: opted_in(
                client,
                protocol::CAPABILITY_APPROVAL_TOOL_CALL_IDENTITY_V1,
            ),
            client_questions: !opted_in(client, protocol::CAPABILITY_DISABLE_USER_ELICITATION_V1),
            temporary_mcp_servers_v1: cfg!(any(unix, windows))
                && opted_in(client, protocol::CAPABILITY_THREAD_MCP_SERVERS_V1),
            session_lifetime_v1: opted_in(client, protocol::CAPABILITY_SESSION_LIFETIME_V1),
            stream_context_v1: opted_in(client, protocol::CAPABILITY_THREAD_STREAM_CONTEXT_V1),
        }
    }
}

pub struct ThreadOptIns {
    pub thread_presence_read_v1: bool,
    pub thread_goal_status_batch_v1: bool,
    pub async_user_questions_v1: bool,
}

pub fn advertise_thread_capabilities(
    client: &ClientCapabilities,
    capabilities: &mut ServerCapabilities,
    workspace_v2_ready: bool,
    tool_profiles: bool,
    target_default_model: bool,
    retry_model_configuration: bool,
) -> ThreadOptIns {
    capabilities.experimental.insert(
        protocol::CAPABILITY_WORKSPACE_OPERATION_RECEIPTS_V2.into(),
        workspace_v2_ready,
    );
    let thread_presence_read_v1 = cfg!(target_os = "linux")
        && client
            .experimental
            .get(protocol::CAPABILITY_THREAD_PRESENCE_READ_V1)
            .copied()
            .unwrap_or(false);
    capabilities.experimental.insert(
        protocol::CAPABILITY_THREAD_PRESENCE_READ_V1.into(),
        thread_presence_read_v1,
    );
    let thread_goal_status_batch_v1 = cfg!(target_os = "linux")
        && client
            .experimental
            .get(protocol::CAPABILITY_THREAD_GOAL_STATUS_BATCH_V1)
            .copied()
            .unwrap_or(false);
    if client
        .experimental
        .contains_key(protocol::CAPABILITY_THREAD_GOAL_STATUS_BATCH_V1)
    {
        capabilities.experimental.insert(
            protocol::CAPABILITY_THREAD_GOAL_STATUS_BATCH_V1.into(),
            thread_goal_status_batch_v1,
        );
    }
    // Four receipt handlers exist, but upload/transfer/deletion/reaper and
    // Mobile production are incomplete. Handler success is not readiness.
    capabilities.experimental.insert(
        protocol::CAPABILITY_STAGED_ATTACHMENT_RETENTION_RECEIPTS_V1.into(),
        false,
    );
    capabilities.experimental.insert(
        protocol::CAPABILITY_TOOL_SELECTIONS_V1.into(),
        tool_profiles,
    );
    capabilities.experimental.insert(
        protocol::CAPABILITY_LUNA_TOOL_SELECTIONS_V1.into(),
        tool_profiles,
    );
    capabilities.experimental.insert(
        protocol::CAPABILITY_TOOL_SELECTION_RESOLUTION_V1.into(),
        tool_profiles,
    );
    capabilities.experimental.insert(
        protocol::CAPABILITY_EXPERT_TOOL_SELECTION_V1.into(),
        tool_profiles,
    );
    capabilities
        .experimental
        .insert(protocol::CAPABILITY_TOOL_PROFILES_V1.into(), tool_profiles);
    capabilities
        .experimental
        .insert("modelSelectionModeV1".into(), target_default_model);
    capabilities.experimental.insert(
        protocol::CAPABILITY_RETRY_MODEL_CONFIGURATION_V1.into(),
        retry_model_configuration,
    );
    capabilities
        .experimental
        .insert(protocol::CAPABILITY_SESSION_LIFETIME_V1.into(), true);
    capabilities
        .experimental
        .insert(protocol::CAPABILITY_UNATTENDED_TURNS_V1.into(), true);
    capabilities.experimental.insert(
        protocol::CAPABILITY_CHANNEL_TOOL_RESTRICTIONS_V1.into(),
        true,
    );
    capabilities
        .experimental
        .insert(protocol::CAPABILITY_TURN_MODEL_SWITCH_V1.into(), true);
    capabilities
        .experimental
        .insert(protocol::CAPABILITY_TURN_REVIEW_EVIDENCE_V1.into(), true);
    let async_user_questions_v1 = client
        .experimental
        .get(protocol::CAPABILITY_ASYNC_USER_QUESTIONS_V1)
        .copied()
        .unwrap_or(false);
    capabilities.experimental.insert(
        protocol::CAPABILITY_ASYNC_USER_QUESTIONS_V1.into(),
        async_user_questions_v1,
    );
    ThreadOptIns {
        thread_presence_read_v1,
        thread_goal_status_batch_v1,
        async_user_questions_v1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_restriction_enforcement_is_explicitly_advertised() {
        let mut capabilities = ServerCapabilities::default();
        advertise_thread_capabilities(
            &ClientCapabilities::default(),
            &mut capabilities,
            false,
            false,
            false,
            false,
        );
        assert_eq!(
            capabilities
                .experimental
                .get(protocol::CAPABILITY_CHANNEL_TOOL_RESTRICTIONS_V1),
            Some(&true)
        );
    }

    #[test]
    fn optional_advertisement_distinguishes_missing_disabled_and_unavailable() {
        let mut client = ClientCapabilities::default();
        let mut advertised = BTreeMap::from([("existing".into(), true)]);
        assert!(!advertise_requested(
            &client,
            &mut advertised,
            "existing",
            true
        ));
        assert_eq!(advertised.get("existing"), Some(&true));
        assert!(!advertise_requested(
            &client,
            &mut advertised,
            "absent",
            true
        ));
        assert!(!advertised.contains_key("absent"));

        client.experimental.insert("existing".into(), false);
        assert!(!advertise_requested(
            &client,
            &mut advertised,
            "existing",
            true
        ));
        assert_eq!(advertised.get("existing"), Some(&false));

        client.experimental.insert("existing".into(), true);
        assert!(!advertise_requested(
            &client,
            &mut advertised,
            "existing",
            false
        ));
        assert_eq!(advertised.get("existing"), Some(&false));
        assert!(advertise_requested(
            &client,
            &mut advertised,
            "existing",
            true
        ));
        assert_eq!(advertised.get("existing"), Some(&true));
    }
}
