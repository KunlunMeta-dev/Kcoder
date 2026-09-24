use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_state::{TodoItem, TodoStatus};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

/// Update the session todo list.
#[derive(Debug, Default)]
pub struct TodoWriteTool;

/// Input to the `TodoWrite` tool.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TodoWriteInput {
    /// Complete replacement TodoList for the current session checklist. Must be a
    /// JSON array of todo objects; include every still-relevant item, not just
    /// the changed one.
    #[serde(rename = "TodoList", alias = "todos")]
    pub todos: Vec<TodoWriteItem>,
    /// Optional reason for clearing an empty TodoList, e.g. user cancellation or
    /// replacing an obsolete checklist. Clearing never claims task completion.
    #[serde(default)]
    pub clear_reason: Option<String>,
}

/// A single todo item.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TodoWriteItem {
    /// Imperative task text describing the outcome, e.g. "Run focused tests".
    /// Keep it concise and user-visible.
    pub content: String,
    /// Present-continuous form shown while in progress, e.g. "Running focused
    /// tests". Required for every todo item.
    #[serde(rename = "activeForm")]
    pub active_form: String,
    /// Current todo state. Use exactly one enum string: `pending`,
    /// `in_progress`, or `completed`.
    pub status: TodoWriteStatus,
}

/// Status values a todo item can have.
#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TodoWriteStatus {
    Pending,
    InProgress,
    Completed,
}

impl TodoWriteStatus {
    fn label(self) -> &'static str {
        match self {
            TodoWriteStatus::Pending => "pending",
            TodoWriteStatus::InProgress => "in_progress",
            TodoWriteStatus::Completed => "completed",
        }
    }
}

#[async_trait]
impl Tool for TodoWriteTool {
    fn name(&self) -> String {
        "TodoWrite".to_string()
    }

