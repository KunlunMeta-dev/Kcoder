use super::{SlashCommand, SlashResult};
use crate::{MessageRole, ReplApp};
use kcoder_engine::QueryEngine;
use kcoder_state::{TaskKind, TaskStatus};
use kcoder_types::ContentBlock;
use serde_json::{Value, json};
use std::fs;

#[derive(Default)]
pub(super) struct WorkflowCommand;

#[async_trait::async_trait]
impl SlashCommand for WorkflowCommand {
    fn name(&self) -> &'static str {
        "/workflow"
    }

    fn aliases(&self) -> &[&'static str] {
        &["/workflows"]
    }

    fn description(&self) -> &'static str {
        "Run and inspect embedded JavaScript workflows."
    }

    fn usage(&self) -> &'static str {
        "/workflow [list | run <name> [json-args] | resume <run-id> [json-args] | status <run-id> | stop <run-id>]"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let args = args.trim();
        if args.is_empty() || args.eq_ignore_ascii_case("list") {
            app.push_message(MessageRole::System, workflow_list(engine));
            return SlashResult::Handled;
        }

        let (command, rest) = split_once(args);
        match command.to_ascii_lowercase().as_str() {
            "run" => start_named_workflow(rest, app, engine).await,
            "resume" => resume_workflow(rest, app, engine).await,
            "status" => {
                let run_id = rest.trim();
                if run_id.is_empty() {
                    app.push_message(MessageRole::System, "Usage: /workflow status <run-id>");
                } else {
                    app.push_message(MessageRole::System, workflow_status(engine, run_id));
                }
                SlashResult::Handled
            }
            "stop" => {
                let run_id = rest.trim();
                if run_id.is_empty() {
                    app.push_message(MessageRole::System, "Usage: /workflow stop <run-id>");
                } else if engine.abort_background_job(run_id) {
                    app.push_message(MessageRole::System, format!("Stopped workflow {run_id}."));
                } else {
                    app.push_message(
                        MessageRole::System,
                        format!("Workflow {run_id} is not running or does not exist."),
                    );
                }
                SlashResult::Handled
            }
            _ => {
                // `/workflow review-changes {"strict":true}` is a concise
                // alias for `/workflow run ...`.
                start_named_workflow(args, app, engine).await
            }
        }
    }
}

async fn resume_workflow(input: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
    let (run_id, args_text) = split_once(input.trim());
    if run_id.is_empty() {
        app.push_message(
            MessageRole::System,
            "Usage: /workflow resume <run-id> [json-args]",
        );
        return SlashResult::Handled;
    }
    let mut request = json!({"resume": run_id});
    if !args_text.trim().is_empty() {
        let args: Value = match serde_json::from_str(args_text.trim()) {
            Ok(value) => value,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Invalid workflow JSON arguments: {error}"),
                );
                return SlashResult::Handled;
            }
        };
        request["args"] = args;
    }
    match engine.start_workflow(request).await {
        Ok(output) => app.push_message(
            MessageRole::System,
            workflow_started_text(&output.content, true),
        ),
        Err(error) => app.push_message(
            MessageRole::System,
            format!("Failed to resume workflow: {error}"),
        ),
    }
    SlashResult::Handled
}

async fn start_named_workflow(input: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
    let (name, args_text) = split_once(input.trim());
    if name.is_empty() {
        app.push_message(
            MessageRole::System,
            "Usage: /workflow run <name> [json-args]",
        );
        return SlashResult::Handled;
    }
    let args = if args_text.trim().is_empty() {
        Value::Null
    } else {
        match serde_json::from_str(args_text.trim()) {
            Ok(value) => value,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Invalid workflow JSON arguments: {error}"),
                );
                return SlashResult::Handled;
            }
        }
    };
    match engine
        .start_workflow(json!({"name": name, "args": args}))
        .await
    {
        Ok(output) => app.push_message(
            MessageRole::System,
            workflow_started_text(&output.content, false),
        ),
        Err(error) => app.push_message(
            MessageRole::System,
            format!("Failed to start workflow: {error}"),
        ),
    }
    SlashResult::Handled
}

