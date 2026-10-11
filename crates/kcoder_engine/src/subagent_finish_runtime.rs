//! Subagent finish runtime within the shared engine ownership boundary.

use super::*;

impl SubagentFinishReminder {
    pub(super) fn new(agent_id: String) -> Self {
        Self { agent_id }
    }
}

impl SubagentFinishReminderState {
    pub(super) fn new(reminder: SubagentFinishReminder, max_turns: usize) -> Self {
        Self {
            agent_id: reminder.agent_id,
            next_reminder_turn: subagent_finish_reminder_threshold(max_turns),
            reminder_interval: SUBAGENT_FINISH_REMINDER_INTERVAL_TURNS,
        }
    }

    pub(super) fn message_for_turn(
        &mut self,
        turn_count: usize,
        max_turns: usize,
    ) -> Option<String> {
        if turn_count < self.next_reminder_turn {
            return None;
        }
        let message = format!(
            "[system][subagent_finish_reminder] Agent `{}` has used {} of {} allowed internal turns, reaching at least two thirds of its max_turns budget. Stop expanding the task. Finish only essential remaining checks or artifact writes, then return a concise final result soon. If the task cannot be fully completed, report completed work, remaining work, blockers, and exact next steps. This reminder repeats every {} internal turns while the sub-agent continues running.",
            self.agent_id, turn_count, max_turns, self.reminder_interval
        );
        self.next_reminder_turn = turn_count.saturating_add(self.reminder_interval);
        Some(message)
    }
}

pub(super) fn subagent_finish_reminder_threshold(max_turns: usize) -> usize {
    let max_turns = max_turns.max(1);
    max_turns.saturating_mul(2).saturating_add(2) / 3
}

pub(super) fn terminal_verifier_tool_rejection_report(
    content: &[ContentBlock],
    rejected_tools: &[String],
) -> String {
    let provider_supplied_text = content
        .iter()
        .any(|block| matches!(block, ContentBlock::Text { text } if !text.trim().is_empty()));
    let mut tool_names = rejected_tools
        .iter()
        .map(|name| {
            name.chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
                })
                .take(64)
                .collect::<String>()
        })
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    tool_names.sort();
    tool_names.dedup();
    let tool_names = if tool_names.is_empty() {
        "unknown".to_string()
    } else {
        tool_names.join(", ")
    };
    let evidence = if provider_supplied_text {
        "The provider also supplied text in that incomplete response, but it was discarded and was not used as verdict evidence."
    } else {
        "The provider supplied no textual verdict, so the collected evidence cannot safely establish PASS or FAIL."
    };
    format!(
        "FLAKY\nThe provider requested disabled tool(s) `{tool_names}` during the final verifier verdict boundary (only VerifierVote is available). The requests were ignored and no tool was executed. Because that response still requested a tool, its evidence is incomplete and any textual PASS or FAIL was discarded. {evidence}"
    )
}
