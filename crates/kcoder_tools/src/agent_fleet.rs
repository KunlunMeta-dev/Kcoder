use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_state::SessionMode;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

const DEFAULT_FLEET_LIMIT: usize = 24;
const MAX_FLEET_LIMIT: usize = 100;
const DEFAULT_FLEET_OUTPUT_BYTES: usize = 32 * 1024;

#[derive(Debug, Default)]
pub struct AgentFleetTool;

#[derive(Debug, Deserialize, JsonSchema)]
struct AgentFleetInput {
    /// Whether to include agents in terminal states such as completed, failed, cancelled, or halted.
    #[serde(default)]
    include_terminal: bool,
    /// Cursor bound to the digest returned by the previous page; an old cursor fails closed after snapshot changes.
    #[serde(default)]
    cursor: Option<String>,
    /// Members per page, defaulting to 24 with a hard maximum of 100.
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    DEFAULT_FLEET_LIMIT
}

#[async_trait]
impl Tool for AgentFleetTool {
    fn name(&self) -> String {
        "AgentFleet".to_string()
    }

    fn description(&self) -> String {
        "Read the runtime-authenticated snapshot of direct sub-agents owned by this Orchestrate session. Returns stable status, control/breaker state, queue depth, bounded progress, usage, work binding, plan revision availability, a fleet revision, digest, and a digest-bound pagination cursor. It never returns prompts, message bodies, environment values, credentials, or full capability fingerprints. Use this instead of inferring agent state from prose.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(AgentFleetInput));
        if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
            properties.insert(
                "limit".to_string(),
                serde_json::json!({
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_FLEET_LIMIT,
                    "default": DEFAULT_FLEET_LIMIT
                }),
            );
        }
        schema
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.state.session_mode() != SessionMode::Orchestrate || ctx.agent_depth != 0 {
            return Err(ToolError::InvalidInput(
                "AgentFleet is only available to the main Orchestrate agent".to_string(),
            ));
        }
        let input: AgentFleetInput = parse_input(&input)?;
        if !(1..=MAX_FLEET_LIMIT).contains(&input.limit) {
            return Err(ToolError::InvalidInput(format!(
                "AgentFleet limit must be between 1 and {MAX_FLEET_LIMIT}"
            )));
        }
        let max_bytes = if ctx.max_output_bytes == 0 {
            DEFAULT_FLEET_OUTPUT_BYTES
        } else {
            ctx.max_output_bytes.min(128 * 1024)
        };
        let snapshot = ctx
            .state
            .snapshot_agent_fleet(
                input.include_terminal,
                input.cursor.as_deref(),
                input.limit,
                max_bytes,
            )
            .map_err(|error| ToolError::Execution(format!("AgentFleet failed: {error:#}")))?;
        let body = serde_json::to_string_pretty(&snapshot).map_err(|error| {
            ToolError::Execution(format!("AgentFleet serialization failed: {error}"))
        })?;
        Ok(ToolOutput::text(body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Tool;
    use kcoder_state::{AppState, Task, TaskKind, TaskStatus};

    #[test]
    fn schema_has_bounded_pagination() {
        let schema = AgentFleetTool.input_schema();
        assert_eq!(schema["properties"]["limit"]["maximum"], 100);
        assert!(AgentFleetTool.is_read_only());
        assert!(AgentFleetTool.is_concurrency_safe(&serde_json::json!({})));
    }

    #[tokio::test]
    async fn tool_rejects_non_orchestrate_and_returns_owned_agents() {
        let state = AppState::new("/tmp/kcoder-agent-fleet-tool");
        let default_context = ToolContext::new(state.clone());
        assert!(
            AgentFleetTool
                .call(serde_json::json!({}), &default_context)
                .await
                .is_err()
        );

        state.enter_orchestrate_before_first_message().unwrap();
        let mut task = Task::new("agent-owned", "private delegation message");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some(state.session_id());
        state.upsert_task(task);
        let output = AgentFleetTool
            .call(serde_json::json!({}), &ToolContext::new(state))
            .await
            .unwrap();
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert!(text.contains("agent-owned"));
        assert!(!text.contains("private delegation message"));
    }
}
