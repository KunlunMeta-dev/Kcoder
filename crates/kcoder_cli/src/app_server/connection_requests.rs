//! The original public JSON-RPC request pipeline, shared by every host transport.
use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use futures::FutureExt;
use kcoder_app_protocol::{
    MIGRATION_SOURCE_ADOPTION_CAPABILITY, MIGRATION_SOURCE_ASSET_IDENTITY_CAPABILITY,
    MIGRATION_SOURCE_ATTEMPT_CAPABILITY, MIGRATION_SOURCE_DEFINITIONS_CAPABILITY,
    MIGRATION_SOURCE_INTERNAL_CAPABILITY, MIGRATION_SOURCE_INTERNAL_PREFIX,
    MIGRATION_SOURCE_MEMORY_CAPABILITY, MIGRATION_SOURCE_PARENT_LAUNCH_CAPABILITY,
    MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY, MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY,
    MIGRATION_SOURCE_UPLOADED_CAPABILITY, PRIVATE_MIGRATION_SOURCE_FIELD,
    decode_private_migration_source_request,
};
use kcoder_app_rpc_codec as rpc_codec;

#[derive(Clone, Copy, Debug)]
enum PeerPolicyReadFailure {
    HostUnavailable,
    SourceRequired,
    InvalidSource,
    SourceUnavailable,
    SourceEphemeral,
    SourceNotIndependent,
    WorkspaceMismatch,
    LeaseUnavailable,
    LeaseTargetMismatch,
    LeaseUnverified,
    RequestInvalid,
    ReadUnavailable,
}
impl PeerPolicyReadFailure {
    fn code(self) -> &'static str {
        match self {
            Self::HostUnavailable => "peer_policy_host_unavailable",
            Self::SourceRequired => "peer_policy_source_required",
            Self::InvalidSource => "peer_policy_invalid_source",
            Self::SourceUnavailable => "peer_policy_source_unavailable",
            Self::SourceEphemeral => "peer_policy_source_ephemeral",
            Self::SourceNotIndependent => "peer_policy_source_not_independent",
            Self::WorkspaceMismatch => "peer_policy_workspace_mismatch",
            Self::LeaseUnavailable => "peer_policy_lease_unavailable",
            Self::LeaseTargetMismatch => "peer_policy_lease_target_mismatch",
            Self::LeaseUnverified => "peer_policy_lease_unverified",
            Self::RequestInvalid => "peer_policy_request_invalid",
            Self::ReadUnavailable => "peer_policy_read_unavailable",
        }
    }
}
impl std::fmt::Display for PeerPolicyReadFailure {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for PeerPolicyReadFailure {}

/// Diagnostic classification only. Never publish raw causes or use a reason as authority.
fn peer_policy_read_reason(error: &anyhow::Error) -> &'static str {
    let Some(failure) = error.downcast_ref::<PeerPolicyReadFailure>() else {
        return "peer_policy_read_unavailable";
    };
    if !matches!(
        failure,
        PeerPolicyReadFailure::LeaseUnverified | PeerPolicyReadFailure::ReadUnavailable
    ) {
        return failure.code();
    }
    for cause in error.chain() {
        let reason = match cause.to_string().as_str() {
            "SESSION_NATIVE_OWNER_CLOSED" => Some("peer_policy_lease_owner_closed"),
            "SESSION_NATIVE_OWNER_CHANGED" => Some("peer_policy_lease_identity_changed"),
            "peer_policy_profile_changed" => Some("peer_policy_profile_changed"),
            _ => None,
        };
        if let Some(reason) = reason {
            return reason;
        }
    }
    if matches!(failure, PeerPolicyReadFailure::ReadUnavailable) {
        if let Some(load) = error.downcast_ref::<kcoder_config::SettingsLoadFailure>() {
            return match load.kind {
                kcoder_config::SettingsLoadFailureKind::Parse
                | kcoder_config::SettingsLoadFailureKind::Schema => "peer_policy_settings_invalid",
                kcoder_config::SettingsLoadFailureKind::PrivateAccess => {
                    "peer_policy_settings_access_denied"
                }
                kcoder_config::SettingsLoadFailureKind::OverlayUnavailable => {
                    "peer_policy_settings_unavailable"
                }
            };
        }
        if error.chain().any(|cause| cause.is::<serde_json::Error>()) {
            return "peer_policy_settings_invalid";
        }
    }
    if let Some(io) = error.downcast_ref::<std::io::Error>() {
        // A Windows sharing/lock violation is a transient access failure, not a raw message match.
        if io.kind() == std::io::ErrorKind::WouldBlock
            || cfg!(windows) && matches!(io.raw_os_error(), Some(32 | 33))
        {
            return if matches!(failure, PeerPolicyReadFailure::LeaseUnverified) {
                "peer_policy_lease_busy"
            } else {
                "peer_policy_settings_busy"
            };
        }
        if io.kind() == std::io::ErrorKind::PermissionDenied {
            return if matches!(failure, PeerPolicyReadFailure::LeaseUnverified) {
                "peer_policy_lease_access_denied"
            } else {
                "peer_policy_settings_access_denied"
            };
        }
    }
    failure.code()
}

fn peer_policy_error_response(id: Value, read: bool, error: &anyhow::Error) -> Value {
    let mut response = error_response(id, -32034, "peer_message_policy_unconfirmed");
    if read {
        response["error"]["data"] = json!({"reason": peer_policy_read_reason(error)});
    }
    response
}

pub(super) struct RequestContext<'a> {
    pub engine: &'a mut QueryEngine,
    pub engine_factory: &'a AppServerEngineFactory,
    pub workspace_engine: &'a QueryEngine,
    pub permission_mode: kcoder_config::PermissionMode,
    pub outbound_tx: &'a mpsc::Sender<Value>,
    pub thread_manager: &'a mut ThreadManager,
    pub terminals: &'a TerminalRegistry,
    pub history_refresh: &'a mut history_refresh_processor::HistoryRefreshProcessor,
    pub browsers: &'a mut BrowserRegistry,
    pub plugin_tasks: &'a mut tokio::task::JoinSet<()>,
    pub migration_control_tasks: &'a mut tokio::task::JoinSet<()>,
    pub migration_observation_tasks: &'a mut tokio::task::JoinSet<()>,
    pub provider_tasks: &'a mut tokio::task::JoinSet<()>,
    pub indexed_read_tasks: &'a mut tokio::task::JoinSet<()>,
    pub automations: &'a mut project_automations::ProjectAutomations,
    pub automation_requested: &'a mut bool,
    pub idle_shutdown_requested: &'a mut bool,
    pub storage_scans: &'a storage_scans::StorageScans,
    pub provider_settings_state: &'a Result<provider_settings::ProviderSettingsState>,
    pub attachment_directories: &'a mut AttachmentDirectories,
    pub next_terminal_id: &'a AtomicU64,
    pub next_interaction_id: &'a Arc<AtomicU64>,
    pub connection_receipts: &'a Arc<StdMutex<InteractionReceipts>>,
    pub server_id: &'a String,
    pub sequence: &'a Arc<AtomicU64>,
    pub automation_fire: &'a Option<kcoder_tools::cron::CronFire>,
    pub state: &'a mut ConnectionState,
    pub thread_list_snapshots: &'a mut thread_list_snapshots::ThreadListSnapshots,
    pub retention_authority: &'a Option<Arc<retention_context::VerifiedRetentionAuthority>>,
    pub migration_source_authority:
        &'a Option<Arc<migration_source_authority::MigrationSourceAuthority>>,
    pub peer_service: &'a Option<Arc<session_messages::service::PeerMessageService>>,
    pub peer_backchannel: &'a Option<Arc<session_messages::backchannel::PeerRouterBackchannel>>,
    pub peer_router_rpc: &'a Option<Arc<session_messages::router_rpc::RouterRpc>>,
    pub allow_private_peer: bool,
    pub migration_processor: &'a Arc<migration_processor::MigrationProcessor>,
    pub plugin_processor: &'a PluginProcessor,
    pub mcp_authorization: &'a mcp_authorization_processor::McpAuthorizationProcessor,
    pub indexed_read_gates: &'a mut indexed_read_gate::IndexedReadGate,
    pub thread_presence_gate: &'a Arc<tokio::sync::Semaphore>,
    pub thread_presence_cancellation: &'a CancellationToken,
    pub thread_goal_status_gate: &'a Arc<tokio::sync::Semaphore>,
    pub thread_goal_status_cancellation: &'a CancellationToken,
    /// Who selected this request (owner-selected recovery, automation or
    /// client); installed on the state only for the duration of the dispatch.
    pub request_origin: request_origin::RequestOrigin,
    pub automation_responses: &'a project_automations::AutomationResponses,
}

