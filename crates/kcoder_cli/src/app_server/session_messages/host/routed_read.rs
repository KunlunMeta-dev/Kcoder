//! Source side of a routed ReadSession: the real tool call is verified here, then the
//! read travels over the same authenticated peer-router lane as ListSessions and
//! SendSessionMessage. The target owner authorizes, projects and bounds the window.
use super::{PeerMessageService, PeerRouterBackchannel, ThreadManager, verify_captured_attempt};
use kcoder_app_protocol::cross_session_router::PeerRouterIdentityV1;
use kcoder_tools::session_discovery::SessionDiscoveryCall;
use kcoder_tools::session_read::{
    SessionReadError, SessionReadOutcome, SessionReadParams, SessionReadResult, SessionReadRoute,
};
use kcoder_types::TurnAttemptIdentity;
use std::sync::Arc;

pub(crate) enum ReadPlan {
    /// The address is this host; read locally with the owner's current policy.
    Local(SessionReadRoute),
    /// Another runtime target. `attempt` is the verified source attempt; `own` is this
    /// host's identity, used only to label the result's placement.
    Routed {
        attempt: TurnAttemptIdentity,
        own: PeerRouterIdentityV1,
    },
}

/// Verify the original ReadSession contribution exactly like a discovery request.
/// Nothing here is cached; the router and the target recheck on every read.
pub(super) fn plan(
    call: &SessionDiscoveryCall,
    params: &SessionReadParams,
    manager: &ThreadManager,
    service: &Arc<PeerMessageService>,
    bridge: Option<&Arc<PeerRouterBackchannel>>,
    own: PeerRouterIdentityV1,
) -> Result<ReadPlan, SessionReadError> {
    if !service.has_private_parent()
        || !bridge.is_some_and(|bridge| bridge.available() && bridge.supports_session_read())
    {
        return Err(SessionReadError::UNSUPPORTED_TARGET);
    }
    let input = serde_json::to_value(params).map_err(|_| SessionReadError::UNAVAILABLE)?;
    let id = call.state().session_id();
    let engine = manager.engine(&id).ok_or(SessionReadError::UNAVAILABLE)?;
    let valid = call.tool_name() == "ReadSession"
        && call.matches(&engine.state)
        && !manager.is_ephemeral(&id)
        && engine.is_independent_discovery_session()
        && service.workspace_matches(&engine.state.cwd())
        && engine
            .active_tool_registry()
            .get("ReadSession")
            .is_some_and(|tool| call.matches_registered_tool(tool.as_ref()))
        && manager.lease(&id).is_some_and(|lease| {
            lease.matches_target(&engine.session_lease_target()) && lease.native_witness().is_ok()
        })
        && engine.permissions.try_read().is_ok_and(|permissions| {
            !permissions.is_explicitly_denied("ReadSession", &input)
                && !permissions.is_explicitly_denied("ReadSession", &serde_json::json!({}))
        });
    if !valid {
        return Err(SessionReadError::UNAVAILABLE);
    }
    let attempt = verify_captured_attempt(
        &engine,
        call.state(),
        call.lifecycle(),
        call.captured_attempt(),
        "session_read_source_attempt_unavailable",
        "session_read_source_attempt_changed",
    )
    .map_err(|_| SessionReadError::UNAVAILABLE)?;
    Ok(ReadPlan::Routed { attempt, own })
}

/// Classify a router failure by its closed inner code only. A failure never proves
/// the conversation is missing, and it is never converted into a permission verdict
/// except when the router itself refused the destination for this source.
pub(super) fn routed_error(error: &anyhow::Error) -> SessionReadError {
    let inner = error.root_cause().to_string();
    let code = inner.as_str();
    if code.contains("timeout") || code == "agent_messages_native_request_outcome_unknown" {
        SessionReadError::TIMEOUT
    } else if code.contains("unsupported")
        || matches!(
            code,
            "peer_message_router_unavailable" | "peer_message_router_kind_unavailable"
        )
    {
        SessionReadError::UNSUPPORTED_TARGET
    } else if code == "agent_messages_target_not_authorized" {
        SessionReadError::NOT_PERMITTED
    } else if matches!(
        code,
        "agent_messages_destination_unavailable"
            | "agent_messages_destination_route_expired"
            | "agent_messages_endpoint_unavailable"
            | "agent_messages_endpoint_changed"
            | "agent_messages_endpoint_enumeration_unknown"
            | "agent_messages_identity_ambiguous"
            | "peer_message_router_channel_closed"
            | "peer_message_router_reply_dropped"
    ) {
        SessionReadError::TARGET_UNREACHABLE
    } else {
        SessionReadError::UNAVAILABLE
    }
}

