use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HttpRecoveryAction {
    Retry {
        rate_limited: bool,
        retry_after: Option<Duration>,
    },
    CompactNow,
    DowngradeThinking(kcoder_api::RejectedReasoningParameter),
    NeedsHuman(HttpDiagnosis),
    DiagnoseOnly(HttpDiagnosis),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HttpDiagnosis {
    Authentication,
    ModelOrRoute,
    RequestParameters,
    Quota,
    UnknownStatus,
}

pub(super) fn http_recovery_action(error: &kcoder_api::ApiErrorKind) -> Option<HttpRecoveryAction> {
    let kcoder_api::ApiErrorKind::Http {
        metadata, message, ..
    } = error
    else {
        return None;
    };
    Some(match metadata.status {
        401 | 403 => HttpRecoveryAction::NeedsHuman(HttpDiagnosis::Authentication),
        404 => HttpRecoveryAction::NeedsHuman(HttpDiagnosis::ModelOrRoute),
        429 if matches!(
            metadata.provider_code.as_deref(),
            Some("insufficient_quota" | "billing_hard_limit_reached")
        ) =>
        {
            HttpRecoveryAction::NeedsHuman(HttpDiagnosis::Quota)
        }
        429 | 500 | 502 | 503 | 504 | 529 => HttpRecoveryAction::Retry {
            rate_limited: metadata.status == 429,
            retry_after: metadata.retry_after,
        },
        400 | 413 | 422 => {
            if metadata.provider_code.as_deref() == Some("unsupported_parameter") {
                return Some(
                    if matches!(metadata.status, 400 | 422)
                        && matches!(
                            metadata.provider_type.as_deref(),
                            None | Some("invalid_request_error")
                        )
                    {
                        metadata
                            .rejected_reasoning_parameter
                            .map(HttpRecoveryAction::DowngradeThinking)
                            .unwrap_or(HttpRecoveryAction::NeedsHuman(
                                HttpDiagnosis::RequestParameters,
                            ))
                    } else {
                        HttpRecoveryAction::NeedsHuman(HttpDiagnosis::RequestParameters)
                    },
                );
            }
            let known_context = [
                metadata.provider_code.as_deref(),
                metadata.provider_type.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.eq_ignore_ascii_case("context_length_exceeded"));
            if known_context || has_legacy_context_marker(message) {
                HttpRecoveryAction::CompactNow
            } else {
                HttpRecoveryAction::NeedsHuman(HttpDiagnosis::RequestParameters)
            }
        }
        _ => HttpRecoveryAction::DiagnoseOnly(HttpDiagnosis::UnknownStatus),
    })
}

pub(super) fn has_legacy_context_marker(error: &dyn std::fmt::Display) -> bool {
    let lower = error.to_string().to_ascii_lowercase();
    [
        "prompt is too long",
        "prompt too long",
        "context window",
        "context_length_exceeded",
        "maximum context length",
        "input is too long",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub(super) fn is_retryable_api_error(error: &kcoder_api::ApiErrorKind) -> bool {
    match http_recovery_action(error) {
        Some(action) => matches!(action, HttpRecoveryAction::Retry { .. }),
        None => matches!(
            error.non_http_error_class(),
            Some(
                kcoder_api::NonHttpErrorClass::Transient
                    | kcoder_api::NonHttpErrorClass::RateLimited
                    | kcoder_api::NonHttpErrorClass::StreamIdleTimeout
                    | kcoder_api::NonHttpErrorClass::TransportTimeout
            )
        ),
    }
}

pub(super) fn provider_failure_details(
    error: &kcoder_api::ApiErrorKind,
    response_started: bool,
) -> kcoder_types::ProviderFailureDetails {
    use kcoder_api::{ApiErrorKind, NonHttpErrorClass, SseErrorKind};
    use kcoder_types::{
        ProviderFailureCategory as Category, ProviderFailureRecoveryAction as Action,
    };
    let http_status = match error {
        ApiErrorKind::Http { metadata, .. } => Some(metadata.status),
        _ => None,
    };
    let category = if let Some(status) = http_status {
        match status {
            401 => Category::AuthenticationError,
            403 => Category::Forbidden,
            404 => Category::ModelOrRoute,
            429 if http_recovery_action(error)
                == Some(HttpRecoveryAction::NeedsHuman(HttpDiagnosis::Quota)) =>
            {
                Category::QuotaExceeded
            }
            429 => Category::RateLimit,
            400 | 413 | 422 => {
                let typed_context = matches!(error, ApiErrorKind::Http { metadata, .. }
                    if [metadata.provider_code.as_deref(), metadata.provider_type.as_deref()]
                        .into_iter().flatten()
                        .any(|value| value.eq_ignore_ascii_case("context_length_exceeded")));
                if typed_context {
                    Category::ContextLengthExceeded
                } else {
                    Category::InvalidParameter
                }
            }
            _ => Category::ProviderError,
        }
    } else {
        match error.non_http_error_class() {
            Some(NonHttpErrorClass::RateLimited) => Category::RateLimit,
            Some(NonHttpErrorClass::StreamIdleTimeout | NonHttpErrorClass::TransportTimeout) => {
                Category::TimeoutError
            }
            _ => match error {
                ApiErrorKind::Network(error) if error.is_builder() => Category::InvalidParameter,
                ApiErrorKind::Network(error) if error.is_decode() => Category::ModelProtocolError,
                ApiErrorKind::Network(_) => Category::NetworkError,
                ApiErrorKind::SseStream {
                    kind: SseErrorKind::Parser | SseErrorKind::Utf8,
                    ..
                }
                | ApiErrorKind::JsonParse(_, _) => Category::ModelProtocolError,
                ApiErrorKind::SseStream {
                    kind: SseErrorKind::Transport(_),
                    ..
                } => Category::NetworkError,
                ApiErrorKind::InvalidHeader(_) | ApiErrorKind::CannotCloneRequest(_) => {
                    Category::InvalidParameter
                }
                ApiErrorKind::Api { error_type, .. } => match error_type.as_str() {
                    "authentication_error" => Category::AuthenticationError,
                    "permission_error" => Category::Forbidden,
                    "invalid_request_error" | "unsupported_parameter" => Category::InvalidParameter,
                    "context_length_exceeded" => Category::ContextLengthExceeded,
                    "model_not_found" => Category::ModelOrRoute,
                    "model_protocol_error" | "protocol_error" => Category::ModelProtocolError,
                    _ => Category::ProviderError,
                },
                _ => Category::ProviderError,
            },
        }
    };
    let retryable = is_retryable_api_error(error);
    kcoder_types::ProviderFailureDetails {
        category,
        recovery_action: if matches!(
            category,
            Category::AuthenticationError
                | Category::Forbidden
                | Category::ModelOrRoute
                | Category::InvalidParameter
                | Category::ContextLengthExceeded
                | Category::QuotaExceeded
        ) {
            Action::NeedsHuman
        } else {
            Action::DiagnoseOnly
        },
        http_status,
        retryable,
        resume_safe: retryable && !response_started,
        retry_after_ms: retryable
            .then(|| api_server_retry_after(error))
            .flatten()
            .map(|delay| delay.as_millis().try_into().unwrap_or(u64::MAX)),
    }
}

pub(super) fn is_rate_limit_api_error(error: &kcoder_api::ApiErrorKind) -> bool {
    match http_recovery_action(error) {
        Some(action) => matches!(
            action,
            HttpRecoveryAction::Retry {
                rate_limited: true,
                ..
            }
        ),
        None => error.non_http_error_class() == Some(kcoder_api::NonHttpErrorClass::RateLimited),
    }
}

pub(super) fn api_server_retry_after(error: &kcoder_api::ApiErrorKind) -> Option<Duration> {
    if let Some(HttpRecoveryAction::Retry { retry_after, .. }) = http_recovery_action(error) {
        return retry_after;
    }
    // Preserve header inspection for non-retryable HTTP errors; callers gate retries separately.
    match error {
        kcoder_api::ApiErrorKind::Http { metadata, .. } => metadata.retry_after,
        _ => None,
    }
}

/// Recognize only transient transport, server-overload, and rate-limit errors; authentication and other client errors are not retryable.
#[cfg(test)]
pub(super) fn is_retryable_error(error: &dyn std::fmt::Display) -> bool {
    let msg = error.to_string().to_lowercase();
    let transient_markers = [
        "stream idle",
        "sse stream",
        "sse_stream",
        "stream incomplete",
        "stream_incomplete",
        "stream closed",
        "timeout",
        "timed out",
        "rate limit",
        "too many requests",
        "overload",
        "529",
        "429",
        "500",
        "502",
        "503",
        "504",
        "connection",
        "network",
        "reset",
        "broken pipe",
        "temporarily",
        "unavailable",
        "econnreset",
        "etimedout",
        "eai_again",
    ];
    transient_markers.iter().any(|marker| msg.contains(marker))
}

/// Use a separate small retry budget for 429 responses to avoid occupying a query turn for too long.
pub(super) const RATE_LIMIT_MAX_RETRIES: usize = 2;

#[cfg(test)]
pub(super) fn is_rate_limit_error(error: &dyn std::fmt::Display) -> bool {
    let msg = error.to_string().to_lowercase();
    msg.contains("429")
        || msg.contains("rate limit")
        || msg.contains("rate_limit")
        || msg.contains("too many requests")
}

/// Accept only positive server-requested wait durations shorter than one hour.
#[cfg(test)]
pub(super) fn server_retry_after(error: &dyn std::fmt::Display) -> Option<Duration> {
    let msg = error.to_string().to_lowercase();
    for marker in ["retry after", "retry-after", "retry_after"] {
        if let Some(index) = msg.find(marker) {
            let tail = msg[index + marker.len()..].trim_start_matches([' ', ':', '=']);
            let digits: String = tail
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(secs) = digits.parse::<f64>()
                && secs > 0.0
                && secs < 3600.0
            {
                return Some(Duration::from_secs_f64(secs));
            }
        }
    }
    None
}

pub(super) fn retry_error_summary(error: &dyn std::fmt::Display) -> String {
    const MAX_LEN: usize = 240;

    let mut summary = error
        .to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if summary.chars().count() > MAX_LEN {
        let truncated = summary.chars().take(MAX_LEN).collect::<String>();
        summary = format!("{truncated}...");
    }

    if summary.is_empty() {
        "unknown transient error".to_string()
    } else {
        summary
    }
}

/// Add up to 25% jitter to exponential backoff to reduce synchronized retries by concurrent requests.
pub(super) fn backoff_delay(base_ms: u64, attempt: u32) -> Duration {
    let exp = base_ms.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)));
    // SystemTime provides non-cryptographic jitter only and makes no randomness or security guarantee.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let jitter = (nanos % (exp.max(1) / 4).max(1)).min(exp);
    Duration::from_millis(exp.saturating_add(jitter))
}