pub(super) fn dispatch<'a>(
    context: RequestContext<'a>,
    line: &'a str,
) -> futures::future::LocalBoxFuture<'a, Result<DispatchControl>> {
    dispatch_inner(context, line).boxed_local()
}

async fn dispatch_inner(context: RequestContext<'_>, line: &str) -> Result<DispatchControl> {
    let RequestContext {
        engine,
        engine_factory,
        workspace_engine,
        permission_mode,
        outbound_tx,
        thread_manager,
        terminals,
        history_refresh,
        browsers,
        plugin_tasks,
        migration_control_tasks,
        migration_observation_tasks,
        provider_tasks,
        indexed_read_tasks,
        automations,
        automation_requested,
        idle_shutdown_requested,
        storage_scans,
        provider_settings_state,
        attachment_directories,
        next_terminal_id,
        next_interaction_id,
        connection_receipts,
        server_id,
        sequence,
        automation_fire,
        state,
        thread_list_snapshots,
        retention_authority,
        migration_source_authority,
        peer_service,
        peer_backchannel,
        peer_router_rpc,
        allow_private_peer,
        migration_processor,
        plugin_processor,
        mcp_authorization,
        indexed_read_gates,
        thread_presence_gate,
        thread_presence_cancellation,
        thread_goal_status_gate,
        thread_goal_status_cancellation,
        request_origin,
        automation_responses,
    } = context;
    let result: Result<DispatchControl> = async {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(
                frame_bytes = line.len(),
                object_offset = line.find('{'),
                %error,
                "invalid app-server JSON-RPC frame"
            );
            send(
                outbound_tx,
                error_response(
                    Value::Null,
                    -32700,
                    &format!(
                        "{error} (frame bytes: {}, object offset: {:?})",
                        line.len(),
                        line.find('{')
                    ),
                ),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
    };
    if peer_backchannel
        .as_ref()
        .is_some_and(|bridge| bridge.route_response(&request))
    {
        return Ok(DispatchControl::Continue);
    }
    #[cfg(target_os = "linux")]
    if state
        .native_acp_receiver_binding
        .as_ref()
        .is_some_and(|binding| binding.route_response(&request))
    {
        return Ok(DispatchControl::Continue);
    }
    if state
        .native_remote_host_client
        .as_ref()
        .is_some_and(|client| client.route_response(&request))
    {
        return Ok(DispatchControl::Continue);
    }
    let has_id = request
        .as_object()
        .is_some_and(|object| object.contains_key("id"));
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    if request
        .get(kcoder_app_protocol::cross_session_router::PRIVATE_AGENT_MESSAGE_ROUTE_FIELD)
        .is_some()
        && !method.starts_with(kcoder_app_protocol::cross_session_router::method::PREFIX)
    {
        send(
            outbound_tx,
            error_response(id, -32602, "Invalid private peer routing envelope"),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    if request.get(PRIVATE_MIGRATION_SOURCE_FIELD).is_some()
        && method != format!("{MIGRATION_SOURCE_INTERNAL_PREFIX}peer/accept")
    {
        send(
            outbound_tx,
            error_response(id, -32602, "Invalid private migration source envelope"),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    if method == kcoder_app_protocol::PRIVATE_RETENTION_REVOKE_METHOD_V1 {
        if let Some(response) = state.require_initialized(id.clone()) {
            send(outbound_tx, response).await?;
            return Ok(DispatchControl::Continue);
        }
        let result = match kcoder_app_protocol::decode_private_device_revocation(line) {
            Err(error) => Err(anyhow::Error::from(error)),
            Ok(private) => match retention_authority {
                None => Err(anyhow::anyhow!("private revocation parent unavailable")),
                Some(authority) => device_retention_cleanup::complete(
                    authority,
                    workspace_engine,
                    thread_manager,
                    &private.params,
                )
                .await
                .and_then(|result| serde_json::to_value(result).map_err(Into::into)),
            },
        };
        let response = match result {
            Ok(result) => success_response(id, result),
            Err(_) => error_response(
                id,
                -32001,
                "Private device cleanup pending or authority unavailable",
            ),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if kcoder_app_protocol::is_workspace_operation_v2(method) {
        if let Some(response) = state.require_initialized(id.clone()) {
            send(outbound_tx, response).await?;
            return Ok(DispatchControl::Continue);
        }
        let response = match retention_authority {
            None => error_response(id, -32001, "Workspace receipt authority unavailable"),
            Some(authority) => match kcoder_app_protocol::decode_private_retention_request(line) {
                Err(_) => error_response(id, -32602, "Invalid private workspace request"),
                Ok(private) => match authority.validate(&private) {
                    Err(code) => error_response(
                        id,
                        code,
                        "Workspace receipt authority or parameters rejected",
                    ),
                    Ok(()) => match workspace_operation_receipts_v2::dispatch(
                        authority,
                        workspace_engine,
                        &private,
                    )
                    .await
                    {
                        Ok(result) => success_response(id, result),
                        Err(error) => error_response(
                            id,
                            workspace_operation_receipts_v2::error_code(&error),
                            "Workspace receipt scope conflict or completion unknown",
                        ),
                    },
                },
            },
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if kcoder_app_protocol::is_attachment_retention_method(method) {
        if let Some(response) = state.require_initialized(id.clone()) {
            send(outbound_tx, response).await?;
            return Ok(DispatchControl::Continue);
        }
        // Decode the original frame, not its duplicate-key-erasing Value.
        // Missing/null IDs and request-shaped notifications cannot execute.
        let response = match kcoder_app_protocol::decode_private_retention_request(line) {
            Err(_) => error_response(
                id,
                -32602,
                attachment_retention_dispatch::error_message(-32602),
            ),
            Ok(private) => match retention_authority {
                None => error_response(
                    id,
                    kcoder_app_protocol::RETENTION_ERROR_AUTHORITY,
                    attachment_retention_dispatch::error_message(
                        kcoder_app_protocol::RETENTION_ERROR_AUTHORITY,
                    ),
                ),
                Some(authority) => match authority.validate(&private) {
                    Err(code) => {
                        error_response(id, code, attachment_retention_dispatch::error_message(code))
                    }
                    Ok(()) => {
                        match if kcoder_app_protocol::is_retention_upload_method(&private.method) {
                            attachment_retention_dispatch::dispatch_upload(authority, &private)
                                .and_then(|result| serde_json::to_value(result).map_err(Into::into))
                        } else {
                            retained_turn::dispatch_receipts(authority, workspace_engine, &private)
                                .and_then(|result| serde_json::to_value(result).map_err(Into::into))
                        } {
                            Ok(result) => success_response(id, json!(result)),
                            Err(error) => {
                                let code = attachment_retention_dispatch::error_code(&error);
                                error_response(
                                    id,
                                    code,
                                    attachment_retention_dispatch::error_message(code),
                                )
                            }
                        }
                    }
                },
            },
        };
        // Synchronous service transactions and owner leases have all dropped
        // before the outbound await. No provider/session activation occurs.
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    // A retained turn is executable only through the verified stdio-parent
    // envelope, irrespective of the still-disabled public capability.
    let retained_scope = if method == "turn/start"
        && params
            .get("retention")
            .is_some_and(|value| !value.is_null())
    {
        if let Some(response) = state.require_initialized(id.clone()) {
            send(outbound_tx, response).await?;
            return Ok(DispatchControl::Continue);
        }
        let scope = (|| -> std::result::Result<_, i64> {
            let private = kcoder_app_protocol::decode_private_retention_request(line)
                .map_err(|_| -32602i64)?;
            let authority = retention_authority
                .as_ref()
                .ok_or(kcoder_app_protocol::RETENTION_ERROR_AUTHORITY)?;
            authority.validate(&private)?;
            authority
                .retention_scope(&private)
                .map_err(|error| attachment_retention_dispatch::error_code(&error))
        })();
        match scope {
            Ok(scope) => Some(scope),
            Err(code) => {
                send(
                    outbound_tx,
                    error_response(id, code, attachment_retention_dispatch::error_message(code)),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
        }
    } else {
        None
    };
    if retained_scope.is_none() && retention_context::has_private_authority(&request) {
        let code = match retention_authority {
            None => -32001,
            Some(authority) => {
                match kcoder_app_protocol::decode_private_retention_request(line) {
                    Err(_) => -32602,
                    Ok(private) => match authority.validate(&private) {
                        Err(code) => code,
                        // Validated but intentionally not wired to the service yet.
                        Ok(()) => -32601,
                    },
                }
            }
        };
        send(
            outbound_tx,
            error_response(
                id,
                code,
                match code {
                    -32001 => "Private retention authority unavailable",
                    -32601 => "Retention lifecycle unavailable",
                    _ => "Invalid private retention request",
                },
            ),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    // Wiki operations are requests, never executable client notifications.
    if (method.starts_with("knowledge/")
        || method.starts_with("migration/")
        || matches!(
            method,
            method::WORKFLOW_REQUESTS
                | method::WORKFLOW_RESPOND
                | method::COMPUTER_USE_RECOVER
                | method::COMPUTER_USE_REVOKE
        ))
        && !request
            .as_object()
            .is_some_and(|object| object.contains_key("id"))
    {
        return Ok(DispatchControl::Continue);
    }

    if method.is_empty() && !id.is_null() {
        let mut outcome = resolve_server_response(
            &request,
            &state.mcp_app_pending_approvals,
            &state.mcp_app_pending_questions,
            connection_receipts,
            state.interaction_binding_v1,
        );
        for turn_state in thread_manager.turn_states() {
            if !matches!(outcome, InteractionReply::Unmatched) {
                break;
            }
            outcome = turn_state.resolve_response(&request, state.interaction_binding_v1);
            if !matches!(outcome, InteractionReply::Unmatched) {
                break;
            }
        }
        if matches!(outcome, InteractionReply::Misattributed)
            && let Some(request_id) = id.as_u64()
        {
            // The interaction is still pending: replay its request so the
            // client can answer with the identity the connection requires,
            // and never accept the unattributable decision.
            let request_notification = {
                let mut receipts = connection_receipts
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let request = receipts.outstanding_request(request_id);
                receipts.note_misattributed();
                request
            };
            tracing::warn!(
                request_id,
                "app-server interaction reply did not name its interaction and was rejected"
            );
            if let Some(notification) = request_notification {
                send(outbound_tx, notification).await?;
            }
            return Ok(DispatchControl::Continue);
        }
        if matches!(outcome, InteractionReply::Unmatched)
            && let Some(request_id) = id.as_u64()
        {
            let replayed = {
                let mut receipts = connection_receipts
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                receipts.replay(request_id)
            };
            match replayed {
                Some(notification) => send(outbound_tx, notification).await?,
                None => {
                    connection_receipts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .note_unmatched();
                    tracing::warn!(
                        request_id,
                        "app-server reply matched no pending interaction and was not applied"
                    );
                }
            }
        }
        return Ok(DispatchControl::Continue);
    }

    // Responses and interaction replies were handled above. From here on,
    // only protocol-typed request IDs may reach a method dispatcher. The
    // sole id-less inbound notification is `initialized`; it is a no-op
    // even before the initialize handshake completes.
    if method.is_empty() {
        return Ok(DispatchControl::Continue);
    }
    if method == "initialized" && !has_id {
        return Ok(DispatchControl::Continue);
    }
    if !has_id {
        return Ok(DispatchControl::Continue);
    }
    if rpc_codec::decode::<kcoder_app_protocol::RequestId>(id.clone()).is_err() {
        send(
            outbound_tx,
            error_response(Value::Null, -32600, "Invalid request ID"),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    if method == "initialized" {
        send(
            outbound_tx,
            error_response(id, -32600, "initialized must be sent as a notification"),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }

    if method.starts_with(kcoder_app_protocol::cross_session_router::ssh_enrollment::PEER_SSH_AUTH_PREFIX) {
        let response = if state.initialized || !allow_private_peer {
            error_response(id, -32601, "peer_ssh_auth_lane_unavailable")
        } else {
            match kcoder_app_protocol::cross_session_router::ssh_enrollment::PeerSshAuthRequestV1::decode(line) {
                Ok(request) => match peer_service.as_ref().context("peer_ssh_profile_unavailable")
                    .and_then(|service| service.authenticate_enrolled_ssh(&request)) {
                    Ok(value) => success_response(id, value),
                    Err(_) => error_response(id, -32034, "peer_ssh_auth_unconfirmed"),
                },
                Err(_) => error_response(id, -32602, "peer_ssh_auth_frame_invalid"),
            }
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }

    if method == "initialize" {
        let mut response = state.initialize_with_workspace_authority(
            id,
            &params,
            workspace_engine,
            retention_authority.is_some(),
        );
        if response.get("error").is_none() {
            super::evolution::install_change_sink(state, workspace_engine, thread_manager, outbound_tx);
            state.peer_router_private_v1=allow_private_peer
                &&peer_service.as_ref().is_some_and(|service|service.has_private_parent())
                &&params["capabilities"]["experimental"][kcoder_app_protocol::cross_session_router::CAPABILITY_AGENT_MESSAGE_ROUTER_PRIVATE_V1]==true;
            state.peer_router_private_v1 &= peer_router_rpc.is_some();
            response["result"]["capabilities"]["experimental"][kcoder_app_protocol::cross_session_router::CAPABILITY_AGENT_MESSAGE_ROUTER_PRIVATE_V1]=json!(state.peer_router_private_v1);
            response["result"]["capabilities"]["experimental"]
                [kcoder_app_protocol::cross_session_router::ssh_parent::CAPABILITY_PEER_SSH_PARENT_OFFER_V1] =
                json!(allow_private_peer && peer_service.as_ref().is_some_and(|service| service.peer_ssh_offer()));
            for name in [
                kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_DISCOVERY_V1,
                kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_DISCOVERY_SEARCH_V1,
                kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGES_V1,
                kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGE_REPLIES_V1,
                kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGE_RECEIPTS_V1,
                kcoder_app_protocol::cross_session_messages::CAPABILITY_PEER_AGENT_MESSAGES_V1,
            ] {
                response["result"]["capabilities"]["experimental"][name] = json!(
                    peer_service.is_some() && params["capabilities"]["experimental"][name] == true
                );
            }
            state.peer_presentation.negotiate(
                response["result"]["capabilities"]["experimental"]
                    [kcoder_app_protocol::cross_session_messages::CAPABILITY_PEER_AGENT_MESSAGES_V1]
                    == true,
            );
            // Routed ReadSession needs the private router lane on both sides. The echo is
            // the target's feature fact for the Gateway; it never authorizes a read.
            let session_read = state.peer_router_private_v1
                && params["capabilities"]["experimental"]
                    [kcoder_app_protocol::cross_session_messages::CAPABILITY_SESSION_READ_V1]
                    == true;
            response["result"]["capabilities"]["experimental"]
                [kcoder_app_protocol::cross_session_messages::CAPABILITY_SESSION_READ_V1] =
                json!(session_read);
            let wake_read = kcoder_app_protocol::cross_session_router::CAPABILITY_AGENT_MESSAGE_WAKE_READ_V1;
            response["result"]["capabilities"]["experimental"][wake_read] =
                json!(state.peer_router_private_v1 && params["capabilities"]["experimental"][wake_read] == true);
            if let Some(bridge) = peer_backchannel {
                bridge.negotiate_session_read(session_read);
                bridge.negotiate_background_replies(
                    state.peer_router_private_v1 && params["capabilities"]["experimental"]
                        [kcoder_app_protocol::cross_session_router::CAPABILITY_AGENT_MESSAGE_BACKGROUND_REPLY_V1] == true,
                );
                bridge.negotiate_message_replies(
                    state.peer_router_private_v1 && response["result"]["capabilities"]["experimental"]
                        [kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGE_REPLIES_V1] == true);
                bridge.negotiate_message_receipts(
                    state.peer_router_private_v1 && response["result"]["capabilities"]["experimental"]
                        [kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGE_RECEIPTS_V1] == true);
                bridge.negotiate_discovery_search(
                    state.peer_router_private_v1
                        && response["result"]["capabilities"]["experimental"]
                            [kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_DISCOVERY_SEARCH_V1] == true,
                );
                bridge.negotiate(
                    state.peer_router_private_v1
                        && peer_service
                            .as_ref()
                            .is_some_and(|service| service.peer_backchannel_ready()),
                );
            }
            if let Some(service) = peer_service {
                thread_manager.configure_peer_services(service.clone(), peer_backchannel.clone());
            }
            let history_worker_state = params
                .get("capabilities")
                .and_then(|value| value.get("experimental"))
                .and_then(|value| {
                    value.get(kcoder_app_protocol::MIGRATION_HISTORY_WORKER_STATE_CAPABILITY)
                })
                .and_then(Value::as_bool)
                == Some(true);
            migration_processor.negotiate_history_worker_state(history_worker_state);
            response["result"]["capabilities"]["experimental"]
                [kcoder_app_protocol::MIGRATION_HISTORY_WORKER_STATE_CAPABILITY] =
                json!(history_worker_state);
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_INTERNAL_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_ATTEMPT_CAPABILITY] = json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [kcoder_app_protocol::MIGRATION_SOURCE_PRIVATE_CREDENTIAL_PREPARATIONS_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [kcoder_app_protocol::MIGRATION_SOURCE_PRIVATE_CREDENTIAL_BUNDLES_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [kcoder_app_protocol::MIGRATION_SOURCE_PRIVATE_CREDENTIAL_SOURCE_OBSERVATION_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_ADOPTION_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_UPLOADED_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [kcoder_app_protocol::MIGRATION_SOURCE_PROJECTS_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_DEFINITIONS_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_MEMORY_CAPABILITY] = json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_ASSET_IDENTITY_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_TARGET_RECOVERY_CAPABILITY] =
                json!(migration_source_authority.is_some());
            response["result"]["capabilities"]["experimental"]
                [MIGRATION_SOURCE_PARENT_LAUNCH_CAPABILITY] = json!(true);
        }
        if response.get("error").is_none()
            && let Some(authority) = retention_authority
            && let Ok(admission) = authority.retention_service().upload_admission()
        {
            state.attach_upload_admission(&mut response, admission)?;
        }
        if state.initialized && params["capabilities"]["experimental"]["projectAutomations"] == true
        {
            *automation_requested = true;
        }
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if let Some(response) = state.require_initialized(id.clone()) {
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if method.starts_with(kcoder_app_protocol::cross_session_router::method::PREFIX) {
        if !state.peer_router_private_v1 || !allow_private_peer {
            send(
                outbound_tx,
                error_response(id, -32001, "peer_router_private_parent_unavailable"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let prepared = (|| -> Result<_> {
            let rpc = peer_router_rpc
                .as_ref()
                .context("peer_router_private_parent_unavailable")?;
            let private =
                kcoder_app_protocol::cross_session_router::PrivatePeerRouterRequest::decode(line)
                    .map_err(anyhow::Error::msg)?;
            rpc.prepare(private, thread_manager)
        })();
        match prepared {
            Err(_) => {
                send(
                    outbound_tx,
                    error_response(id, -32023, "peer_router_request_rejected"),
                )
                .await?
            }
            Ok(_) if plugin_tasks.len() >= 8 => {
                send(
                    outbound_tx,
                    error_response(id, -32044, "peer_router_host_busy"),
                )
                .await?
            }
            Ok(job) => {
                let output = outbound_tx.clone();
                let bind = method
                    == kcoder_app_protocol::cross_session_router::ssh_parent::PEER_SSH_PARENT_BIND;
                let peer_bridge = peer_backchannel.clone();
                plugin_tasks.spawn_shared(async move {
                    let result = tokio::task::spawn_blocking(move || job.execute()).await;
                    let frame = match result {
                        Ok(Ok(value)) => success_response(id, value),
                        Ok(Err(error)) => {
                            let mut frame = error_response(
                                id,
                                -32034,
                                "peer_router_original_operation_unconfirmed",
                            );
                            frame["error"]["data"] =
                                json!({"reason":session_messages::errors::reason(&error)});
                            frame
                        }
                        _ => {
                            error_response(id, -32034, "peer_router_original_operation_unconfirmed")
                        }
                    };
                    let activate = bind && frame.get("result").is_some();
                    // Queue the binding response first; only subsequent frames
                    // may start the Peer-specific reverse lane.
                    if send(&output, frame).await.is_ok()
                        && activate
                        && let Some(bridge) = peer_bridge
                    {
                        bridge.negotiate(true);
                    }
                });
            }
        }
        return Ok(DispatchControl::Continue);
    }
    if matches!(
        method,
        kcoder_app_protocol::cross_session_messages::method::POLICY_READ
            | kcoder_app_protocol::cross_session_messages::method::POLICY_SAVE
    ) {
        let result = (|| -> Result<Value> {
            let service = peer_service
                .as_ref()
                .context(PeerPolicyReadFailure::HostUnavailable)?;
            let source = params
                .get("sourceThreadId")
                .and_then(Value::as_str)
                .context(PeerPolicyReadFailure::SourceRequired)?;
            anyhow::ensure!(
                kcoder_types::cross_session_messages::valid_agent_message_id(source),
                PeerPolicyReadFailure::InvalidSource
            );
            let origin = thread_manager
                .engine(source)
                .context(PeerPolicyReadFailure::SourceUnavailable)?;
            anyhow::ensure!(!thread_manager.is_ephemeral(source), PeerPolicyReadFailure::SourceEphemeral);
            anyhow::ensure!(origin.is_independent_discovery_session(), PeerPolicyReadFailure::SourceNotIndependent);
            anyhow::ensure!(service.workspace_matches(&origin.state.cwd()), PeerPolicyReadFailure::WorkspaceMismatch);
            let lease = thread_manager.lease(source).context(PeerPolicyReadFailure::LeaseUnavailable)?;
            anyhow::ensure!(lease.matches_target(&origin.session_lease_target()), PeerPolicyReadFailure::LeaseTargetMismatch);
            lease.native_witness().context(PeerPolicyReadFailure::LeaseUnverified)?;
            let policy = if method
                == kcoder_app_protocol::cross_session_messages::method::POLICY_READ
            {
                let _: kcoder_app_protocol::cross_session_messages::AgentMessagePolicyReadParams =
                    rpc_codec::decode(params.clone()).context(PeerPolicyReadFailure::RequestInvalid)?;
                service.policy().context(PeerPolicyReadFailure::ReadUnavailable)?
            } else {
                let request:kcoder_app_protocol::cross_session_messages::AgentMessagePolicySaveParams=rpc_codec::decode(params.clone())?;
                let policy = service.save_policy(
                    &request.expected_revision,
                    request.enabled,
                    request.wake_idle,
                )?;
                thread_manager.configure_peer_services(service.clone(), peer_backchannel.clone());
                policy
            };
            Ok(serde_json::to_value(policy)?)
        })();
        let response = match result {
            Ok(value) => success_response(id, value),
            Err(error) => peer_policy_error_response(id, method == kcoder_app_protocol::cross_session_messages::method::POLICY_READ, &error),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if method.starts_with(MIGRATION_SOURCE_INTERNAL_PREFIX) {
        let Some(authority) = migration_source_authority.clone() else {
            send(
                outbound_tx,
                error_response(id, -32001, "source_transfer_authority_unavailable"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        };
        let private = match decode_private_migration_source_request(line) {
            Ok(value) => value,
            Err(_) => {
                send(
                    outbound_tx,
                    error_response(id, -32602, "source_transfer_invalid_request"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let control = method.ends_with("/cancel") || method.ends_with("/resume");
        let observation = method.ends_with("/state")
            || method.ends_with("/intent")
            || method.ends_with("/receipt")
            || method.ends_with("/read")
            || method.ends_with("/manifest")
            || method.ends_with("/chunk");
        let tasks = if control {
            migration_control_tasks
        } else if observation {
            migration_observation_tasks
        } else {
            plugin_tasks
        };
        let capacity = if control || observation {
            2 * kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY
        } else {
            16
        };
        if tasks.len() >= capacity {
            send(
                outbound_tx,
                error_response(id, -32044, "source_transfer_capacity_reached"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let processor = migration_processor.clone();
        let factory = engine_factory.clone();
        let outbound = outbound_tx.clone();
        tasks.spawn_shared(async move {
            let response = tokio::task::spawn_blocking(move || {
                processor.process_source_transfer(&authority, std::sync::Arc::new(factory), private)
            })
            .await
            .unwrap_or_else(|_| {
                error_response(id, -32047, "source_transfer_operation_unconfirmed")
            });
            let _ = send(&outbound, response).await;
        });
        return Ok(DispatchControl::Continue);
    }
    if method.starts_with("migration/") {
        // Keep status/cancel independent of all slow scans and plugin operations.
        let observation = migration_processor::MigrationProcessor::history_observation(method);
        let tasks = if observation {
            migration_observation_tasks
        } else if migration_processor::MigrationProcessor::history_control(method) {
            migration_control_tasks
        } else {
            plugin_tasks
        };
        let capacity = if observation {
            migration_processor::MAX_HISTORY_OBSERVATIONS
        } else if migration_processor::MigrationProcessor::history_control(method) {
            // Admitted jobs plus their original cancellation/control requests.
            2 * kcoder_migration::history_jobs::HISTORY_IMPORT_CONCURRENCY
        } else {
            4
        };
        if tasks.len() >= capacity {
            send(
                outbound_tx,
                error_response(id, -32044, "migration_capacity_reached"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let processor = migration_processor.clone();
        let factory = engine_factory.clone();
        let operation = method.to_owned();
        let outbound = outbound_tx.clone();
        tasks.spawn_shared(async move {
            let reply_id = id.clone();
            let permit = if observation {
                let cancellation=processor.cancellation();
                tokio::select! {
                    biased;
                    _=cancellation.cancelled()=>{let _=send(&outbound,error_response(id,-32047,"migration_observation_cancelled")).await;return;}
                    permit=processor.observation_permit()=>match permit {Ok(permit)=>Some(permit),Err(_)=>{let _=send(&outbound,error_response(id,-32047,"migration_observation_cancelled")).await;return;}}
                }
            } else {None};
            let response = tokio::task::spawn_blocking(move || {
                // Keep the slot until native work settles, even if its observer goes away.
                let _permit=permit;
                processor.process(&factory, id, &operation, params)
            })
            .await
            .unwrap_or_else(|_| error_response(reply_id, -32047, "migration_operation_failed"));
            let _ = send(&outbound, response).await;
        });
        return Ok(DispatchControl::Continue);
    }
    if method == method::THREAD_GOAL_STATUS_READ_MANY {
        if !state.thread_goal_status_batch_v1 {
            send(
                outbound_tx,
                error_response(
                    id,
                    -32602,
                    "threadGoalStatusBatchV1 negotiation is required",
                ),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let ids = match thread_goal_status_batch_requests::parse_params(params) {
            Some(ids) => ids,
            None => {
                send(
                    outbound_tx,
                    error_response(id, -32602, "invalid thread/goal/status/readMany params"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
        };
        if indexed_read_tasks.len() >= 4 {
            let result = thread_goal_status_batch_requests::unavailable_result(&ids);
            send(
                outbound_tx,
                success_response(id, serde_json::to_value(result)?),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        thread_goal_status_batch_requests::spawn(
            indexed_read_tasks,
            id,
            ids,
            workspace_engine,
            thread_manager,
            outbound_tx.clone(),
            thread_goal_status_gate.clone(),
            thread_goal_status_cancellation.clone(),
        );
        return Ok(DispatchControl::Continue);
    }
    if method == method::THREAD_PRESENCE_READ {
        if !state.thread_presence_read_v1 {
            send(
                outbound_tx,
                error_response(id, -32602, "threadPresenceReadV1 negotiation is required"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let params = match thread_presence_requests::parse_params(params) {
            Some(params) => params,
            None => {
                send(
                    outbound_tx,
                    error_response(id, -32602, "invalid thread/presence/read params"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let permit = match thread_presence_gate.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let response = success_response(
                    id,
                    serde_json::to_value(thread_presence_requests::unknown(
                        &params.thread_id,
                        kcoder_app_protocol::ThreadPresenceReadUnknownReasonV1::Busy,
                    ))
                    .expect("presence result serializes"),
                );
                send(outbound_tx, response).await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let thread_id = params.thread_id;
        let input =
            thread_presence_requests::capture_input(&thread_id, workspace_engine, thread_manager);
        thread_presence_requests::spawn_observation_task(
            indexed_read_tasks,
            id,
            thread_id,
            outbound_tx.clone(),
            permit,
            thread_presence_cancellation.clone(),
            input,
        );
        return Ok(DispatchControl::Continue);
    }
    if method == method::INTERACTION_STATUS_READ {
        let read_result = {
            let receipts = connection_receipts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            interaction_requests::read_interaction_status(
                state.interaction_status_read_v1,
                params,
                &receipts,
                |params| {
                    thread_manager
                        .turn_state(&params.thread_id)
                        .and_then(|turn_state| {
                            turn_state.pending_interaction_matches(
                                params,
                                &state.mcp_app_pending_approvals,
                            )
                        })
                },
            )
        };
        let response = match read_result {
            Ok(result) => success_response(id, serde_json::to_value(result)?),
            Err(interaction_requests::InteractionStatusReadError::Unsupported) => error_response(
                id,
                -32601,
                "interactionStatusReadV1 is unsupported or was not negotiated",
            ),
            Err(interaction_requests::InteractionStatusReadError::InvalidParams) => {
                error_response(id, -32602, "invalid interaction/status/read params")
            }
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if matches!(method, method::THREAD_READ | method::THREAD_READ_INDEXED) {
        let indexed = method == method::THREAD_READ_INDEXED;
        if indexed_read_tasks.len() >= 4 {
            send(
                outbound_tx,
                error_response(
                    id,
                    -32044,
                    "History read capacity reached; retry later",
                ),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let params = match rpc_codec::decode::<ThreadReadParams>(params) {
            Ok(params) => params,
            Err(_) => {
                let response = if indexed {
                    error_response(id, -32602, "invalid indexed transcript params")
                } else {
                    error_response(id, -32021, "invalid thread/read params")
                };
                send(outbound_tx, response).await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let target = thread_manager
            .engine(&params.thread_id)
            .unwrap_or_else(|| workspace_engine.clone());
        let read_gate = match indexed_read_gates.for_thread(&params.thread_id) {
            Ok(gate) => gate,
            Err(error) => {
                let response = if indexed {
                    error_response(id, -32602, "invalid transcript thread")
                } else {
                    error_response(id, -32021, &error.to_string())
                };
                send(outbound_tx, response).await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let running = thread_manager.running_thread_ids();
        let run_projection = ThreadRunProjection::for_thread(
            thread_manager,
            state.run_summary_v1,
            &params.thread_id,
        );
        let outbound = outbound_tx.clone();
        let transcript_snapshot_v1 = state.transcript_snapshot_v1;
        let transcript_observation_v1 = state.transcript_observation_v1;
        let peer_format = state.peer_presentation.supported();
        indexed_read_tasks.spawn_shared(async move {
            let read_guard = read_gate.lock_owned().await;
            let mut response = if indexed {
                indexed_transcript::original_response(
                    &target,
                    params,
                    &running,
                    run_projection,
                    transcript_snapshot_v1,
                    transcript_observation_v1,
                    id,
                )
                .await
            } else {
                thread_read_requests::legacy_response(
                    id,
                    &target,
                    params,
                    &running,
                    run_projection,
                    transcript_snapshot_v1,
                )
                .await
            };
            if let Some(result) = response.get_mut("result") {
                rpc_hub::project_peer_history(result, peer_format);
            }
            drop(read_guard);
            if let Err(error) = send(&outbound, response).await {
                tracing::warn!(%error, "failed to send transcript");
            }
        });
        return Ok(DispatchControl::Continue);
    }
    if method == method::SKILL_LIST {
        let result = rpc_codec::decode::<kcoder_app_protocol::SkillListParams>(params)
            .map_err(|_| anyhow::anyhow!("Invalid skill list parameters"))
            .and_then(|params| {
                let profile = engine_factory.profile_paths()?.config_dir;
                let registry = engine_factory.current_skills()?;
                Ok(skill_processor::list(&registry, params.include_disabled, &profile))
            })
            .and_then(|result| serde_json::to_value(result).map_err(Into::into));
        let response = match result {
            Ok(result) => success_response(id, result),
            Err(error) => error_response(id, -32021, &error.to_string()),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if matches!(
        method,
        method::SKILL_IMPORT | method::SKILL_REMOVE | method::SKILL_SET_ENABLED
    ) {
        if plugin_tasks.len() >= 4 {
            send(
                outbound_tx,
                error_response(
                    id,
                    -32044,
                    "Extension management capacity reached; retry later",
                ),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let outbound = outbound_tx.clone();
        let operation = method.to_owned();
        let profile = match engine_factory.profile_paths() {
            Ok(paths) => paths.config_dir,
            Err(error) => {
                send(outbound_tx, error_response(id, -32021, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let registry =
            (operation == method::SKILL_SET_ENABLED).then(|| engine_factory.current_skills());
        plugin_tasks.spawn_shared(async move {
            let result: Result<Value> = if operation == method::SKILL_IMPORT {
                match rpc_codec::decode::<kcoder_app_protocol::SkillImportParams>(params) {
                    Ok(params) => skill_processor::import(params, profile)
                        .await
                        .and_then(|result| serde_json::to_value(result).map_err(Into::into)),
                    Err(_) => Err(anyhow::anyhow!("Invalid skill import parameters")),
                }
            } else if operation == method::SKILL_SET_ENABLED {
                match (
                    rpc_codec::decode::<kcoder_app_protocol::SkillSetEnabledParams>(params),
                    registry,
                ) {
                    (Ok(params), Some(Ok(registry))) => {
                        skill_processor::set_enabled(params, registry, profile)
                            .await
                            .and_then(|result| serde_json::to_value(result).map_err(Into::into))
                    }
                    (_, Some(Err(error))) => Err(error),
                    _ => Err(anyhow::anyhow!("Invalid skill activation parameters")),
                }
            } else {
                match rpc_codec::decode::<kcoder_app_protocol::SkillRemoveParams>(params) {
                    Ok(params) => skill_processor::remove(params, profile)
                        .await
                        .and_then(|result| serde_json::to_value(result).map_err(Into::into)),
                    Err(_) => Err(anyhow::anyhow!("Invalid skill removal parameters")),
                }
            };
            let response = match result {
                Ok(result) => success_response(id, result),
                Err(error) => error_response(id, -32021, &error.to_string()),
            };
            if let Err(error) = send(&outbound, response).await {
                tracing::warn!(%error, "failed to send skill management response");
            }
        });
        return Ok(DispatchControl::Continue);
    }
    if extensions_inventory::handles(method) {
        if plugin_tasks.len() >= 4 {
            send(
                outbound_tx,
                error_response(
                    id,
                    -32044,
                    "Extension management capacity reached; retry later",
                ),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let factory = engine_factory.clone();
        let outbound = outbound_tx.clone();
        let operation = method.to_owned();
        plugin_tasks.spawn_shared(async move {
            let response = extensions_inventory::process(factory, id, operation, params).await;
            if let Err(error) = send(&outbound, response).await {
                tracing::warn!(%error, "failed to send extension inventory response");
            }
        });
        return Ok(DispatchControl::Continue);
    }
    if matches!(
        method,
        method::HOOK_CONFIGURATION_READ | method::HOOK_CONFIGURATION_UPDATE
    ) {
        if plugin_tasks.len() >= 4 {
            send(
                outbound_tx,
                error_response(id, -32044, "Hook management capacity reached; retry later"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let factory = engine_factory.clone();
        let outbound = outbound_tx.clone();
        let operation = method.to_owned();
        plugin_tasks.spawn_shared(async move {
            let response = hook_configuration::process(factory, id, operation, params).await;
            if let Err(error) = send(&outbound, response).await {
                tracing::warn!(%error, "failed to send Hook configuration response");
            }
        });
        return Ok(DispatchControl::Continue);
    }
    if matches!(
        method,
        method::MCP_LIST
            | method::MCP_INSTALL
            | method::MCP_SET_ENABLED
            | method::MCP_REMOVE
            | method::MCP_LOGOUT
            | method::MCP_PROVIDER_REVOCATION
            | method::MCP_LOGIN
            | method::MCP_CALLBACK
            | method::MCP_CANCEL
    ) {
        if plugin_tasks.len() >= 4 {
            send(
                outbound_tx,
                error_response(id, -32044, "MCP management capacity reached; retry later"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let factory = engine_factory.clone();
        let outbound = outbound_tx.clone();
        let operation = method.to_owned();
        let authorization = mcp_authorization.clone();
        plugin_tasks.spawn_shared(async move {
            let result = if operation == method::MCP_LIST {
                mcp_processor::list(factory)
                    .await
                    .and_then(|result| Ok(serde_json::to_value(result)?))
            } else if operation == method::MCP_SET_ENABLED {
                match rpc_codec::decode::<kcoder_app_protocol::McpSetEnabledParams>(params) {
                    Ok(params) => mcp_processor::set_enabled(factory, params)
                        .await
                        .and_then(|value| Ok(serde_json::to_value(value)?)),
                    Err(_) => Err(anyhow::anyhow!("Invalid MCP activation parameters")),
                }
            } else if operation == method::MCP_INSTALL {
                match rpc_codec::decode::<kcoder_app_protocol::McpInstallParams>(params) {
                    Ok(params) => mcp_processor::install(factory, params)
                        .await
                        .and_then(|value| Ok(serde_json::to_value(value)?)),
                    Err(_) => Err(anyhow::anyhow!("Invalid MCP installation parameters")),
                }
            } else if operation == method::MCP_REMOVE {
                match rpc_codec::decode::<kcoder_app_protocol::McpServerParams>(params) {
                    Ok(params) => mcp_processor::remove(factory, params)
                        .await
                        .and_then(|value| Ok(serde_json::to_value(value)?)),
                    Err(_) => Err(anyhow::anyhow!("Invalid MCP removal parameters")),
                }
            } else if operation == method::MCP_PROVIDER_REVOCATION {
                match rpc_codec::decode::<kcoder_app_protocol::McpProviderRevocationParams>(params)
                {
                    Ok(params) => mcp_processor::provider_revocation(factory, params)
                        .await
                        .and_then(|value| Ok(serde_json::to_value(value)?)),
                    Err(_) => Err(anyhow::anyhow!("MCP_REVOCATION_INPUT_INVALID")),
                }
            } else if operation == method::MCP_LOGIN {
                match rpc_codec::decode::<kcoder_app_protocol::McpLoginParams>(params) {
                    Ok(params) => authorization
                        .login(factory, params)
                        .await
                        .and_then(|value| Ok(serde_json::to_value(value)?)),
                    Err(_) => Err(anyhow::anyhow!("Invalid MCP login parameters")),
                }
            } else if operation == method::MCP_CALLBACK {
                match rpc_codec::decode::<kcoder_app_protocol::McpCallbackParams>(params) {
                    Ok(params) => authorization
                        .callback(factory, params)
                        .await
                        .map(|()| json!({"authorized":true})),
                    Err(_) => Err(anyhow::anyhow!("Invalid MCP callback parameters")),
                }
            } else if operation == method::MCP_CANCEL {
                match rpc_codec::decode::<kcoder_app_protocol::McpCancelParams>(params) {
                    Ok(params) => authorization
                        .cancel(params)
                        .await
                        .map(|()| json!({"cancelled":true})),
                    Err(_) => Err(anyhow::anyhow!("Invalid MCP cancellation parameters")),
                }
            } else {
                match rpc_codec::decode::<kcoder_app_protocol::McpServerParams>(params) {
                    Ok(params) => mcp_processor::logout(factory, params)
                        .await
                        .and_then(|result| Ok(serde_json::to_value(result)?)),
                    Err(_) => Err(anyhow::anyhow!("Invalid MCP server selection")),
                }
            };
            let response = match result {
                Ok(result) => success_response(id, result),
                Err(error) => error_response(id, -32021, &error.to_string()),
            };
            if let Err(error) = send(&outbound, response).await {
                tracing::warn!(%error, "failed to send MCP management response");
            }
        });
        return Ok(DispatchControl::Continue);
    }
    if PluginProcessor::handles(method) {
        let desktop_revocation =
            matches!(method, method::PLUGIN_DISABLE | method::PLUGIN_UNINSTALL)
                && params.get("pluginId").and_then(Value::as_str)
                    == Some(kcoder_plugins::COMPUTER_USE_PLUGIN_ID);
        let desktop_grants = if desktop_revocation {
            thread_manager
                .turn_states()
                .into_iter()
                .map(|state| state.desktop_grant)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let observation = if method == method::PLUGIN_ACTIVATION_READ {
            let result = (|| -> Result<_> {
                let input: kcoder_app_protocol::PluginActivationParams =
                    rpc_codec::decode(params.clone())?;
                if let Some(thread_id) = input.thread_id {
                    let target = thread_manager
                        .engine(&thread_id)
                        .context("Plugin conversation is not resident")?;
                    ensure_active_thread(&target, thread_manager.lease(&thread_id), &thread_id)?;
                    Ok(Some(plugin_processor::capture(
                        &target,
                        &input.plugin_id,
                        engine_factory,
                    )))
                } else {
                    Ok(None)
                }
            })();
            match result {
                Ok(value) => value,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            }
        } else {
            None
        };
        let processor = plugin_processor.clone();
        let plugin_outbound = outbound_tx.clone();
        let method = method.to_string();
        let conflict_factory = (state.extensions_inventory_v1
            && matches!(method.as_str(), method::PLUGIN_INSTALL | method::PLUGIN_READ))
            .then(|| engine_factory.clone());
        plugin_tasks.spawn_shared(async move {
            let mut response = processor
                .process_observed(id, &method, params, observation)
                .await;
            if let Some(factory) = conflict_factory {
                extensions_inventory::attach_plugin_conflicts(factory, &mut response).await;
            }
            if response.get("error").is_none() {
                for grant in desktop_grants {
                    grant
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .revoke();
                }
            }
            if let Err(error) = send(&plugin_outbound, response).await {
                tracing::warn!(%error, "failed to send app-server plugin response");
            }
        });
        return Ok(DispatchControl::Continue);
    }

    if matches!(
        method,
        kcoder_app_protocol::method::PROVIDERS_UPSERT
            | kcoder_app_protocol::method::PROVIDERS_PROBE
            | kcoder_app_protocol::method::PROVIDERS_DISCOVER_MODELS
    ) {
        if provider_tasks.len() >= 4 {
            send(
                outbound_tx,
                error_response(
                    id,
                    -32034,
                    "[provider_probe_busy] Too many API validations; retry shortly",
                ),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let Ok(snapshot) = provider_settings_state.as_ref() else {
            send(
                outbound_tx,
                error_response(id, -32602, "Provider configuration snapshot is unavailable"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        };
        let snapshot = snapshot.clone();
        let target = match runtime_requests::selected_provider_engine(
            workspace_engine,
            thread_manager,
            &params,
        ) {
            Ok(target) => target,
            Err(error) => {
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
        };
        let independent_probe = method == kcoder_app_protocol::method::PROVIDERS_PROBE;
        let discovery = method == kcoder_app_protocol::method::PROVIDERS_DISCOVER_MODELS;
        let outbound = outbound_tx.clone();
        provider_tasks.spawn_shared(async move {
            let result = if discovery {
                provider_settings::discover_models(target, params).await
            } else if independent_probe {
                provider_settings::probe(target, params).await
            } else {
                provider_settings::upsert(target, snapshot, params).await
            };
            let response = match result {
                Ok(result) => success_response(id, result),
                Err(error) => error_response(id, -32602, &error.to_string()),
            };
            let _ = send(&outbound, response).await;
        });
        return Ok(DispatchControl::Continue);
    }

    let dispatched_request_id = id.clone();
    if method == method::THREAD_RESUME
        && request_origin == request_origin::RequestOrigin::ClientFrame
        && state.defer_thread_resumes
        && state.ready_thread_resume.is_none()
    {
        state.thread_resume_input = Some(thread_resume_preparation::Input::Client(line.to_owned()));
    }
    if method == "turn/start" && request_origin == request_origin::RequestOrigin::ClientFrame && state.initialized {
        if let Some(ready) = &state.ready_user_turn {
            if ready.verify(thread_manager, state).is_err() {
                state.ready_user_turn = None;
                send(outbound_tx, error_response(id, -32034, "TURN_ADMISSION_OWNER_CHANGED_RECONCILE_ORIGINAL")).await?;
                return Ok(DispatchControl::Continue);
            }
        } else {
            let prepared = state.deferred_user_turns.prepare(line, &id, &params, thread_manager,
                &state.source_management_owner, &state.input_ended)?;
            match prepared {
                deferred_user_turn::Preparation::Ordinary => {},
                deferred_user_turn::Preparation::Ready(ready) => state.ready_user_turn = Some(*ready),
                deferred_user_turn::Preparation::Deferred => return Ok(DispatchControl::Continue),
                deferred_user_turn::Preparation::Busy => {
                    send(outbound_tx, error_response(id, TURN_ALREADY_RUNNING, "Turn admission already pending")).await?;
                    return Ok(DispatchControl::Continue);
                },
            }
        }
    }
    let previous_request_origin = std::mem::replace(&mut state.request_origin, request_origin);
    // Bound the transport future's type while keeping the Core's borrowed request local.
    let dispatch_result = rpc_dispatch::dispatch(
        method,
        id,
        params,
        engine,
        workspace_engine,
        outbound_tx,
        thread_manager,
        terminals,
        history_refresh,
        browsers,
        plugin_tasks,
        migration_control_tasks.len()
            + migration_observation_tasks.len()
            + migration_processor.activity(),
        provider_tasks,
        indexed_read_tasks,
        automations,
        automation_requested,
        idle_shutdown_requested,
        engine_factory,
        storage_scans,
        provider_settings_state,
        attachment_directories,
        next_terminal_id,
        permission_mode,
        next_interaction_id,
        connection_receipts,
        server_id,
        sequence,
        automation_fire,
        state,
        thread_list_snapshots,
        retained_scope
            .as_ref()
            .zip(retention_authority.as_ref())
            .map(|(scope, authority)| retained_turn::Authority {
                service: authority.retention_service(),
                scope,
            }),
        retention_authority.as_deref(),
    )
    .boxed_local()
    .await;
    state.request_origin = previous_request_origin;
    if let Err(error) = &dispatch_result {
        automation_responses.dispatch_failed(&dispatched_request_id, &error.to_string());
    }
    dispatch_result
    }.await;
    state.ready_user_turn = None;
    state.thread_resume_input = None;
    state.ready_thread_resume = None;
    result
}

#[cfg(test)]
mod peer_policy_read_diagnostic_tests {
    use super::*;

    #[test]
    fn failed_policy_read_emits_only_closed_diagnostic_and_mutations_keep_old_error() {
        let secret = "PRIVATE_POLICY_CREDENTIAL_C:/Users/fixture/thread";
        let error = anyhow::anyhow!(secret).context(PeerPolicyReadFailure::SourceUnavailable);
        let read = peer_policy_error_response(json!(7), true, &error);
        assert_eq!(read["error"]["code"], -32034);
        assert_eq!(read["error"]["message"], "peer_message_policy_unconfirmed");
        assert_eq!(
            read["error"]["data"],
            json!({"reason":"peer_policy_source_unavailable"})
        );
        assert!(!read.to_string().contains(secret));
        let mutation = peer_policy_error_response(json!(7), false, &error);
        assert!(mutation["error"].get("data").is_none());
        assert_eq!(mutation["error"]["code"], -32034);
    }

    #[test]
    fn original_lease_identity_failures_are_not_settings_or_generic_unknown() {
        for (cause, expected) in [
            (
                "SESSION_NATIVE_OWNER_CLOSED",
                "peer_policy_lease_owner_closed",
            ),
            (
                "SESSION_NATIVE_OWNER_CHANGED",
                "peer_policy_lease_identity_changed",
            ),
        ] {
            let error = anyhow::anyhow!(cause).context(PeerPolicyReadFailure::LeaseUnverified);
            assert_eq!(peer_policy_read_reason(&error), expected);
            assert!(
                !peer_policy_error_response(json!(1), true, &error)
                    .to_string()
                    .contains("PRIVATE_TOKEN")
            );
        }
    }

    #[test]
    fn policy_settings_parse_access_and_revision_failures_remain_distinct() {
        let invalid = serde_json::from_value::<kcoder_config::CrossSessionMessagesSettings>(
            json!({"enabled":"invalid"}),
        )
        .unwrap_err();
        assert_eq!(
            peer_policy_read_reason(
                &anyhow::Error::new(invalid).context(PeerPolicyReadFailure::ReadUnavailable)
            ),
            "peer_policy_settings_invalid"
        );
        let denied = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            .context(PeerPolicyReadFailure::ReadUnavailable);
        assert_eq!(
            peer_policy_read_reason(&denied),
            "peer_policy_settings_access_denied"
        );
        let changed = anyhow::anyhow!("peer_policy_profile_changed")
            .context(PeerPolicyReadFailure::ReadUnavailable);
        assert_eq!(
            peer_policy_read_reason(&changed),
            "peer_policy_profile_changed"
        );
    }
}
