use crate::{PickerAction, ReplApp};
use kcoder_engine::QueryEngine;
use kcoder_state::{TaskKind, TaskStatus};
use kcoder_types::MessageRole;

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct AgentCommand;

#[async_trait::async_trait]
impl SlashCommand for AgentCommand {
    fn name(&self) -> &'static str {
        "/agent"
    }

    fn description(&self) -> &'static str {
        "List, view, or steer one sub-agent at its next safe boundary."
    }

    fn usage(&self) -> &'static str {
        "/agent [list | view <agent-id-or-unique-name> | back | steer <agent-id-or-unique-name> <message>]"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let args = args.trim();
        if args.is_empty() || args.eq_ignore_ascii_case("list") {
            show_agents(app, engine);
            return SlashResult::Handled;
        }
        if args.eq_ignore_ascii_case("back") {
            if app.leave_agent_view() {
                app.set_transient_status("Returned to parent conversation");
            } else {
                app.set_transient_status("Already viewing the parent conversation");
            }
            return SlashResult::Handled;
        }
        if let Some((action, target)) = args.split_once(char::is_whitespace)
            && action.eq_ignore_ascii_case("view")
        {
            let target = target.trim();
            if target.is_empty() {
                app.push_message(MessageRole::System, format!("Usage: {}", self.usage()));
                return SlashResult::Handled;
            }
            let agent_id = match resolve_agent_target(engine, target) {
                Ok(agent_id) => agent_id,
                Err(error) => {
                    app.push_message(MessageRole::System, error);
                    return SlashResult::Handled;
                }
            };
            let display_name = engine
                .state
                .task(&agent_id)
                .and_then(|task| task.roster_name)
                .unwrap_or_else(|| agent_id.clone());
            if let Err(error) = app
                .enter_agent_view_from_task(engine, agent_id.clone(), display_name)
                .await
            {
                app.push_message(MessageRole::System, error);
                return SlashResult::Handled;
            }
            app.set_transient_status(format!(
                "Viewing {agent_id}; composer input now steers this agent"
            ));
            return SlashResult::Handled;
        }

        let Some((action, rest)) = args.split_once(char::is_whitespace) else {
            app.push_message(MessageRole::System, format!("Usage: {}", self.usage()));
            return SlashResult::Handled;
        };
        if !action.eq_ignore_ascii_case("steer") {
            app.push_message(MessageRole::System, format!("Usage: {}", self.usage()));
            return SlashResult::Handled;
        }
        let rest = rest.trim_start();
        let Some((target, message)) = rest.split_once(char::is_whitespace) else {
            app.push_message(MessageRole::System, format!("Usage: {}", self.usage()));
            return SlashResult::Handled;
        };
        let message = message.trim();
        if message.is_empty() {
            app.push_message(MessageRole::System, format!("Usage: {}", self.usage()));
            return SlashResult::Handled;
        }

        let agent_id = match resolve_agent_target(engine, target) {
            Ok(agent_id) => agent_id,
            Err(error) => {
                app.push_message(MessageRole::System, error);
                return SlashResult::Handled;
            }
        };
        match engine.steer_subagent(&agent_id, message).await {
            Ok(receipt) => {
                let status = receipt.status.as_str();
                if receipt.queued {
                    if let Some(message_id) = receipt.message_id.as_deref() {
                        app.queue_subagent_steer_in_panel(
                            &agent_id,
                            message_id,
                            receipt.queue_position.unwrap_or(1),
                        );
                    }
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "Steering queued for {agent_id} ({status}, position {}).",
                            receipt.queue_position.unwrap_or(1)
                        ),
                    );
                } else {
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "Could not steer {agent_id} ({status}): {}",
                            receipt.next_action
                        ),
                    );
                }
            }
            Err(error) => app.push_message(
                MessageRole::System,
                format!("Could not steer {agent_id}: {error}"),
            ),
        }
        SlashResult::Handled
    }
}

