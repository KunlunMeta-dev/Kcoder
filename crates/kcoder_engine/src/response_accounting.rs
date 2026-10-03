//! Response accounting within the shared engine ownership boundary.

use super::*;

pub(super) fn duration_millis_u64(duration: std::time::Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[allow(clippy::too_many_arguments)]
pub(super) fn provider_retry_details(
    error: &kcoder_api::ApiErrorKind,
    request_kind: &str,
    provider: &str,
    model: &str,
    attempt: usize,
    max_retries: usize,
    reason: String,
    retry_after: std::time::Duration,
    request_started_at: Instant,
    turn_started_at: Instant,
    transport_started_at: Instant,
    first_token_at: Option<Instant>,
    last_token_at: Option<Instant>,
) -> ProviderRetryDetails {
    let relative_millis = |instant: Instant| {
        duration_millis_u64(
            instant
                .checked_duration_since(request_started_at)
                .unwrap_or_default(),
        )
    };
    ProviderRetryDetails {
        request_kind: request_kind.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        attempt,
        max_retries,
        elapsed_ms: duration_millis_u64(request_started_at.elapsed()),
        turn_elapsed_ms: duration_millis_u64(turn_started_at.elapsed()),
        transport_elapsed_ms: duration_millis_u64(transport_started_at.elapsed()),
        retry_after_ms: duration_millis_u64(retry_after),
        first_token_ms: first_token_at.map(relative_millis),
        last_token_ms: last_token_at.map(relative_millis),
        timeout_kind: match error.non_http_error_class() {
            Some(kcoder_api::NonHttpErrorClass::StreamIdleTimeout) => Some("token_idle".into()),
            Some(kcoder_api::NonHttpErrorClass::TransportTimeout) => {
                Some("transport_timeout".into())
            }
            _ => None,
        },
        reason,
    }
}

/// Resolve whether project-level extensions (hooks, plugins, project MCP
/// servers, project skills) may be activated for `cwd`: explicit folder
/// trust in the store, or KCODER_TRUST_ALL for CI-style bypass.
pub(super) fn folder_trusted_for_cwd(_settings: &Settings, cwd: &Path) -> bool {
    if kcoder_config::FolderTrustStore::trust_all_from_environment() {
        return true;
    }
    let Ok(config_dir) = Settings::config_dir() else {
        return false;
    };
    kcoder_config::FolderTrustStore::load(&config_dir).check(cwd)
        == kcoder_config::FolderTrust::Trusted
}

pub(super) fn provider_error_message(provider: &str, error: &kcoder_api::ApiErrorKind) -> String {
    if let Some(action) = http_recovery_action(error) {
        let help = match action {
            HttpRecoveryAction::Retry { .. } => {
                "This is a transient provider/server error; KCoder retries it when max_retries allows it. If this is the final error, retry later or switch provider/model."
            }
            HttpRecoveryAction::CompactNow => {
                "The request exceeds the context window; KCoder attempts context compaction when allowed. If this is the final error, reduce the input or start a new conversation."
            }
            HttpRecoveryAction::DowngradeThinking(_) => {
                "The provider rejected an optional reasoning parameter; request-local recovery is unavailable or exhausted."
            }
            HttpRecoveryAction::NeedsHuman(HttpDiagnosis::Authentication)
            | HttpRecoveryAction::DiagnoseOnly(HttpDiagnosis::Authentication) => {
                "Check API key and provider permissions."
            }
            HttpRecoveryAction::NeedsHuman(HttpDiagnosis::ModelOrRoute)
            | HttpRecoveryAction::DiagnoseOnly(HttpDiagnosis::ModelOrRoute) => {
                "Check model name and provider endpoint."
            }
            HttpRecoveryAction::NeedsHuman(HttpDiagnosis::RequestParameters)
            | HttpRecoveryAction::DiagnoseOnly(HttpDiagnosis::RequestParameters) => {
                "This is a request-parameter error, not a network failure."
            }
            HttpRecoveryAction::NeedsHuman(HttpDiagnosis::Quota)
            | HttpRecoveryAction::DiagnoseOnly(HttpDiagnosis::Quota) => {
                "Check provider quota and billing before retrying."
            }
            HttpRecoveryAction::NeedsHuman(HttpDiagnosis::UnknownStatus)
            | HttpRecoveryAction::DiagnoseOnly(HttpDiagnosis::UnknownStatus) => {
                "This HTTP status is not classified for automatic recovery; check the provider response and configuration."
            }
        };
        return format!("{provider} provider API error: {error}. {help}");
    }
    match error {
        kcoder_api::ApiErrorKind::Api { error_type, .. }
        | kcoder_api::ApiErrorKind::Http { error_type, .. } => {
            let help = match error_type.as_str() {
                "authentication_error" | "permission_error" => {
                    "Check API key and provider permissions."
                }
                "invalid_request_error" => {
                    "This is a request-parameter error, not a network failure."
                }
                _ if is_retryable_api_error(error) => {
                    "This is a transient provider/server error; KCoder retries it when max_retries allows it. If this is the final error, retry later or switch provider/model."
                }
                _ => {
                    "This error is not classified for automatic recovery; check the provider response and configuration."
                }
            };
            format!("{provider} provider API error: {error}. {help}")
        }
        kcoder_api::ApiErrorKind::SseStream { .. } => {
            format!("{} provider stream error: {}.", provider, error)
        }
        kcoder_api::ApiErrorKind::Network(source) if source.is_builder() => {
            format!("{provider} provider request could not be built: {error}.")
        }
        kcoder_api::ApiErrorKind::Network(source) if source.is_decode() => {
            format!("{provider} provider response could not be parsed: {error}.")
        }
        kcoder_api::ApiErrorKind::Network(_) | kcoder_api::ApiErrorKind::EventSource(_) => {
            format!(
                "{} provider stream error: {}. Check base URL and network.",
                provider, error
            )
        }
        kcoder_api::ApiErrorKind::JsonParse(_, _) => {
            format!("{provider} provider response could not be parsed: {error}.")
        }
        kcoder_api::ApiErrorKind::CannotCloneRequest(_)
        | kcoder_api::ApiErrorKind::InvalidHeader(_) => {
            format!(
                "{} provider request could not be built: {}.",
                provider, error
            )
        }
    }
}

pub(super) fn can_downgrade_thinking(
    error: &kcoder_api::ApiErrorKind,
    provider: &dyn Provider,
) -> bool {
    matches!(http_recovery_action(error), Some(HttpRecoveryAction::DowngradeThinking(parameter))
        if provider.supports_reasoning_suppression(parameter))
}

pub(super) fn is_prompt_too_long_provider_error(error: &kcoder_api::ApiErrorKind) -> bool {
    match http_recovery_action(error) {
        Some(action) => action == HttpRecoveryAction::CompactNow,
        None => match error {
            kcoder_api::ApiErrorKind::Api {
                error_type,
                message,
            } => {
                error_type == "context_length_exceeded"
                    || (error_type == "invalid_request_error" && has_legacy_context_marker(message))
            }
            _ => false,
        },
    }
}

pub(super) fn put_stream_content_block(
    current_blocks: &mut Vec<ContentBlock>,
    index: usize,
    block: ContentBlock,
) {
    if index == current_blocks.len() {
        current_blocks.push(block);
    } else if let Some(slot) = current_blocks.get_mut(index) {
        *slot = block;
    } else {
        warn!(
            index,
            current_len = current_blocks.len(),
            "provider emitted a non-contiguous content block index"
        );
        current_blocks.push(block);
    }
}

/// Preserve the in-flight assistant message when a stream is abandoned after
/// content already streamed (e.g. the goal budget grace is exhausted). The
/// tokens were already consumed and charged, so dropping the partial message
/// would lose work the session paid for. Text and thinking blocks are kept
/// verbatim; tool-use blocks survive only when their input finished streaming
/// (they never executed), and each of those gets a synthetic interrupted
/// tool result so tool pairing stays valid for later requests.
pub(super) fn preserve_partial_turn_message(
    engine: &QueryEngine,
    current_blocks: &[ContentBlock],
    current_usage: &Option<Usage>,
    pending_tool_uses: &[(String, String, serde_json::Value)],
    note: &str,
) {
    let completed: std::collections::HashSet<&str> = pending_tool_uses
        .iter()
        .map(|(id, _, _)| id.as_str())
        .collect();
    let mut kept_tool_ids = Vec::new();
    let mut content: Vec<ContentBlock> = Vec::with_capacity(current_blocks.len() + 1);
    for block in current_blocks {
        match block {
            ContentBlock::ToolUse { id, .. } if completed.contains(id.as_str()) => {
                kept_tool_ids.push(id.clone());
                content.push(block.clone());
            }
            ContentBlock::ToolUse { .. } => {}
            ContentBlock::Text { .. }
            | ContentBlock::Thinking { .. }
            | ContentBlock::RedactedThinking { .. } => content.push(block.clone()),
            _ => {}
        }
    }
    if content.is_empty() {
        return;
    }
    content.push(ContentBlock::Text {
        text: format!("[{note}]"),
    });
    engine.state.add_message(Message::Assistant {
        content,
        usage: current_usage.clone(),
    });
    if !kept_tool_ids.is_empty() {
        engine.state.add_message(Message::User {
            origin: kcoder_types::MessageOrigin::Runtime,
            content: kept_tool_ids
                .iter()
                .map(|id| interrupted_tool_result(id))
                .collect(),
        });
    }
}

impl QueryEngine {
    /// Charge one provider usage snapshot and return the goal-budget abort
    /// reason when this increment exhausts the active goal.
    pub(super) fn charge_stream_usage(
        &self,
        previous: Option<&Usage>,
        incoming: &Usage,
    ) -> Option<(String, usize)> {
        let increment = usage_increment(previous, incoming);
        let goal_token_delta = UsageAccumulator::usage_total(&increment);
        recover_write_lock(&self.cumulative_usage, "cumulative_usage").add(&increment);
        if goal_token_delta == 0 {
            return None;
        }
        let goal = self.state.account_active_goal_usage(goal_token_delta, 0)?;
        if !goal.budget_exhausted() {
            return None;
        }
        let goal = self
            .state
            .update_active_goal_status(GoalStatus::BudgetLimited)
            .unwrap_or(goal);
        let budget = goal.token_budget.unwrap_or(goal.tokens_used);
        let name = if goal.mode.is_arrangement() {
            "UltGoal"
        } else if goal.mode.is_strict() {
            "Goal Pro"
        } else {
            "Goal"
        };
        let reason = format!(
            "{name} token budget reached ({}/{} tokens)",
            goal.tokens_used, budget
        );
        let cancelled_subagents = self.cancel_running_subagents_for_goal_stop(&reason);
        Some((reason, cancelled_subagents))
    }
}
