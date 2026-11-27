//! Closed diagnostics for reconciliation. Raw errors may contain private paths or input.
const REASONS: &[&str] = &[
    "peer_router_profile_rate_limited",
    "peer_router_source_rate_limited",
    "peer_router_rate_policy_invalid",
    "peer_router_busy",
    "peer_message_host_busy",
    "peer_source_owner_closed",
    "peer_source_owner_changed",
    "peer_source_busy",
    "peer_source_settings_busy",
    "peer_source_tool_disabled",
    "peer_source_tool_contribution_changed",
    "peer_source_permissions_busy",
    "peer_source_permission_denied",
    "peer_source_workspace_changed",
    "peer_source_original_admission_unavailable",
    "peer_source_original_intent_changed",
    "peer_source_original_intent_conflict",
    "peer_source_original_operation_changed",
    "peer_source_original_operation_unavailable",
    "peer_source_handoff_generation_changed",
    "peer_source_current_authorization_unavailable",
    "peer_source_native_image_changed",
    "peer_source_response_invalid",
    "peer_source_response_timeout",
    "peer_source_endpoint_absent",
    "peer_router_invalid_params",
    "peer_router_operation_missing",
    "peer_router_original_operation_missing",
    "peer_router_original_receipt_changed",
    "peer_router_original_provenance_changed",
    "peer_router_original_provenance_unknown",
    "peer_router_original_query_binding_unavailable",
    "peer_router_original_query_provenance_unavailable",
    "peer_router_original_admission_changed",
    "peer_router_original_dispatch_unknown",
    "peer_router_original_operation_changed",
    "peer_router_source_holder_changed",
    "peer_router_local_identity_changed",
    "peer_router_source_scope_changed",
    "peer_router_destination_scope_changed",
    "peer_router_source_history_changed",
    "peer_message_policy_denied",
    "peer_message_source_scope_changed",
    "peer_message_source_changed",
];
pub(crate) fn reason(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        let message = cause.to_string();
        if let Some(reason) = REASONS.iter().find(|reason| **reason == message) {
            return reason;
        }
    }
    "peer_router_unconfirmed"
}
/// A diagnostic only. A stage is not evidence that a side effect did or did not execute.
#[cfg(test)]
fn local_stage(error: &anyhow::Error) -> &'static str {
    const STAGES: &[&str] = &[
        "peer_local_prepare_source",
        "peer_local_source_history",
        "peer_local_query_original",
        "peer_local_mark_dispatch",
        "peer_local_enqueue",
        "peer_local_record_receipt",
    ];
    for cause in error.chain() {
        let message = cause.to_string();
        if let Some(stage) = STAGES.iter().find(|stage| **stage == message) {
            return stage;
        }
    }
    "peer_local_unconfirmed"
}
/// Typed transport facts in an error chain; never inspects message text.
fn typed_cause(error: &anyhow::Error) -> Option<kcoder_tools::peer_diagnostics::PeerFailureCause> {
    use kcoder_tools::peer_diagnostics::PeerFailureCause as Cause;
    error.chain().find_map(|cause| {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind::*;
            return match io.kind() {
                TimedOut => Some(Cause::Timeout),
                ConnectionRefused | ConnectionReset | ConnectionAborted | NotConnected
                | BrokenPipe => Some(Cause::ConnectRefused),
                NotFound => Some(Cause::EndpointMissing),
                PermissionDenied => Some(Cause::Permission),
                InvalidData | UnexpectedEof => Some(Cause::Decode),
                _ => None,
            };
        }
        if cause.is::<tokio::time::error::Elapsed>() {
            Some(Cause::Timeout)
        } else if cause.is::<serde_json::Error>() {
            Some(Cause::Decode)
        } else if cause.is::<tokio::sync::TryAcquireError>() {
            Some(Cause::Busy)
        } else {
            None
        }
    })
}

/// Innermost closed code of an error chain (raw messages are skipped).
fn underlying_code(error: &anyhow::Error) -> Option<String> {
    error
        .chain()
        .filter_map(|cause| kcoder_tools::peer_diagnostics::normalized_code(&cause.to_string()))
        .last()
}

/// Emits one bounded, deduplicated host-side warning for a failed peer-channel
/// operation. `code` is what the caller receives; the underlying error only
/// contributes typed causes and closed codes.
pub(crate) fn report_failure(
    operation: &'static str,
    side: &'static str,
    code: &str,
    error: Option<&anyhow::Error>,
    started: std::time::Instant,
) {
    use kcoder_tools::peer_diagnostics::{PeerFailure, PeerFailureCause, normalized_code, report};
    let code = normalized_code(code).unwrap_or_else(|| "unrecognized".into());
    let code = code.as_str();
    let underlying = error
        .and_then(underlying_code)
        .filter(|inner| inner != code);
    let cause = error
        .and_then(typed_cause)
        .or_else(|| {
            underlying
                .as_deref()
                .map(PeerFailureCause::from_code)
                .filter(|cause| *cause != PeerFailureCause::Other)
        })
        .unwrap_or_else(|| PeerFailureCause::from_code(code));
    report(PeerFailure {
        operation,
        side,
        code,
        underlying: underlying.as_deref(),
        cause,
        elapsed: started.elapsed(),
        retry: false,
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_compiled_codes_leave_the_native_error_boundary() {
        assert_eq!(
            super::reason(&anyhow::anyhow!("peer_source_tool_disabled")),
            "peer_source_tool_disabled"
        );
        for raw in [
            "private/path/credential",
            "peer_source_unrecognized_user_text",
            "peer_source_tool_disabled: secret",
        ] {
            assert_eq!(
                super::reason(&anyhow::anyhow!(raw.to_owned())),
                "peer_router_unconfirmed"
            );
        }
        let error = anyhow::anyhow!("private/credential/path").context("peer_local_enqueue");
        assert_eq!(super::local_stage(&error), "peer_local_enqueue");
        assert_eq!(super::reason(&error), "peer_router_unconfirmed");
        assert_eq!(
            super::local_stage(&anyhow::anyhow!("peer_local_enqueue: secret")),
            "peer_local_unconfirmed"
        );
    }
    #[test]
    fn diagnostics_take_typed_causes_and_innermost_closed_codes_only() {
        use kcoder_tools::peer_diagnostics::PeerFailureCause;
        let timeout = anyhow::Error::new(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "/home/alice/private.sock",
        ))
        .context("peer_message_router_outcome_unknown");
        assert_eq!(
            super::typed_cause(&timeout),
            Some(PeerFailureCause::Timeout)
        );
        assert_eq!(
            super::underlying_code(&timeout).as_deref(),
            Some("peer_message_router_outcome_unknown")
        );
        let routed = anyhow::anyhow!("AGENT_MESSAGES_ENDPOINT_UNAVAILABLE")
            .context("peer_message_router_outcome_unknown");
        assert_eq!(super::typed_cause(&routed), None);
        assert_eq!(
            super::underlying_code(&routed).as_deref(),
            Some("agent_messages_endpoint_unavailable")
        );
        assert_eq!(
            super::underlying_code(&anyhow::anyhow!("raw text with a token")),
            None
        );
    }
}
