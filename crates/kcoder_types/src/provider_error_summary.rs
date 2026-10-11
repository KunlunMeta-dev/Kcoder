/// Error diagnostics never include provider-controlled prose or identifiers.
/// Successful protocol payloads are deliberately outside this boundary.
pub const PROVIDER_ERROR_SUMMARY_MAX_BYTES: usize = 512;

/// Only constructors in this module can supply serialized diagnostic text.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct ProviderErrorSummary(String);

impl ProviderErrorSummary {
    pub fn new(error_type: &str, status: Option<u16>) -> Self {
        Self(provider_error_summary(error_type, status))
    }

    /// Local budget diagnostics accept only known resource names and a number,
    /// never arbitrary provider prose, payloads, or configuration identifiers.
    pub fn response_limit(resource: &str, limit: usize) -> Self {
        let resource = match resource {
            "total_decoded_bytes" => "total_decoded_bytes",
            "tool_arguments_bytes" => "tool_arguments_bytes",
            "content_blocks" => "content_blocks",
            "active_tool_calls" => "active_tool_calls",
            "wire_frame_bytes" => "wire_frame_bytes",
            "invalid_response_limits" => "invalid_response_limits",
            _ => "decoded_response",
        };
        Self(format!(
            "Provider error: provider_response_limit; {resource} exceeded (limit {limit}). Output discarded."
        ))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ProviderErrorSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn provider_error_summary(error_type: &str, status: Option<u16>) -> String {
    let kind = safe_provider_error_type(error_type);
    match status {
        Some(status) => {
            format!("Provider error: {kind}; HTTP {status}. Response details withheld.")
        }
        None => format!("Provider error: {kind}. Response details withheld."),
    }
}

pub fn safe_provider_error_type(value: &str) -> &'static str {
    match value {
        "authentication_error" => "authentication_error",
        "permission_error" => "permission_error",
        "invalid_request_error" => "invalid_request_error",
        "context_length_exceeded" => "context_length_exceeded",
        "rate_limit_error" => "rate_limit_error",
        "overloaded_error" => "overloaded_error",
        "insufficient_quota" => "insufficient_quota",
        "billing_hard_limit_reached" => "billing_hard_limit_reached",
        "unsupported_parameter" => "unsupported_parameter",
        "model_not_found" => "model_not_found",
        "stream_incomplete" => "stream_incomplete",
        "stream_idle_timeout" => "stream_idle_timeout",
        "network_error" => "network_error",
        "model_protocol_error" => "model_protocol_error",
        "protocol_error" => "protocol_error",
        "response_parse_error" => "response_parse_error",
        "request_build_error" => "request_build_error",
        "sse_stream_error" => "sse_stream_error",
        _ => "unknown_error",
    }
}

impl crate::ApiError {
    pub fn safe_summary(&self) -> String {
        provider_error_summary(&self.error_type, None)
    }

    /// Project only error diagnostics; wire serialization remains unchanged.
    pub fn diagnostic_projection(&self) -> Self {
        Self {
            error_type: safe_provider_error_type(&self.error_type).into(),
            message: self.safe_summary(),
        }
    }
}

impl std::fmt::Debug for crate::ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.safe_summary())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn local_response_limit_diagnostics_cannot_echo_provider_text() {
        let summary = super::ProviderErrorSummary::response_limit("tool_arguments_bytes", 16);
        assert!(summary.as_str().contains("tool_arguments_bytes"));
        assert!(summary.as_str().contains("limit 16"));
        let untrusted = super::ProviderErrorSummary::response_limit(
            &"SENTINEL_PRIVATE".repeat(1000),
            usize::MAX,
        );
        assert!(!untrusted.as_str().contains("SENTINEL_PRIVATE"));
        assert!(untrusted.as_str().len() <= super::PROVIDER_ERROR_SUMMARY_MAX_BYTES);
    }

    #[test]
    fn provider_error_precision_retains_known_protocol_types() {
        for kind in ["model_protocol_error", "protocol_error"] {
            assert_eq!(super::safe_provider_error_type(kind), kind);
            assert!(
                super::ProviderErrorSummary::new(kind, None)
                    .as_str()
                    .contains(kind)
            );
        }
    }

    #[test]
    fn provider_error_summary_projection_preserves_wire_payload() {
        let error = crate::ApiError {
            error_type: "SENTINEL_PRIVATE".into(),
            message: "SENTINEL_PRIVATE".repeat(1000),
        };
        assert!(
            serde_json::to_string(&error)
                .unwrap()
                .contains("SENTINEL_PRIVATE")
        );
        assert!(!format!("{error:?}").contains("SENTINEL_PRIVATE"));
        let projected = error.diagnostic_projection();
        assert!(
            !serde_json::to_string(&projected)
                .unwrap()
                .contains("SENTINEL_PRIVATE")
        );
        assert!(projected.message.len() <= super::PROVIDER_ERROR_SUMMARY_MAX_BYTES);
    }
}