fn workflow_list(engine: &QueryEngine) -> String {
    let mut tasks = engine
        .state
        .tasks()
        .into_values()
        .filter(|task| matches!(task.kind, TaskKind::Workflow))
        .collect::<Vec<_>>();
    tasks.sort_by_key(|task| std::cmp::Reverse(task.updated_at_ms));
    if tasks.is_empty() {
        return "No workflows in this session. Run one with /workflow run <name>.".to_string();
    }
    let mut lines = vec!["Workflows:".to_string()];
    for task in tasks {
        let progress = task
            .output_path
            .as_ref()
            .and_then(|path| path.parent())
            .and_then(workflow_progress)
            .map(|value| format!(" · {value}"))
            .unwrap_or_default();
        lines.push(format!(
            "- {} [{}] {}{}",
            task.id,
            status_label(task.status),
            task.description,
            progress
        ));
    }
    lines.join("\n")
}

fn workflow_status(engine: &QueryEngine, run_id: &str) -> String {
    let Some(task) = engine.state.task(run_id) else {
        return format!("Workflow {run_id} was not found in this session.");
    };
    if !matches!(task.kind, TaskKind::Workflow) {
        return format!("Task {run_id} is not a workflow.");
    }
    let mut lines = vec![format!(
        "Workflow {} [{}]\n{}",
        task.id,
        status_label(task.status),
        task.description
    )];
    if let Some(path) = task.output_path {
        lines.push(format!("output: {}", path.display()));
        if let Some(run_dir) = path.parent() {
            if let Some(progress) = workflow_progress(run_dir) {
                lines.push(format!("progress: {progress}"));
            }
            lines.push(format!("state: {}", run_dir.join("state.json").display()));
            lines.push(format!(
                "journal: {}",
                run_dir.join("journal.jsonl").display()
            ));
        }
    }
    if matches!(task.status, TaskStatus::Failed | TaskStatus::Cancelled)
        && let Some(output) = task.output
    {
        lines.push(format!("error: {output}"));
    }
    lines.join("\n")
}

fn status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Paused => "paused",
        TaskStatus::Halted => "halted",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn tool_output_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn workflow_started_text(blocks: &[ContentBlock], resumed: bool) -> String {
    let raw = tool_output_text(blocks);
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return raw;
    };
    let run_id = value["run_id"].as_str().unwrap_or("unknown");
    let verb = if resumed { "Resumed" } else { "Started" };
    let mut lines = vec![format!("{verb} workflow {run_id} in the background.")];
    lines.push(format!("status: /workflow status {run_id}"));
    lines.push(format!("stop: /workflow stop {run_id}"));
    lines.push("You can keep using the composer while the workflow runs.".to_string());
    lines.join("\n")
}

fn workflow_progress(run_dir: &std::path::Path) -> Option<String> {
    let state: Value = serde_json::from_slice(&fs::read(run_dir.join("state.json")).ok()?).ok()?;
    let started = state["agent_started"].as_u64().unwrap_or(0);
    let completed = state["agent_completed"].as_u64().unwrap_or(0);
    let failed = state["agent_failed"].as_u64().unwrap_or(0);
    let reused = state["agent_reused"].as_u64().unwrap_or(0);
    let phase = state["active_phase"].as_str();
    let mut parts = vec![format!("agents {completed}/{started} completed")];
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }
    if reused > 0 {
        parts.push(format!("{reused} reused"));
    }
    if let Some(phase) = phase {
        parts.push(format!("phase {phase}"));
    }
    Some(parts.join(" · "))
}

fn split_once(value: &str) -> (&str, &str) {
    value
        .find(char::is_whitespace)
        .map(|index| (&value[..index], value[index..].trim_start()))
        .unwrap_or((value, ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_once_preserves_json_tail() {
        assert_eq!(
            split_once("review {\"strict\": true}"),
            ("review", "{\"strict\": true}")
        );
    }

    #[test]
    fn formats_structured_start_as_user_facing_text() {
        let blocks = vec![ContentBlock::Text {
            text: json!({
                "run_id": "workflow-123-1",
                "state_file": "/tmp/state.json",
                "journal_file": "/tmp/journal.jsonl"
            })
            .to_string(),
        }];
        let text = workflow_started_text(&blocks, false);
        assert!(text.contains("Started workflow workflow-123-1"));
        assert!(text.contains("/workflow stop workflow-123-1"));
        assert!(!text.starts_with('{'));
    }
}
