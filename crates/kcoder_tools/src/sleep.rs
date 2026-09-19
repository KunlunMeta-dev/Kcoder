use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use tokio::time::Duration;
use tracing::debug;

/// Wait for a specified duration.
#[derive(Debug, Default)]
pub struct SleepTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SleepInput {
    /// How long to sleep in seconds. Can be interrupted by the user at any time.
    pub duration_seconds: f64,
}

#[async_trait]
impl Tool for SleepTool {
    fn name(&self) -> String {
        "Sleep".to_string()
    }

    fn description(&self) -> String {
        "Wait for a specified duration. The user can interrupt the sleep at any time. \
         Use this when the user tells you to sleep or rest, when you have nothing to do, \
         or when you are waiting for something. You may receive periodic check-ins; \
         look for useful work to do before sleeping again. This tool can run concurrently \
         with other tools and will not interfere with them. Prefer this over Bash(sleep ...) \
         because it does not hold a shell process."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(SleepInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Ok(ToolOutput::text("Sleep interrupted after 0s"));
        }

        let input: SleepInput = parse_input(&input)?;
        let duration_seconds = input.duration_seconds.max(0.0);
        let total_duration = Duration::from_secs_f64(duration_seconds);

        debug!("sleeping for {} seconds", duration_seconds);

        let start = tokio::time::Instant::now();
        let mut shortened = false;
        tokio::select! {
            _ = tokio::time::sleep(total_duration) => {}
            _ = ctx.shortened() => {
                // The user collapsed the remaining wait to a short grace period
                // so that finished background work still gets one last chance
                // to land before this tool reports back.
                shortened = true;
                let remaining = total_duration.saturating_sub(start.elapsed());
                tokio::time::sleep(remaining.min(Duration::from_millis(500))).await;
            }
            _ = ctx.cancelled() => {
                return Ok(ToolOutput::text(format!(
                    "Sleep interrupted after {}s",
                    start.elapsed().as_secs_f64()
                )));
            }
        }

        if shortened {
            return Ok(ToolOutput::text(format!(
                "Slept for {}s (user shortened the wait to 0.5s)",
                start.elapsed().as_secs_f64()
            )));
        }
        Ok(ToolOutput::text(format!("Slept for {}s", duration_seconds)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn sleep_wakes_promptly_when_turn_is_cancelled() {
        let tmp = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_abort_token(token.clone());
        let trigger = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            trigger.cancel();
        });

        let output = tokio::time::timeout(
            Duration::from_millis(50),
            SleepTool.call(serde_json::json!({"duration_seconds": 60.0}), &ctx),
        )
        .await
        .expect("cancelled sleep should wake without a polling interval")
        .unwrap();

        assert!(output.content.iter().any(|block| {
            matches!(block, kcoder_types::ContentBlock::Text { text } if text.contains("interrupted"))
        }));
    }

    #[tokio::test]
    async fn sleep_is_shortened_to_the_grace_period_by_user_signal() {
        let tmp = tempfile::tempdir().unwrap();
        let signal = Arc::new(tokio::sync::Notify::new());
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_shorten_signal(signal.clone());
        let trigger = signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            trigger.notify_waiters();
        });

        let start = std::time::Instant::now();
        let output = tokio::time::timeout(
            Duration::from_millis(1200),
            SleepTool.call(serde_json::json!({"duration_seconds": 60.0}), &ctx),
        )
        .await
        .expect("shortened sleep should return well before the requested duration")
        .unwrap();

        assert!(
            start.elapsed() < Duration::from_millis(1000),
            "sleep should collapse to the half-second grace period"
        );
        assert!(output.content.iter().any(|block| {
            matches!(block, kcoder_types::ContentBlock::Text { text } if text.contains("shortened"))
        }));
    }
}
