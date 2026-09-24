use crate::agent::agent_status_json;
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_state::TaskStatus;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Close a spawned sub-agent and remove its tracking state.
#[derive(Debug, Default)]
pub struct CloseAgentTool;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CloseAgentInput {
    /// Agent id returned by `spawn_agent`.
    pub agent_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CloseAgentResult {
    previous_status: Value,
    closed: bool,
}

#[async_trait]
impl Tool for CloseAgentTool {
    fn name(&self) -> String {
        "close_agent".to_string()
    }

    fn description(&self) -> String {
        "Close a sub-agent by removing its tracking state and making that agent_id no longer \
         resumable through an attached follow-up control. Completed or failed sub-agents are already no longer running \
         and do not occupy the running sub-agent cap; close_agent is not required to free a \
         concurrency slot. Do not close pending or running sub-agents; wait for completion or send \
         them follow-up instructions first. Returns the agent's previous status before closing."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(CloseAgentInput));
        if let Value::Object(ref mut map) = schema {
            map.insert(
                "additionalProperties".to_string(),
                serde_json::Value::Bool(false),
            );
        }
        schema
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CloseAgentInput = parse_input(&input)?;
        let id = input.agent_id;

        let previous = ctx
            .state
            .task(&id)
            .ok_or_else(|| ToolError::InvalidInput(format!("agent {id} not found")))?;
        let previous_status = agent_status_json(&previous);

        if crate::background::is_tool_background_task_description(&previous.description) {
            return Ok(ToolOutput::error(
                serde_json::json!({
                    "previous_status": previous_status,
                    "closed": false,
                    "error": "not_a_subagent",
                    "next_action": format!(
                        "`{id}` is a background command task, not a sub-agent. Inspection or cancellation requires attached managed-job controls or the host."
                    ),
                })
                .to_string(),
            ));
        }

        let closed = match previous.status {
            TaskStatus::Pending | TaskStatus::Running => {
                return Ok(ToolOutput::error(
                    serde_json::json!({
                        "previous_status": previous_status,
                        "closed": false,
                        "error": "agent_still_running",
                        "next_action": format!(
                            "`{id}` is still running. Use attached completion/follow-up controls or the host when needed; close_agent is only for completed, failed, or cancelled sub-agents."
                        ),
                    })
                    .to_string(),
                ));
            }
            _ => {
                ctx.state.remove_task(&id);
                true
            }
        };

        Ok(ToolOutput::text(
            serde_json::to_string(&CloseAgentResult {
                previous_status,
                closed,
            })
            .map_err(|e| ToolError::Execution(format!("failed to serialize result: {e}")))?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::{AppState, Task, TaskStatus};

    #[test]
    fn close_agent_tool_schema_is_object() {
        let tool = CloseAgentTool;
        let schema = tool.input_schema();
        assert_eq!(schema.get("type").unwrap(), "object");
        assert!(
            schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("agent_id")
        );
    }

    #[test]
    fn close_agent_description_does_not_claim_to_free_completed_slots() {
        let description = CloseAgentTool.description();

        assert!(description.contains("removing its tracking state"));
        assert!(description.contains("no longer resumable"));
        assert!(description.contains("do not occupy the running sub-agent cap"));
        assert!(description.contains("not required to free"));
        assert!(description.contains("Do not close pending or running"));
        assert!(!description.contains("free its slot"));
    }

    #[tokio::test]
    async fn close_agent_removes_completed_task() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-1", "test");
        task.status = TaskStatus::Completed;
        task.output = Some("result".to_string());
        state.upsert_task(task);

        let ctx = ToolContext::new(state.clone());
        let tool = CloseAgentTool;
        let output = tool
            .call(serde_json::json!({"agent_id": "job-1"}), &ctx)
            .await
            .unwrap();

        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let result: CloseAgentResult = serde_json::from_str(&text).unwrap();
        assert!(result.closed);
        assert_eq!(
            result.previous_status,
            serde_json::json!({"completed": "result"})
        );
        assert!(state.task("job-1").is_none());
    }

    #[tokio::test]
    async fn close_agent_rejects_background_command_tasks() {
        let state = AppState::new("/tmp");
        let mut task = Task::new(
            "job-shell",
            crate::background::tool_background_description("bash", "cargo test"),
        );
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        let output = CloseAgentTool
            .call(
                serde_json::json!({
                    "agent_id": "job-shell"
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .unwrap();

        assert!(output.is_error);
        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["closed"], false);
        assert_eq!(value["error"], "not_a_subagent");
        assert!(value["next_action"].as_str().unwrap().contains("cancellation"));
        assert!(state.task("job-shell").is_some());
    }

    #[tokio::test]
    async fn close_agent_rejects_running_subagents_without_cancelling_them() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-running", "Implementer agent: patch");
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        let output = CloseAgentTool
            .call(
                serde_json::json!({
                    "agent_id": "job-running"
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .unwrap();

        assert!(output.is_error);
        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["closed"], false);
        assert_eq!(value["error"], "agent_still_running");
        assert_eq!(
            state.task("job-running").unwrap().status,
            TaskStatus::Running
        );
    }
}
