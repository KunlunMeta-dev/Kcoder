use super::*;

pub(super) const TODO_UPDATE_REMINDER_TOOL_INTERVAL: usize = 20;

#[derive(Debug, Default)]
pub(super) struct TodoUpdateReminderTracker {
    completed_tools_since_todo_update: usize,
}

impl QueryEngine {
    pub(super) fn todo_update_reminder_after_tools(
        &self,
        completed_tool_calls: &[(String, bool)],
    ) -> Option<String> {
        if completed_tool_calls.is_empty() {
            return None;
        }

        let todos = self.state.todos();
        let mut tracker = recover_write_lock(
            &self.todo_update_reminder_tracker,
            "todo_update_reminder_tracker",
        );
        if todos.is_empty() {
            tracker.completed_tools_since_todo_update = 0;
            return None;
        }

        let successful_todo_update = completed_tool_calls
            .iter()
            .any(|(name, is_error)| name == "TodoWrite" && !*is_error);
        if successful_todo_update {
            tracker.completed_tools_since_todo_update = 0;
            return None;
        }

        tracker.completed_tools_since_todo_update = tracker
            .completed_tools_since_todo_update
            .saturating_add(completed_tool_calls.len());
        if tracker.completed_tools_since_todo_update < TODO_UPDATE_REMINDER_TOOL_INTERVAL {
            return None;
        }

        let elapsed = tracker.completed_tools_since_todo_update;
        tracker.completed_tools_since_todo_update = 0;
        Some(format_todo_update_reminder(&todos, elapsed))
    }

    /// Build the one-shot internal follow-up used when the model is about to
    /// end a main-thread turn with an untouched active TodoList.
    pub(super) fn todo_idle_update_reminder(
        &self,
        todo_updated_this_turn: bool,
        reminder_already_sent: bool,
    ) -> Option<String> {
        if todo_updated_this_turn || reminder_already_sent {
            return None;
        }
        let todos = self.state.todos();
        if !todos
            .iter()
            .any(|todo| matches!(todo.status, TodoStatus::Pending | TodoStatus::InProgress))
        {
            return None;
        }
        let managed_work_running = self.state.tasks().values().any(|task| {
            task.managed && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
        });
        if managed_work_running {
            return None;
        }
        Some(format_idle_todo_update_reminder(&todos))
    }
}

fn format_todo_update_reminder(todos: &[TodoItem], elapsed_tools: usize) -> String {
    const MAX_LISTED_TODOS: usize = 8;

    let mut text = format!(
        "TodoList maintenance reminder: there is still an active TodoList, but {elapsed_tools} tool calls have completed since the last successful TodoWrite update. Review whether any tasks were completed, became irrelevant, or need a new in_progress item. If the list changed, call TodoWrite now with the complete replacement TodoList. If all remaining tasks are complete, call TodoWrite with every item marked completed so it clears the list and returns `all todos are completed`."
    );
    text.push_str("\n\nCurrent TodoList:");
    for item in todos.iter().take(MAX_LISTED_TODOS) {
        text.push_str(&format!(
            "\n- [{}] {}",
            todo_status_label(&item.status),
            item.content
        ));
    }
    if todos.len() > MAX_LISTED_TODOS {
        text.push_str(&format!(
            "\n- ... {} more item(s) not shown",
            todos.len() - MAX_LISTED_TODOS
        ));
    }
    text
}

fn format_idle_todo_update_reminder(todos: &[TodoItem]) -> String {
    const MAX_LISTED_TODOS: usize = 8;

    let mut text = "<system-reminder>An active TodoList remains, no TodoWrite update occurred during this turn, and no managed tool or background task is currently running. Before ending, check whether the TodoList reflects the work actually completed. If it changed, call TodoWrite with the complete replacement list; if every item is done, mark every item completed so TodoWrite clears the list. Do not fabricate progress for work that is genuinely still pending.".to_string();
    text.push_str("\n\nCurrent TodoList:");
    for item in todos.iter().take(MAX_LISTED_TODOS) {
        text.push_str(&format!(
            "\n- [{}] {}",
            todo_status_label(&item.status),
            item.content
        ));
    }
    if todos.len() > MAX_LISTED_TODOS {
        text.push_str(&format!(
            "\n- ... {} more item(s) not shown",
            todos.len() - MAX_LISTED_TODOS
        ));
    }
    text.push_str("</system-reminder>");
    text
}

fn todo_status_label(status: &TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "pending",
        TodoStatus::InProgress => "in_progress",
        TodoStatus::Completed => "completed",
        TodoStatus::Cancelled => "cancelled",
    }
}
