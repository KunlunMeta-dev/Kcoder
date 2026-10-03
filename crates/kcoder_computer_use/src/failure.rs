//! Stable model-facing failure guidance. Never echo arbitrary broker text or
//! treat a missing reply as proof that an input action had no effect.
use crate::client::ClientError;
use serde_json::{Value, json};

pub fn requires_new_authorization(error: &ClientError) -> bool {
    !matches!(error, ClientError::Busy)
        && !matches!(error, ClientError::Remote(code) if matches!(code.as_str(),
            "invalid_request" | "unauthorized" | "desktop_busy" | "operation_busy" | "desktop_unavailable" | "result_too_large"))
}

pub fn operation_failure(error: &ClientError) -> Value {
    if matches!(error, ClientError::Remote(code) if code == "result_too_large") {
        return json!({"errorCode":"result_too_large", "outcome":"unknown",
            "automaticRetryAllowed":false, "channelAvailable":true,
            "message":"The desktop operation returned a result exceeding the 2 MiB transport limit. The control channel remains available. Do not replay an input action: it may already have taken effect. For an oversized screenshot, use Snapshot with use_vision=false to inspect accessible content, or select a relevant monitor or previously established region. Do not repeatedly request the same oversized image or claim to have seen it."});
    }

    if let ClientError::Execution {
        detail,
        cleanup_confirmed,
    } = error
    {
        return json!({"errorCode":"tool_execution_failed", "outcome":"unknown", "automaticRetryAllowed":false,
            "detail":detail, "cleanupConfirmed":cleanup_confirmed,
            "message":"The tool returned an execution error. Do not automatically replay the input. This control lease is no longer usable; start a new desktop turn, then observe the desktop before deciding what to do next."});
    }
    let (code, not_started) = match error {
        ClientError::Execution { .. } => unreachable!("handled above"),
        ClientError::Busy => ("operation_busy", true),
        ClientError::Timeout => ("operation_timeout", false),
        ClientError::Disconnected => ("connection_lost", false),
        ClientError::Protocol => ("invalid_worker_response", false),
        ClientError::Remote(code) => match code.as_str() {
            "invalid_request" => ("invalid_request", true),
            "unauthorized" => ("unauthorized", true),
            "desktop_busy" => ("desktop_busy", true),
            "operation_busy" => ("operation_busy", true),
            "desktop_unavailable" => ("desktop_unavailable", true),
            "lease_revoked" => ("lease_revoked", false),
            "operation_timeout" => ("operation_timeout", false),
            "cleanup_failed" => ("cleanup_failed", false),
            _ => ("worker_failed", false),
        },
    };
    json!({
        "errorCode": code,
        "outcome": if not_started { "not_started" } else { "unknown" },
        "automaticRetryAllowed": false,
        "message": if not_started {
            "This operation was not started. Resolve the reported availability, permission or busy condition before issuing another operation; it was not queued."
        } else {
            "No reliable result was received. The action may already have taken effect. Do not repeat clicks, typing or other input automatically. This control channel will not reconnect in the current turn: do not wait or repeatedly probe it. Start a new desktop turn in the authorized conversation, then observe the current desktop before deciding what to do next. Cleanup is not confirmed by this error."
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lost_responses_never_claim_no_effect_or_allow_replay() {
        for error in [
            ClientError::Timeout,
            ClientError::Disconnected,
            ClientError::Protocol,
            ClientError::Remote("lease_revoked".into()),
            ClientError::Remote("cleanup_failed".into()),
        ] {
            let result = operation_failure(&error);
            assert_eq!(result["outcome"], "unknown");
            assert_eq!(result["automaticRetryAllowed"], false);
            assert!(
                result["message"]
                    .as_str()
                    .unwrap()
                    .contains("observe the current desktop")
            );
        }
    }
    #[test]
    fn admission_rejection_is_distinct_and_unknown_remote_text_is_not_exposed() {
        assert_eq!(
            operation_failure(&ClientError::Busy)["outcome"],
            "not_started"
        );
        let result = operation_failure(&ClientError::Remote("private desktop text".into()));
        assert_eq!(result["errorCode"], "worker_failed");
        assert!(!result.to_string().contains("private desktop text"));
    }
}