fn show_agents(app: &mut ReplApp, engine: &QueryEngine) {
    let entries = agent_entries(engine);
    app.open_picker_overlay_with_selected(
        "Sub-agents",
        entries.iter().map(|(_, label)| label.clone()).collect(),
        PickerAction::ViewAgent,
        0,
    );
    if let Some(picker) = app
        .picker_overlay
        .as_mut()
        .filter(|picker| picker.on_confirm == PickerAction::ViewAgent)
    {
        picker.item_values = entries.into_iter().map(|(id, _)| id).collect();
    }
}

fn agent_entries(engine: &QueryEngine) -> Vec<(String, String)> {
    let owner = engine.state.session_id();
    let mut agents = engine
        .state
        .tasks()
        .into_values()
        .filter(|task| {
            task.kind == TaskKind::Subagent
                && task.parent_session_id.as_deref() == Some(owner.as_str())
        })
        .collect::<Vec<_>>();
    agents.sort_by(|left, right| left.id.cmp(&right.id));
    agents
        .into_iter()
        .map(|task| {
            let name = task
                .roster_name
                .as_deref()
                .map(|name| format!(" name={name}"))
                .unwrap_or_default();
            let description = task
                .description
                .split_once(" agent: ")
                .map(|(_, task)| task)
                .unwrap_or(&task.description);
            let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
            let label = format!(
                "{} [{}]{} queue={}\n{}",
                task.id,
                task_status_label(task.status),
                name,
                task.message_queue.len(),
                description
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .collect::<String>()
            );
            (task.id, label)
        })
        .collect()
}

pub(crate) fn refresh_agent_picker(app: &mut ReplApp, engine: &QueryEngine) -> bool {
    let Some(picker) = app
        .picker_overlay
        .as_mut()
        .filter(|picker| picker.on_confirm == PickerAction::ViewAgent)
    else {
        return false;
    };
    let selected_id = picker
        .matches_indexed()
        .get(picker.selected)
        .and_then(|(index, _)| picker.item_values.get(*index))
        .cloned();
    let entries = agent_entries(engine);
    let (ids, labels): (Vec<_>, Vec<_>) = entries.into_iter().unzip();
    if picker.all_items == labels && picker.item_values == ids {
        return false;
    }
    picker.all_items = labels;
    picker.item_values = ids;
    let matches = picker.matches_indexed();
    picker.selected = selected_id
        .and_then(|id| {
            matches
                .iter()
                .position(|(i, _)| picker.item_values.get(*i) == Some(&id))
        })
        .unwrap_or_else(|| picker.selected.min(matches.len().saturating_sub(1)));
    true
}

fn resolve_agent_target(engine: &QueryEngine, target: &str) -> Result<String, String> {
    let target = target.trim();
    let tasks = engine.state.tasks();
    let task = if let Some(task) = tasks.get(target) {
        task
    } else {
        let mut matches = tasks
            .values()
            .filter(|task| {
                task.kind == TaskKind::Subagent && task.roster_name.as_deref() == Some(target)
            })
            .collect::<Vec<_>>();
        match matches.len() {
            0 => {
                return Err(format!(
                    "Sub-agent '{target}' was not found in this session."
                ));
            }
            1 => matches.remove(0),
            _ => {
                return Err(format!(
                    "Sub-agent name '{target}' is ambiguous; use the canonical agent id."
                ));
            }
        }
    };
    if task.kind != TaskKind::Subagent {
        return Err(format!("Task '{}' is not a steerable sub-agent.", task.id));
    }
    if task.parent_session_id.as_deref() != Some(engine.state.session_id().as_str()) {
        return Err(format!(
            "Sub-agent '{}' is not owned by the current session.",
            task.id
        ));
    }
    Ok(task.id.clone())
}

fn task_status_label(status: TaskStatus) -> &'static str {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_exposes_targeted_steer_shape() {
        let command = AgentCommand;
        assert_eq!(command.name(), "/agent");
        assert!(
            command
                .usage()
                .contains("steer <agent-id-or-unique-name> <message>")
        );
    }
}
