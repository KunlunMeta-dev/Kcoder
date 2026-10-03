//! Visible activity, tools, todos, and goal status.

use super::*;

impl ReplApp {
    pub(super) fn status_indicator_visible(&self) -> bool {
        let stream_output_should_hide_status = self.streaming_output_active
            || (self.streaming_status_suppressed_after_output && self.pending_input_count() == 0);
        if stream_output_should_hide_status && self.active_status_detail().is_none() {
            return false;
        }
        self.has_interruptible_turn() || self.active_turn.is_some()
    }

    pub(super) fn status_elapsed(&self) -> Duration {
        self.turn_started_at
            .map(|started| started.elapsed())
            .unwrap_or_default()
    }

    pub(super) fn active_status_detail(&self) -> Option<String> {
        self.active_turn
            .as_ref()
            .and_then(|active| {
                active.entries.iter().rev().find_map(|entry| match entry {
                    ActiveEntry::Tool(ToolStatus::Running { name, input, .. })
                        if !(name.eq_ignore_ascii_case("write") && input.is_empty()) =>
                    {
                        Some(format_running_tool_detail(name, input))
                    }
                    ActiveEntry::Tool(ToolStatus::Running { .. }) => None,
                    ActiveEntry::Tool(ToolStatus::Done { status_text, .. }) => {
                        Some(status_text.trim().to_string()).filter(|text| !text.is_empty())
                    }
                    ActiveEntry::SubagentPanel(_) => None,
                    ActiveEntry::Text(_) => None,
                })
            })
            .or_else(|| reasoning_status_detail(&self.streaming_thinking_status))
    }

    pub(super) fn running_tool_activity(&self) -> Option<(String, String, bool)> {
        self.active_turn.as_ref().and_then(|active| {
            active.entries.iter().rev().find_map(|entry| match entry {
                ActiveEntry::Tool(ToolStatus::Running { name, input, .. })
                    if !(name.eq_ignore_ascii_case("write") && input.is_empty()) =>
                {
                    Some((
                        format_running_tool_activity(name, input),
                        format_running_tool_detail(name, input),
                        is_agent_tool_name(name),
                    ))
                }
                _ => None,
            })
        })
    }

    pub(super) fn running_tool_count(&self) -> usize {
        self.active_turn.as_ref().map_or(0, |active| {
            active
                .entries
                .iter()
                .filter(|entry| matches!(entry, ActiveEntry::Tool(ToolStatus::Running { .. })))
                .count()
        })
    }

    pub(super) fn active_todo_label(&self) -> Option<String> {
        self.todos
            .iter()
            .find(|todo| todo.status == TodoStatus::InProgress)
            .and_then(|todo| {
                todo.active_form
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .or_else(|| {
                        let content = todo.content.trim();
                        (!content.is_empty()).then_some(content)
                    })
            })
            .map(ToOwned::to_owned)
    }

    pub(super) fn activity_presentation(&self) -> ActivityPresentation {
        let snapshot = self.spinner.snapshot();
        let running_tool = self.running_tool_activity();
        let mut base_label = if let Some((label, _, _)) = running_tool.as_ref() {
            label.clone()
        } else if let Some(label) = self.foreground_operation_label.as_ref() {
            label.clone()
        } else if let Some(label) = self.path_previews.label() {
            label
        } else if let Some((name, chars)) = self.spinner.preparing_tool_progress() {
            if chars == 0 {
                format!("Preparing {name} input")
            } else {
                format!(
                    "Preparing {name} input · {} chars",
                    format_progress_count(chars)
                )
            }
        } else if let Some(todo) = self.active_todo_label() {
            todo
        } else if snapshot.phase == ActivityPhase::Thinking {
            format!(
                "Thinking · {}",
                format_worked_duration(snapshot.phase_elapsed)
            )
        } else {
            snapshot.phase.default_label().to_string()
        };
        if running_tool
            .as_ref()
            .is_some_and(|(_, _, is_agent)| *is_agent)
            && let Some(progress) = self.latest_background_job_progress()
        {
            // The tool title already carries the delegated task. Keep the
            // footer heartbeat short enough to survive narrow terminals and
            // reserve the full task description for the detail/summary row.
            base_label = progress.label();
        }
        let running_tool_count = self.running_tool_count();
        if running_tool_count > 1 {
            base_label.push_str(&format!(" · {running_tool_count} tools running"));
        }
        let silence_text = snapshot.silence_text();
        let label = silence_text
            .as_ref()
            .map(|silence| format!("{silence} · {base_label}"))
            .unwrap_or(base_label);

        let mut details = Vec::new();
        if let Some((_, detail, _)) = running_tool {
            if detail != label {
                details.push(detail);
            }
        } else if let Some(detail) = reasoning_status_detail(&self.streaming_thinking_status) {
            if detail != label {
                details.push(detail);
            }
        } else if let Some(detail) = self.active_status_detail()
            && detail != label
        {
            details.push(detail);
        }
        if let Some(duration) = snapshot.thought_for {
            details.push(format!("Thought for {}", format_worked_duration(duration)));
        }
        if snapshot.is_long_task() {
            let mut summary = format!("Elapsed {}", format_worked_duration(snapshot.elapsed));
            if snapshot.estimated_output_tokens > 0 {
                summary.push_str(&format!(
                    " · ~{} output tokens",
                    snapshot.estimated_output_tokens
                ));
            }
            details.push(summary);
        }

        ActivityPresentation {
            snapshot,
            indicator: snapshot.indicator(),
            label,
            detail: (!details.is_empty()).then(|| details.join(" · ")),
        }
    }

    pub(super) fn goal_status_label(&self) -> String {
        let Some(goal) = self.goal.as_ref() else {
            return String::new();
        };
        goal_status_label(goal)
    }

    pub(crate) fn open_goal_replacement_confirmation(
        &mut self,
        existing: Goal,
        objective: String,
        token_budget: Option<u64>,
        mode: GoalMode,
    ) {
        self.open_goal_replacement_confirmation_with_verification(
            existing,
            objective,
            token_budget,
            mode,
            GoalVerificationKind::Artifact,
        );
    }

    pub(crate) fn open_goal_replacement_confirmation_with_verification(
        &mut self,
        existing: Goal,
        objective: String,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
    ) {
        if self.has_active_modal() {
            return;
        }
        self.spinner.pause();
        self.prepare_blocking_modal();
        self.pending_goal_replacement = Some(GoalReplacementDialog {
            existing_summary: compact_goal_summary(&existing),
            objective,
            token_budget,
            mode,
            verification_kind,
            selected: 0,
        });
        self.open_overlay_state(OverlayKind::GoalReplacement);
    }
}