    fn description(&self) -> String {
        "Update the TodoList for the current coding session — the agent's own execution checklist for the work at hand. Use this proactively for multi-step work in progress, \
         user-provided task lists, new instructions, and discovered follow-up work. Skip it for trivial one-step, \
         purely conversational, or immediately completed tasks. This is NOT the orchestration layer: when work spans turns, carries dependencies, or must notify the user on completion, use an attached task-orchestration control if one exists; TodoWrite only tracks the current checklist. The `TodoList` input is the complete replacement list, not a \
         partial patch. Each TodoList item requires `content` in imperative form (for example `Run tests`) and `activeForm` \
         in present-continuous form (for example `Running tests`). Valid statuses are `pending`, `in_progress`, \
         and `completed`. Do not call TodoWrite with placeholder strings such as `{\"TodoList\":[\"\"]}`; \
         if there is no concrete checklist to track, skip TodoWrite instead. Do not send null-valued fields anywhere in the TodoWrite input: every todo object must \
         provide non-null `content`, `activeForm`, and `status` values. An empty TodoList clears the checklist without claiming completion; use clear_reason to record cancellation or why the checklist is obsolete. For a non-empty list where every item in `TodoList` has status `completed`, TodoWrite clears the stored TodoList and returns `all todos are completed`. Ideally exactly ONE task is `in_progress` at any time unless all tasks are completed; \
         complete the current task before starting another, remove irrelevant tasks entirely, and never mark a task \
         completed while tests are failing, implementation is partial, blockers remain, or required files/dependencies \
         were not found."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(TodoWriteInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: TodoWriteInput = parse_input(&input)?;
        if let Some(reason) = &input.clear_reason {
            if !input.todos.is_empty() || reason.trim().is_empty() || reason.len() > 2048 {
                return Err(ToolError::InvalidInput("clear_reason requires an empty TodoList and 1..=2048 UTF-8 bytes of non-whitespace reason text".into()));
            }
        }
        let old_todos = ctx.state.todos();

        let all_done = !input.todos.is_empty()
            && input
                .todos
                .iter()
                .all(|item| matches!(item.status, TodoWriteStatus::Completed));
        let in_progress_count = input
            .todos
            .iter()
            .filter(|item| matches!(item.status, TodoWriteStatus::InProgress))
            .count();
        let verification_nudge_needed = all_done
            && input.todos.len() >= 3
            && !input.todos.iter().any(|item| {
                mentions_verification(&item.content) || mentions_verification(&item.active_form)
            });

        let stored_todos: Vec<TodoItem> = if all_done {
            Vec::new()
        } else {
            input
                .todos
                .iter()
                .enumerate()
                .map(|(idx, item)| TodoItem {
                    id: format!("todo-{}", idx + 1),
                    content: item.content.clone(),
                    active_form: Some(item.active_form.clone()),
                    status: match item.status {
                        TodoWriteStatus::Pending => TodoStatus::Pending,
                        TodoWriteStatus::InProgress => TodoStatus::InProgress,
                        TodoWriteStatus::Completed => TodoStatus::Completed,
                    },
                })
                .collect()
        };

        ctx.state.set_todos(stored_todos);

        let mut text = String::from(
            "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.",
        );
        text.push_str(&format!("\n\nPrevious todo count: {}", old_todos.len()));

        if input.todos.is_empty() {
            text.push_str("\nTodoList cleared without marking unfinished tasks completed.");
            if let Some(reason) = &input.clear_reason {
                text.push_str(&format!("\nClear reason: {}", reason.trim()));
            }
        } else if all_done {
            text.push_str("\nall todos are completed; the TodoList has been cleared.");
        } else {
            text.push_str(&format!("\nCurrent todo count: {}", input.todos.len()));
            for item in &input.todos {
                text.push_str(&format!(
                    "\n- [{}] {} ({})",
                    item.status.label(),
                    item.content,
                    item.active_form
                ));
            }
            if in_progress_count != 1 {
                text.push_str(&format!(
                    "\n\nChecklist warning: exactly ONE todo should be in_progress during active work; found {in_progress_count}. Update TodoWrite before continuing if this list is still active."
                ));
            }
        }

        if verification_nudge_needed {
            text.push_str(
                "\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing the final summary, perform focused verification using attached capabilities, or report that verification is unavailable.",
            );
        }

        Ok(ToolOutput::text(text))
    }
}

fn mentions_verification(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("verif")
        || lower.contains("test")
        || lower.contains("build")
        || text.contains("验证")
        || text.contains("测试")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolContext;
    use serde_json::json;

    fn text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn clearing_or_cancelling_is_not_completion_and_invalid_reasons_do_not_mutate() {
        let ctx = ToolContext::new(kcoder_state::AppState::new("."));
        let pending = json!({"TodoList":[{"content":"Fix bug","activeForm":"Fixing bug","status":"pending"}]});
        TodoWriteTool.call(pending.clone(), &ctx).await.unwrap();
        let mut invalid = pending.clone();
        invalid["clear_reason"] = json!("user cancelled");
        assert!(TodoWriteTool.call(invalid, &ctx).await.is_err());
        assert_eq!(ctx.state.todos().len(), 1);
        assert!(
            TodoWriteTool
                .call(json!({"TodoList":[],"clear_reason":" "}), &ctx)
                .await
                .is_err()
        );
        assert_eq!(ctx.state.todos().len(), 1);
        let cancelled = TodoWriteTool
            .call(
                json!({"TodoList":[],"clear_reason":"User cancelled the request"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(text(&cancelled).contains("User cancelled"));
        assert!(!text(&cancelled).contains("all todos are completed"));
        assert!(ctx.state.todos().is_empty());
        TodoWriteTool.call(pending, &ctx).await.unwrap();
        let cleared = TodoWriteTool
            .call(json!({"TodoList":[]}), &ctx)
            .await
            .unwrap();
        assert!(!text(&cleared).contains("all todos are completed"));
        assert!(text(&cleared).contains("without marking unfinished tasks completed"));
    }

    #[test]
    fn description_contains_claude_code_task_management_guidance() {
        let tool = TodoWriteTool;
        let description = tool.description();

        assert!(description.contains("complete replacement list"));
        assert!(description.contains("`TodoList` input"));
        assert!(description.contains("returns `all todos are completed`"));
        assert!(description.contains("exactly ONE task is `in_progress`"));
        assert!(description.contains("placeholder strings"));
        assert!(description.contains("{\"TodoList\":[\"\"]}"));
        assert!(description.contains("Do not send null-valued fields"));
        assert!(description.contains("non-null `content`, `activeForm`, and `status`"));
        assert!(description.contains("Skip it for trivial"));
        assert!(description.contains("never mark a task"));
    }

    #[tokio::test]
    async fn todo_write_preserves_pending_status() {
        let state = kcoder_state::AppState::new(".");
        let tool = TodoWriteTool;

        tool.call(
            json!({
                "TodoList": [
                    {
                        "content": "Inspect renderer",
                        "activeForm": "Inspecting renderer",
                        "status": "pending"
                    },
                    {
                        "content": "Patch TUI",
                        "activeForm": "Patching TUI",
                        "status": "in_progress"
                    }
                ]
            }),
            &ToolContext::new(state.clone()),
        )
        .await
        .expect("todo write succeeds");

        let todos = state.todos();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].status, TodoStatus::Pending);
        assert_eq!(todos[1].status, TodoStatus::InProgress);
    }

    #[tokio::test]
    async fn todo_write_warns_when_active_list_has_no_in_progress_item() {
        let state = kcoder_state::AppState::new(".");
        let tool = TodoWriteTool;

        let output = tool
            .call(
                json!({
                    "todos": [
                        {
                            "content": "Inspect renderer",
                            "activeForm": "Inspecting renderer",
                            "status": "pending"
                        }
                    ]
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .expect("todo write succeeds");

        assert!(!output.is_error);
        assert!(text(&output).contains("exactly ONE todo should be in_progress"));
        assert_eq!(state.todos().len(), 1);
    }

    #[tokio::test]
    async fn todo_write_adds_verification_nudge_when_closing_large_unverified_list() {
        let state = kcoder_state::AppState::new(".");
        let tool = TodoWriteTool;

        let output = tool
            .call(
                json!({
                    "todos": [
                        {
                            "content": "Inspect renderer",
                            "activeForm": "Inspecting renderer",
                            "status": "completed"
                        },
                        {
                            "content": "Patch TUI",
                            "activeForm": "Patching TUI",
                            "status": "completed"
                        },
                        {
                            "content": "Update docs",
                            "activeForm": "Updating docs",
                            "status": "completed"
                        }
                    ]
                }),
                &ToolContext::new(state.clone()),
            )
            .await
            .expect("todo write succeeds");

        let output_text = text(&output);
        assert!(output_text.contains("all todos are completed"));
        assert!(output_text.contains("TodoList has been cleared"));
        assert!(output_text.contains("using attached capabilities"));
        assert!(output_text.contains("report that verification is unavailable"));
        assert!(!output_text.contains("spawn_agent"));
        assert!(state.todos().is_empty());
    }

    #[tokio::test]
    async fn todo_write_skips_verification_nudge_when_verification_was_tracked() {
        let state = kcoder_state::AppState::new(".");
        let tool = TodoWriteTool;

        let output = tool
            .call(
                json!({
                    "todos": [
                        {
                            "content": "Inspect renderer",
                            "activeForm": "Inspecting renderer",
                            "status": "completed"
                        },
                        {
                            "content": "Patch TUI",
                            "activeForm": "Patching TUI",
                            "status": "completed"
                        },
                        {
                            "content": "Run verification tests",
                            "activeForm": "Running verification tests",
                            "status": "completed"
                        }
                    ]
                }),
                &ToolContext::new(state),
            )
            .await
            .expect("todo write succeeds");

        assert!(!text(&output).contains("spawn a verifier sub-agent"));
    }
}
