//! Stable model-facing failure guidance. Never echo arbitrary broker text or
//! treat a missing reply as proof that an input action had no effect.
use crate::client::ClientError;
use serde_json::{Value, json};

/// A retired lease needs replacement, independently of session authorization.
/// Session permission is owned by the host and cannot be inferred from IPC.
pub fn retires_lease(error: &ClientError) -> bool {
    !matches!(error, ClientError::Busy)
        && !matches!(error, ClientError::Remote(code) if matches!(code.as_str(),
            "invalid_request" | "unauthorized" | "desktop_busy" | "operation_busy" | "desktop_unavailable" | "result_too_large" | "desktop_observation_required"))
}

pub fn operation_failure(error: &ClientError) -> Value {
    let (code, not_started) = match error {
        ClientError::Execution { .. } => ("tool_execution_failed", false),
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
            "desktop_locked" => ("desktop_locked", true),
            "desktop_lost" => ("desktop_unavailable", false),
            "desktop_observation_required" => ("desktop_observation_required", true),
            "lease_revoked" => ("lease_revoked", false),
            "operation_timeout" => ("operation_timeout", false),
            "cleanup_failed" => ("cleanup_failed", false),
            "worker_exited" => ("worker_exited", false),
            "input_observer_unavailable" => ("input_observer_unavailable", true),
            "recovery_process_exited" => ("recovery_process_exited", true),
            "result_too_large" => ("result_too_large", false),
            _ => ("worker_failed", false),
        },
    };
    let lease_usable = !retires_lease(error);
    let cleanup = match error {
        ClientError::Execution {
            cleanup_confirmed: true,
            ..
        } => "confirmed",
        ClientError::Execution {
            cleanup_confirmed: false,
            ..
        } => "failed",
        ClientError::Remote(code) if code == "cleanup_failed" => "failed",
        _ => "unknown",
    };
    let mut result = json!({
        "errorCode": code,
        "outcome": if not_started { "not_started" } else { "unknown" },
        "automaticRetryAllowed": false,
        "channelAvailable": lease_usable,
        "leaseUsable": lease_usable,
        "authorization": "host_check_required",
        "cleanupStatus": cleanup,
        "message": if code == "desktop_observation_required" {
            "This action was not started. Observe the current full desktop with Snapshot or Screenshot before issuing input. DisplayInventory alone does not observe the focused window or verify a prior input."
        } else if code == "result_too_large" {
            "The desktop operation returned a result exceeding the 2 MiB transport limit. The control channel remains available. Do not replay an input action: it may already have taken effect. For an oversized screenshot, use Snapshot with use_vision=false to inspect accessible content, or select a relevant monitor or previously established region. Do not repeatedly request the same oversized image or claim to have seen it."
        } else if not_started {
            "This operation was not started. Resolve the reported availability, permission or busy condition before issuing another operation; it was not queued."
        } else {
            "No reliable result was received. The action may already have taken effect. Do not repeat clicks, typing or other input automatically. This lease cannot resume input: the host must confirm old worker and input cleanup, check existing session authorization, then establish a new control turn and observe the current desktop before deciding what to do next. A channel error does not revoke or renew session permission."
        }
    });
    if let ClientError::Execution {
        detail,
        cleanup_confirmed,
    } = error
    {
        result["detail"] = json!(detail);
        result["cleanupConfirmed"] = json!(cleanup_confirmed);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_failure_does_not_infer_session_authorization() {
        for error in [
            ClientError::Timeout,
            ClientError::Disconnected,
            ClientError::Remote("lease_revoked".into()),
        ] {
            let result = operation_failure(&error);
            assert_eq!(result["channelAvailable"], false);
            assert_eq!(result["authorization"], "host_check_required");
            assert_eq!(result["cleanupStatus"], "unknown");
        }
        let clean = operation_failure(&ClientError::Execution {
            detail: "fixture".into(),
            cleanup_confirmed: true,
        });
        assert_eq!(clean["cleanupStatus"], "confirmed");
        assert_eq!(clean["leaseUsable"], false);
        assert_eq!(
            operation_failure(&ClientError::Remote("cleanup_failed".into()))["cleanupStatus"],
            "failed"
        );
        assert_eq!(
            operation_failure(&ClientError::Remote("worker_exited".into()))["errorCode"],
            "worker_exited"
        );
    }
    #[test]
    fn worker_desktop_loss_retires_lease_unlike_admission_unavailability() {
        let admission = ClientError::Remote("desktop_unavailable".into());
        let lost = ClientError::Remote("desktop_lost".into());
        assert!(!retires_lease(&admission));
        assert!(retires_lease(&lost));
        assert_eq!(operation_failure(&lost)["errorCode"], "desktop_unavailable");
        assert_eq!(operation_failure(&lost)["channelAvailable"], false);
        assert_eq!(operation_failure(&admission)["outcome"], "not_started");
    }
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