pub(super) async fn request(
    bridge: &PeerRouterBackchannel,
    attempt: &TurnAttemptIdentity,
    params: SessionReadParams,
    own: &PeerRouterIdentityV1,
) -> Result<SessionReadResult, SessionReadError> {
    let address = params
        .target_address
        .clone()
        .ok_or(SessionReadError::UNSUPPORTED_TARGET)?;
    let payload = serde_json::to_value(&params).map_err(|_| SessionReadError::UNAVAILABLE)?;
    let value = bridge
        .request("read", attempt, payload)
        .await
        .map_err(|error| routed_error(&error))?;
    let outcome: SessionReadOutcome =
        serde_json::from_value(value).map_err(|_| SessionReadError::UNAVAILABLE)?;
    let mut result = match outcome {
        SessionReadOutcome::Refused { refused } => return Err(SessionReadError(refused)),
        SessionReadOutcome::Read { result } => *result,
    };
    if result.thread_id != params.thread_id
        || result.address.as_ref() != Some(&address)
        || result.turns.len() > params.turn_count()
    {
        return Err(SessionReadError::UNAVAILABLE);
    }
    // Placement comes from the verified address, never from the target's reply.
    result.other_target = address.target_id != own.target_id;
    result.other_workspace = !result.other_target;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chained(inner: &'static str) -> anyhow::Error {
        anyhow::anyhow!(inner).context("peer_message_router_outcome_unknown")
    }

    #[test]
    fn router_failures_map_to_distinct_typed_read_errors() {
        for (inner, expected) in [
            (
                "agent_messages_session_read_unsupported",
                SessionReadError::UNSUPPORTED_TARGET,
            ),
            (
                "agent_messages_router_unsupported",
                SessionReadError::UNSUPPORTED_TARGET,
            ),
            ("peer_message_router_timeout", SessionReadError::TIMEOUT),
            (
                "agent_messages_native_request_outcome_unknown",
                SessionReadError::TIMEOUT,
            ),
            (
                "agent_messages_destination_unavailable",
                SessionReadError::TARGET_UNREACHABLE,
            ),
            (
                "agent_messages_destination_route_expired",
                SessionReadError::TARGET_UNREACHABLE,
            ),
            (
                "agent_messages_target_not_authorized",
                SessionReadError::NOT_PERMITTED,
            ),
            (
                "agent_messages_native_result_unconfirmed",
                SessionReadError::UNAVAILABLE,
            ),
        ] {
            assert_eq!(routed_error(&chained(inner)), expected, "{inner}");
        }
    }

    #[tokio::test]
    async fn a_router_without_negotiated_read_is_an_unsupported_target() {
        let (output, mut frames) = tokio::sync::mpsc::channel(1);
        let bridge = PeerRouterBackchannel::new(output);
        bridge.negotiate(true);
        // An older Gateway never announces sessionReadV1.
        assert!(!bridge.supports_session_read());
        let attempt = TurnAttemptIdentity {
            thread_id: "source".into(),
            turn_id: "turn".into(),
            attempt_id: "attempt".into(),
        };
        let params: SessionReadParams = serde_json::from_value(serde_json::json!({
            "threadId": "peer",
            "targetAddress": {"targetId":"host-b","workspaceId":"space-b","threadId":"peer"}
        }))
        .unwrap();
        let own = PeerRouterIdentityV1 {
            target_id: "host-a".into(),
            workspace_id: "space-a".into(),
            principal: kcoder_app_protocol::RetentionPrincipalV1::LocalOs,
            public_key: vec![1; 32],
            identity_epoch: "epoch".into(),
        };
        // An old Native target makes the router reject `read`; the source must report
        // the stable unsupported code, not a missing conversation.
        let task = {
            let bridge = bridge.clone();
            let params = params.clone();
            let own = own.clone();
            tokio::spawn(async move { request(&bridge, &attempt, params, &own).await })
        };
        let frame = frames.recv().await.unwrap();
        assert_eq!(frame["params"]["kind"], "read");
        assert_eq!(frame["params"]["payload"]["threadId"], "peer");
        assert!(bridge.route_response(&serde_json::json!({
            "id": frame["id"],
            "error": {"code": -32601, "message": "AGENT_MESSAGES_SESSION_READ_UNSUPPORTED"}
        })));
        assert_eq!(
            task.await.unwrap().unwrap_err(),
            SessionReadError::UNSUPPORTED_TARGET
        );
    }
}