pub(super) async fn sleep_or_cancel(cancel_token: CancellationToken, duration: Duration) -> bool {
    tokio::select! {
        biased;
        _ = cancel_token.cancelled() => false,
        _ = tokio::time::sleep(duration) => true,
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn provider_error_precision_builder_reports_request_not_stream_failure() {
        use futures::StreamExt;
        let provider = kcoder_api::OpenAiProvider::local_compatible()
            .unwrap()
            .with_base_url("not a URL SENTINEL_PRIVATE");
        let request = kcoder_types::MessagesRequest::new(
            "test",
            vec![kcoder_types::Message::user_text("hi")],
        );
        let error = kcoder_api::Provider::stream_messages(&provider, request)
            .unwrap()
            .next()
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(&error, kcoder_api::ApiErrorKind::Network(source) if source.is_builder()));
        let message = super::super::provider_error_message("test", &error);
        assert!(message.contains("request could not be built"));
        assert!(!message.contains("stream error"));
        assert!(!message.contains("SENTINEL_PRIVATE"));
    }

    #[test]
    fn provider_error_summary_json_parse_reports_response_failure() {
        let raw = "SENTINEL_PRIVATE";
        let error = kcoder_api::ApiErrorKind::JsonParse(
            serde_json::from_str::<serde_json::Value>(raw).unwrap_err(),
            raw.into(),
        );
        let message = super::super::provider_error_message("test", &error);
        assert!(message.contains("response could not be parsed"));
        assert!(!message.contains("request could not be built"));
        assert!(!message.contains("SENTINEL_PRIVATE"));
    }
    #[test]
    fn provider_failure_context_category_ignores_diagnostic_body() {
        for status in [400, 413, 422] {
            let error = |message: &str, code: Option<&str>| kcoder_api::ApiErrorKind::Http {
                error_type: "provider_error".into(),
                message: message.into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status,
                    provider_code: code.map(str::to_owned),
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: None,
                },
            };
            let ordinary = super::provider_failure_details(&error("opaque", None), false);
            let misleading = super::provider_failure_details(
                &error(
                    "context window context_length_exceeded prompt too long",
                    None,
                ),
                false,
            );
            assert_eq!(ordinary, misleading, "status {status}");
            assert_eq!(
                ordinary.category,
                kcoder_types::ProviderFailureCategory::InvalidParameter
            );
            let context = super::provider_failure_details(
                &error("opaque", Some("context_length_exceeded")),
                false,
            );
            assert_eq!(
                context.category,
                kcoder_types::ProviderFailureCategory::ContextLengthExceeded
            );
            let mut typed = error("opaque", None);
            if let kcoder_api::ApiErrorKind::Http { metadata, .. } = &mut typed {
                metadata.provider_type = Some("context_length_exceeded".into());
            }
            assert_eq!(super::provider_failure_details(&typed, false), context);
        }
    }
    #[test]
    fn typed_quota_exhaustion_requires_human_instead_of_retry() {
        for code in ["insufficient_quota", "billing_hard_limit_reached"] {
            let error = kcoder_api::ApiErrorKind::Http {
                error_type: "rate_limit_error".into(),
                message: "opaque".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status: 429,
                    provider_code: Some(code.into()),
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: None,
                },
            };
            assert!(
                !super::is_retryable_api_error(&error),
                "typed quota {code} must stop"
            );
            let details = super::provider_failure_details(&error, false);
            assert_eq!(
                details.category,
                kcoder_types::ProviderFailureCategory::QuotaExceeded
            );
            assert_eq!(
                details.recovery_action,
                kcoder_types::ProviderFailureRecoveryAction::NeedsHuman
            );
            let wire = serde_json::to_value(details).unwrap();
            let fields = wire.as_object().unwrap();
            assert_eq!(fields.len(), 6);
            for field in [
                "category",
                "recovery_action",
                "http_status",
                "retryable",
                "resume_safe",
                "retry_after_ms",
            ] {
                assert!(fields.contains_key(field));
            }
            assert!(!wire.to_string().contains(code));
        }
    }
    #[test]
    fn non_http_compaction_requires_a_known_request_error_type() {
        for (kind, message, expected) in [
            ("authentication_error", "context window network 429", false),
            ("unknown", "context window network 429", false),
            ("overloaded_error", "context window", false),
            ("invalid_request_error", "context window", true),
            ("invalid_request_error", "network 429", false),
            ("context_length_exceeded", "request rejected", true),
        ] {
            let error = kcoder_api::ApiErrorKind::Api {
                error_type: kind.into(),
                message: message.into(),
            };
            assert_eq!(
                super::super::is_prompt_too_long_provider_error(&error),
                expected,
                "{kind}/{message}"
            );
        }
        let parser = kcoder_api::ApiErrorKind::SseStream {
            error_type: "sse_stream".into(),
            message: "context window".into(),
            kind: kcoder_api::SseErrorKind::Parser,
        };
        assert!(!super::super::is_prompt_too_long_provider_error(&parser));
    }

    #[test]
    fn non_http_api_types_ignore_misleading_diagnostic_text() {
        for kind in [
            "authentication_error",
            "invalid_request_error",
            "unknown",
            "sse_stream",
            "sse_stream_error",
            "OVERLOADED_ERROR",
            " overloaded_error ",
            "overloaded_error_extra",
        ] {
            let error = kcoder_api::ApiErrorKind::Api {
                error_type: kind.into(),
                message: "network 429 stream idle timeout retry_after=99".into(),
            };
            assert!(!super::is_retryable_api_error(&error), "{kind}");
            assert!(!super::is_rate_limit_api_error(&error), "{kind}");
            assert_eq!(super::api_server_retry_after(&error), None, "{kind}");
        }
    }

    #[test]
    fn non_http_known_types_use_only_the_declared_type() {
        for kind in [
            "overloaded_error",
            "rate_limit_error",
            "stream_incomplete",
            "stream_idle_timeout",
        ] {
            let error = kcoder_api::ApiErrorKind::Api {
                error_type: kind.into(),
                message: "authentication 429 retry_after=99".into(),
            };
            assert!(super::is_retryable_api_error(&error), "{kind}");
            assert_eq!(
                super::is_rate_limit_api_error(&error),
                kind == "rate_limit_error"
            );
            assert_eq!(super::api_server_retry_after(&error), None);
        }
    }

    use super::*;

    fn http_error(
        status: u16,
        code: Option<&str>,
        kind: Option<&str>,
        message: &str,
    ) -> kcoder_api::ApiErrorKind {
        kcoder_api::ApiErrorKind::Http {
            error_type: "api_error".into(),
            message: message.into(),
            metadata: kcoder_api::HttpErrorMetadata {
                status,
                provider_code: code.map(str::to_owned),
                provider_type: kind.map(str::to_owned),
                rejected_reasoning_parameter: None,
                retry_after: Some(Duration::from_secs(2)),
            },
        }
    }

    #[test]
    fn reasoning_recovery_requires_allowlisted_machine_facts() {
        use kcoder_api::RejectedReasoningParameter::*;
        for status in [400, 422, 401, 403, 413] {
            for kind in [None, Some("invalid_request_error"), Some("other")] {
                for parameter in [
                    None,
                    Some(Thinking),
                    Some(ReasoningEffort),
                    Some(Reasoning),
                    Some(ReasoningDotEffort),
                ] {
                    let mut error = http_error(
                        status,
                        Some("unsupported_parameter"),
                        kind,
                        "context window exceeded: thinking",
                    );
                    if let kcoder_api::ApiErrorKind::Http { metadata, .. } = &mut error {
                        metadata.rejected_reasoning_parameter = parameter;
                    }
                    let actual = http_recovery_action(&error);
                    let expected = if matches!(status, 401 | 403) {
                        HttpRecoveryAction::NeedsHuman(HttpDiagnosis::Authentication)
                    } else if matches!(status, 400 | 422)
                        && kind != Some("other")
                        && parameter.is_some()
                    {
                        HttpRecoveryAction::DowngradeThinking(parameter.unwrap())
                    } else {
                        HttpRecoveryAction::NeedsHuman(HttpDiagnosis::RequestParameters)
                    };
                    assert_eq!(actual, Some(expected));
                    assert!(!is_retryable_api_error(&error));
                    assert!(!super::super::is_prompt_too_long_provider_error(&error));
                }
            }
        }
    }

    #[test]
    fn http_recovery_status_blocks_misleading_context_bodies() {
        for status in [401, 403, 404, 429, 500, 502, 503, 504, 529, 418, 599] {
            let error = http_error(
                status,
                Some("context_length_exceeded"),
                None,
                "auth 429 context window exceeded",
            );
            assert!(
                !super::super::is_prompt_too_long_provider_error(&error),
                "{status}"
            );
        }
    }

    #[test]
    fn http_recovery_client_context_requires_known_signal() {
        for status in [400, 413, 422] {
            for (code, kind, message) in [
                (Some("context_length_exceeded"), None, "request rejected"),
                (None, Some("context_length_exceeded"), "request rejected"),
                (None, None, "prompt is too long"),
            ] {
                let error = http_error(status, code, kind, message);
                assert!(
                    super::super::is_prompt_too_long_provider_error(&error),
                    "{status}: {error:?}"
                );
                assert!(!is_retryable_api_error(&error));
            }
            let error = http_error(
                status,
                Some("invalid_request_error"),
                None,
                "invalid parameter",
            );
            assert!(!super::super::is_prompt_too_long_provider_error(&error));
            assert!(
                super::super::provider_error_message("test", &error)
                    .contains("request-parameter error")
            );
        }
    }

    #[test]
    fn http_recovery_help_follows_status_and_preserves_original_error() {
        for (status, help) in [
            (401, "Check API key and provider permissions"),
            (403, "Check API key and provider permissions"),
            (404, "Check model name and provider endpoint"),
            (429, "transient provider/server error"),
            (503, "transient provider/server error"),
            (418, "not classified for automatic recovery"),
        ] {
            let error = http_error(
                status,
                None,
                None,
                "auth 429 context window tool result follow",
            );
            let message = super::super::provider_error_message("test", &error);
            assert!(message.contains(help), "{status}: {message}");
            assert!(message.contains(&error.to_string()));
        }
        let error = http_error(400, Some("context_length_exceeded"), None, "opaque");
        assert!(super::super::provider_error_message("test", &error).contains("context window"));
    }

    #[test]
    fn http_recovery_retry_carries_only_typed_rate_and_hint() {
        for status in [429, 500, 502, 503, 504, 529] {
            let error = http_error(status, None, None, "auth 429 context window retry_after=99");
            assert_eq!(
                http_recovery_action(&error),
                Some(HttpRecoveryAction::Retry {
                    rate_limited: status == 429,
                    retry_after: Some(Duration::from_secs(2)),
                })
            );
            assert!(is_retryable_api_error(&error));
            assert_eq!(is_rate_limit_api_error(&error), status == 429);
            assert_eq!(api_server_retry_after(&error), Some(Duration::from_secs(2)));
        }
    }

    #[test]
    fn http_recovery_preserves_legacy_api_context_and_diagnostics() {
        let error = kcoder_api::ApiErrorKind::Api {
            error_type: "invalid_request_error".into(),
            message: "prompt is too long".into(),
        };
        assert_eq!(http_recovery_action(&error), None);
        assert!(super::super::is_prompt_too_long_provider_error(&error));
        assert!(
            super::super::provider_error_message("test", &error)
                .contains("request-parameter error")
        );
        let error = kcoder_api::ApiErrorKind::Api {
            error_type: "api_error".into(),
            message: "429 retry_after=3".into(),
        };
        assert!(!is_retryable_api_error(&error));
        assert!(!is_rate_limit_api_error(&error));
        assert_eq!(api_server_retry_after(&error), None);
    }

    #[test]
    fn http_authentication_body_cannot_trigger_retry() {
        let error = kcoder_api::ApiErrorKind::Http {
            error_type: "authentication_error".into(),
            message: "network 429 retry_after=99".into(),
            metadata: kcoder_api::HttpErrorMetadata {
                status: 401,
                provider_code: None,
                provider_type: Some("authentication_error".into()),
                rejected_reasoning_parameter: None,
                retry_after: Some(Duration::from_secs(2)),
            },
        };
        assert!(!is_retryable_api_error(&error));
        assert!(!is_retryable_error(&error));
        if let kcoder_api::ApiErrorKind::Http { message, .. } = &error {
            assert!(is_retryable_error(message));
        }
        assert!(!is_rate_limit_api_error(&error));
        assert_eq!(api_server_retry_after(&error), Some(Duration::from_secs(2)));
    }

    #[test]
    fn http_status_is_authoritative_for_retry_and_rate_limit() {
        for status in [
            400, 401, 403, 404, 408, 418, 429, 500, 501, 502, 503, 504, 529, 599,
        ] {
            let error = kcoder_api::ApiErrorKind::Http {
                error_type: "network 429".into(),
                message: "retry_after=99".into(),
                metadata: kcoder_api::HttpErrorMetadata {
                    status,
                    provider_code: None,
                    provider_type: None,
                    rejected_reasoning_parameter: None,
                    retry_after: None,
                },
            };
            assert_eq!(
                is_retryable_api_error(&error),
                matches!(status, 429 | 500 | 502 | 503 | 504 | 529),
                "{status}"
            );
            assert_eq!(is_rate_limit_api_error(&error), status == 429, "{status}");
            assert_eq!(api_server_retry_after(&error), None);
        }
    }
}
