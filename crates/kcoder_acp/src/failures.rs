//! Map only typed terminal Provider facts, never raw diagnostics or response bodies.
use agent_client_protocol::schema::v1::Error;
use kcoder_types::{
    ProviderFailureCategory as Category, ProviderFailureDetails, ProviderFailureRecoveryAction,
};
use serde_json::{Value, json};

/// Preserve only closed Native binding diagnostics across owned protocol hops.
/// These codes describe observations; they never authorize a retry or execution.
pub fn native_receiver_bind_diagnostic(error: &anyhow::Error) -> &'static str {
    const CODES: &[&str] = &[
        "REMOTE_RECEIVER_BIND_PROFILE_OPEN",
        "REMOTE_RECEIVER_BIND_PROFILE_PRIVATE",
        "REMOTE_RECEIVER_BIND_PROFILE_READ",
        "REMOTE_RECEIVER_BIND_POLICY",
        "REMOTE_RECEIVER_BIND_TOOL_POLICY",
        "REMOTE_RECEIVER_BIND_FORMATS",
        "REMOTE_RECEIVER_BIND_PARENT",
        "REMOTE_RECEIVER_BIND_SCOPE",
        "REMOTE_RECEIVER_BIND_RECHECK",
        "REMOTE_RECEIVER_NATIVE_PROFILE_REQUIRED",
        "REMOTE_RECEIVER_MATERIAL_CAPABILITY_REQUIRED",
        "REMOTE_RECEIVER_FROZEN_INPUT_MISMATCH",
        "REMOTE_RECEIVER_BIND_BEFORE_SESSION_REQUIRED",
        "REMOTE_RECEIVER_DEADLINE_EXPIRED",
        "REMOTE_RECEIVER_PRIVATE_BINDING_UNAVAILABLE",
    ];
    error
        .chain()
        .find_map(|cause| {
            let text = cause.to_string();
            CODES.iter().copied().find(|code| *code == text)
        })
        .unwrap_or("REMOTE_RECEIVER_PRIVATE_BINDING_UNAVAILABLE")
}

pub(crate) fn provider_failure(terminal: &Value) -> Option<anyhow::Error> {
    let details: ProviderFailureDetails =
        serde_json::from_value(terminal["error"]["details"].clone()).ok()?;
    Some(classified(details))
}

pub(crate) fn missing_credentials() -> anyhow::Error {
    classified(ProviderFailureDetails {
        category: Category::AuthenticationError,
        recovery_action: ProviderFailureRecoveryAction::NeedsHuman,
        http_status: None,
        retryable: false,
        resume_safe: false,
        retry_after_ms: None,
    })
}

fn classified(details: ProviderFailureDetails) -> anyhow::Error {
    let (code, message, guidance) = match details.category {
        Category::AuthenticationError => (
            -32000,
            "Provider authentication is required",
            "Configure credentials with kcoder auth login --provider <configured-provider>, then retry the task.",
        ),
        Category::Forbidden => (
            -32603,
            "Provider denied access",
            "Check account and model access permissions before retrying.",
        ),
        Category::ModelOrRoute => (
            -32603,
            "Configured model or API route is unavailable",
            "Check the selected Provider, model, endpoint and api_format.",
        ),
        Category::InvalidParameter => (
            -32603,
            "Provider rejected the request configuration",
            "Review the selected model's supported settings.",
        ),
        Category::ContextLengthExceeded => (
            -32603,
            "Provider context limit exceeded",
            "Reduce or compact the context before retrying.",
        ),
        Category::RateLimit => (
            -32603,
            "Provider rate limit reached",
            "Observe retry_after_ms when supplied; do not blindly replay side effects.",
        ),
        Category::QuotaExceeded => (
            -32603,
            "Provider quota is exhausted",
            "Check account quota or billing before retrying.",
        ),
        Category::NetworkError => (
            -32603,
            "Provider network request failed",
            "Check connectivity and reconcile any incomplete external effects before retrying.",
        ),
        Category::TimeoutError => (
            -32603,
            "Provider request timed out",
            "Check service availability and reconcile any incomplete external effects before retrying.",
        ),
        Category::ModelProtocolError => (
            -32603,
            "Provider returned an invalid model response",
            "Check model and API compatibility; this is not a completed answer.",
        ),
        Category::ProviderError => (
            -32603,
            "Provider request failed",
            "Inspect the Provider configuration or service status before retrying.",
        ),
    };
    Error::new(code, message)
        .data(json!({"provider_failure":details,"guidance":guidance}))
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_binding_diagnostics_never_forward_raw_or_lookalike_messages() {
        let private =
            anyhow::anyhow!("private-profile-or-launch-data").context("REMOTE_RECEIVER_BIND_SCOPE");
        assert_eq!(
            native_receiver_bind_diagnostic(&private),
            "REMOTE_RECEIVER_BIND_SCOPE"
        );
        for text in [
            "private-profile-or-launch-data",
            "REMOTE_RECEIVER_BIND_SCOPE secret",
            "REMOTE_CALLER_PROVIDED_SECRET",
        ] {
            assert_eq!(
                native_receiver_bind_diagnostic(&anyhow::anyhow!(text)),
                "REMOTE_RECEIVER_PRIVATE_BINDING_UNAVAILABLE"
            );
        }
    }

    fn terminal(category: &str) -> Value {
        json!({"error":{"message":"SECRET_DIAGNOSTIC authentication_error", "details":{
            "category":category,"recovery_action":"needs_human","http_status":401,
            "retryable":false,"resume_safe":false,"retry_after_ms":null,"unknown_private_field":"SECRET_EXTRA"
        }}})
    }

    #[test]
    fn only_typed_authentication_selects_the_acp_auth_error_and_private_fields_are_not_forwarded() {
        let error = provider_failure(&terminal("authentication_error")).unwrap();
        let wire = serde_json::to_value(error.downcast_ref::<Error>().unwrap()).unwrap();
        assert_eq!(wire["code"], -32000);
        assert_eq!(
            wire["data"]["provider_failure"]["category"],
            "authentication_error"
        );
        assert!(!wire.to_string().contains("SECRET"));
        let error = provider_failure(&terminal("model_or_route")).unwrap();
        let wire = serde_json::to_value(error.downcast_ref::<Error>().unwrap()).unwrap();
        assert_eq!(
            wire["code"], -32603,
            "diagnostic text must not override category"
        );
        assert!(provider_failure(&terminal("SECRET_UNKNOWN_CATEGORY")).is_none());
        assert!(provider_failure(&json!({"error":{"message":"authentication_error"}})).is_none());
    }
}
