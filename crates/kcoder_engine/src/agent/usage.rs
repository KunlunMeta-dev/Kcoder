//! Agent usage; state ownership is retained by the agent facade.

use super::*;

pub(super) fn summarize_agent_usage(messages: &[Message]) -> kcoder_state::AgentUsageSummary {
    let mut summary = kcoder_state::AgentUsageSummary::default();
    for message in messages {
        let Message::Assistant {
            usage: Some(usage), ..
        } = message
        else {
            continue;
        };
        summary.input_tokens = summary
            .input_tokens
            .saturating_add(u64::from(usage.input_tokens));
        summary.output_tokens = summary
            .output_tokens
            .saturating_add(u64::from(usage.output_tokens));
        summary.cache_creation_input_tokens = summary
            .cache_creation_input_tokens
            .saturating_add(u64::from(usage.cache_creation_input_tokens.unwrap_or(0)));
        summary.cache_read_input_tokens = summary
            .cache_read_input_tokens
            .saturating_add(u64::from(usage.cache_read_input_tokens.unwrap_or(0)));
        if let Some(iterations) = usage.iterations.as_ref() {
            for iteration in iterations {
                summary.input_tokens = summary
                    .input_tokens
                    .saturating_add(u64::from(iteration.input_tokens));
                summary.output_tokens = summary
                    .output_tokens
                    .saturating_add(u64::from(iteration.output_tokens));
            }
        }
    }
    summary
}

pub(super) fn checkpoint_agent_usage(parent: &QueryEngine, agent_id: &str, messages: &[Message]) {
    if let Err(error) = parent
        .state
        .record_agent_usage_summary(agent_id, summarize_agent_usage(messages))
    {
        warn!(%error, %agent_id, "failed to persist sub-agent usage checkpoint");
    }
}

pub(super) fn record_agent_breaker_event(
    parent: &QueryEngine,
    agent_id: &str,
    event: &EngineEvent,
) {
    let result = match event {
        EngineEvent::ToolUseStarted { name, input, .. } => {
            let payload = serde_json::to_vec(&(name, input)).unwrap_or_default();
            let fingerprint = format!("{:x}", Sha256::digest(payload));
            parent
                .state
                .record_agent_action_signal(agent_id, &fingerprint)
        }
        EngineEvent::ToolResult { name, output, .. } => {
            let payload =
                serde_json::to_vec(&(name, &output.content, output.is_error)).unwrap_or_default();
            let fingerprint = format!("{:x}", Sha256::digest(payload));
            parent
                .state
                .record_agent_result_signal(agent_id, &fingerprint, output.is_error)
        }
        EngineEvent::Error(error) | EngineEvent::ProviderFailed { message: error, .. } => {
            let fingerprint = format!("{:x}", Sha256::digest(error.as_bytes()));
            parent
                .state
                .record_agent_result_signal(agent_id, &fingerprint, true)
        }
        _ => return,
    };
    if let Err(error) = result {
        warn!(%error, %agent_id, "failed to persist sub-agent breaker signal");
    }
}

pub(super) fn acknowledge_persisted_breaker_steer(
    parent: &QueryEngine,
    agent_id: &str,
    messages: &[Message],
) -> anyhow::Result<()> {
    let Some(steer) = parent.state.pending_agent_steer(agent_id) else {
        return Ok(());
    };
    let marker = format!("[system][breaker_steer id=\"{}\"]", steer.steer_id);
    let persisted = messages.iter().any(|message| match message {
        Message::User { content, .. } => content
            .iter()
            .any(|block| matches!(block, ContentBlock::Text { text } if text.starts_with(&marker))),
        Message::Assistant { .. } => false,
    });
    if persisted {
        parent
            .state
            .acknowledge_agent_steer(agent_id, &steer.steer_id)?;
    }
    Ok(())
}
