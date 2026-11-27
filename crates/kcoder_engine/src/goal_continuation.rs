use kcoder_state::{Goal, goal_objective_text, goal_report_relative_path};
use kcoder_types::{ContentBlock, Message};
use sha2::{Digest, Sha256};

const GOAL_CONTINUATION_TEMPLATE: &str = include_str!("../templates/goal_continuation.md");
const GOAL_ARRANGEMENT_NOTE_TEMPLATE: &str =
    include_str!("../templates/goal_continuation_arrangement.md");
const GOAL_STRICT_NOTE_TEMPLATE: &str = include_str!("../templates/goal_continuation_strict.md");
const GOAL_ANSWER_NOTE_TEMPLATE: &str = include_str!("../templates/goal_continuation_answer.md");
const GOAL_STALL_NOTE_TEMPLATE: &str = include_str!("../templates/goal_continuation_stall.md");
const GOAL_BAIL_NOTE_TEMPLATE: &str = include_str!("../templates/goal_continuation_bail.md");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrematureStopKind {
    GivingUp,
    UnableToProceed,
    StoppingHere,
    CheckBackLater,
}

impl PrematureStopKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GivingUp => "giving_up",
            Self::UnableToProceed => "unable_to_proceed",
            Self::StoppingHere => "stopping_here",
            Self::CheckBackLater => "check_back_later",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GoalContinuationDecision {
    pub stall_nudge: bool,
    pub premature_stop: Option<PrematureStopKind>,
}

/// Determine whether the current process exhausted its automatic-continuation
/// allowance. Callers maintain process-local counts so persisted audit counts are not mistaken for a cross-restart hard gate.
pub fn auto_continuation_limit_reached(limit: usize, continuation_count: usize) -> bool {
    continuation_count >= limit
}

pub fn plan_goal_continuation(
    goal_enabled: bool,
    goal: &Goal,
    final_text: Option<&str>,
) -> Option<GoalContinuationDecision> {
    if !goal_enabled || !goal.status.is_active() || goal.budget_exhausted() {
        return None;
    }
    Some(GoalContinuationDecision {
        stall_nudge: goal.stall_count >= 2,
        premature_stop: final_text.and_then(detect_premature_stop),
    })
}

pub fn latest_assistant_text(messages: &[Message]) -> Option<String> {
    messages.iter().rev().find_map(|message| {
        let Message::Assistant { content, .. } = message else {
            return None;
        };
        let text = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        (!text.trim().is_empty()).then_some(text)
    })
}

pub fn goal_progress_fingerprint(
    tool_names: &[String],
    touched_paths: &[String],
) -> Option<String> {
    if tool_names.is_empty() {
        return None;
    }
    let mut paths = touched_paths.to_vec();
    paths.sort();
    paths.dedup();
    let payload = format!(
        "tools:{}\npaths:{}",
        tool_names.join("\u{1f}"),
        paths.join("\u{1f}")
    );
    Some(format!("{:x}", Sha256::digest(payload.as_bytes())))
}

pub fn detect_premature_stop(text: &str) -> Option<PrematureStopKind> {
    let paragraph = text
        .rsplit("\n\n")
        .map(str::trim)
        .find(|paragraph| !paragraph.is_empty())?;
    let lower = paragraph.to_lowercase();

    if starts_with_phrase(&lower, &["i give up", "giving up", "我放弃", "只能放弃"]) {
        return Some(PrematureStopKind::GivingUp);
    }
    if starts_with_phrase(
        &lower,
        &[
            "unable to proceed",
            "i cannot proceed",
            "cannot proceed",
            "无法继续",
            "我无法继续",
        ],
    ) {
        return Some(PrematureStopKind::UnableToProceed);
    }
    if starts_with_phrase(
        &lower,
        &[
            "stopping here",
            "i'll stop here",
            "i will stop here",
            "我先停在这里",
            "先停在这里",
            "到这里为止",
        ],
    ) {
        return Some(PrematureStopKind::StoppingHere);
    }
    if starts_with_phrase(
        &lower,
        &[
            "check back later",
            "come back later",
            "稍后再继续",
            "之后再继续",
        ],
    ) && !lower.starts_with("check your")
        && !lower.starts_with("check you")
    {
        return Some(PrematureStopKind::CheckBackLater);
    }
    None
}

fn starts_with_phrase(text: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| {
        let Some(rest) = text.strip_prefix(phrase) else {
            return false;
        };
        rest.is_empty()
            || rest
                .chars()
                .next()
                .is_some_and(|character| !character.is_alphanumeric())
    })
}

pub fn format_goal_continuation_prompt(goal: &Goal, decision: &GoalContinuationDecision) -> String {
    let command = if goal.mode.is_arrangement() {
        "/ultgoal"
    } else if goal.mode.is_strict() {
        "/goal-pro"
    } else {
        "/goal"
    };
    let mut behavior_notes = String::new();
    if goal.mode.is_arrangement() {
        behavior_notes.push_str(GOAL_ARRANGEMENT_NOTE_TEMPLATE.trim_end());
        behavior_notes.push('\n');
    }
    if goal.mode.is_strict() {
        behavior_notes.push_str(GOAL_STRICT_NOTE_TEMPLATE.trim_end());
        behavior_notes.push('\n');
        if goal.verification_kind.is_answer() {
            let report_path = goal_report_relative_path(&goal.goal_id);
            behavior_notes.push_str(
                &GOAL_ANSWER_NOTE_TEMPLATE
                    .trim_end()
                    .replace("{report_path}", &report_path.to_string_lossy()),
            );
            behavior_notes.push('\n');
        }
        if let Some(context) = goal.context_snapshot.as_deref() {
            behavior_notes.push_str("\nGoal creation context (user-provided conversation summary):\n<context_snapshot>\n");
            behavior_notes.push_str(&escape_xml_text(context));
            behavior_notes.push_str("\n</context_snapshot>\n");
        }
    }
    if decision.stall_nudge {
        behavior_notes.push_str(GOAL_STALL_NOTE_TEMPLATE.trim_end());
        behavior_notes.push('\n');
    }
    if let Some(kind) = decision.premature_stop {
        behavior_notes.push_str(
            &GOAL_BAIL_NOTE_TEMPLATE
                .trim_end()
                .replace("{pattern}", kind.as_str()),
        );
        behavior_notes.push('\n');
    }
    let budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());
    let remaining_tokens = goal
        .token_budget
        .map(|budget| budget.saturating_sub(goal.tokens_used).to_string())
        .unwrap_or_else(|| "unbounded".to_string());
    let objective = match goal_objective_text(goal) {
        Ok(text) => text,
        Err(error) => format!(
            "{}\n\n[goal objective attachment read error: {error:#}]",
            goal.objective
        ),
    };
    let objective = escape_xml_text(&objective);
    let mut prompt = GOAL_CONTINUATION_TEMPLATE.trim_end().to_string();
    for (placeholder, value) in [
        ("{command}", command),
        ("{mode}", goal.mode.as_str()),
        ("{status}", goal.status.as_str()),
        ("{turn_count}", &goal.turn_count.to_string()),
        ("{tokens_used}", &goal.tokens_used.to_string()),
        ("{token_budget}", &budget),
        ("{tokens_remaining}", &remaining_tokens),
        ("{time_used_seconds}", &goal.time_used_seconds.to_string()),
        ("{behavior_notes}", &behavior_notes),
    ] {
        prompt = prompt.replace(placeholder, value);
    }
    prompt.replace("{objective}", &objective)
}

fn escape_xml_text(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::{Goal, GoalMode, GoalStatus};

    #[test]
    fn continuation_policy_combines_strict_stall_and_bail_signals() {
        let mut goal =
            Goal::new_with_file_and_mode("finish the remaining work", None, None, GoalMode::Strict);
        goal.stall_count = 2;
        goal.context_snapshot = Some("此前要求：修复登录并运行集成测试".to_string());

        let decision =
            plan_goal_continuation(true, &goal, Some("Stopping here because I cannot proceed."))
                .unwrap();
        assert!(decision.stall_nudge);
        assert_eq!(
            decision.premature_stop,
            Some(PrematureStopKind::StoppingHere)
        );

        let prompt = format_goal_continuation_prompt(&goal, &decision);
        assert!(prompt.contains("/goal-pro"));
        assert!(prompt.contains("independent verifier"));
        assert!(prompt.contains("progress fingerprint"));
        assert!(prompt.contains("prematurely stopping"));
        assert!(prompt.contains("此前要求：修复登录并运行集成测试"));
    }

    #[test]
    fn answer_continuation_requires_the_canonical_report() {
        use kcoder_state::GoalVerificationKind;

        let goal = Goal::new_with_file_mode_and_verification(
            "research the architecture",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Answer,
        )
        .unwrap();
        let decision = plan_goal_continuation(true, &goal, None).unwrap();
        let prompt = format_goal_continuation_prompt(&goal, &decision);

        assert!(prompt.contains(".kcoder/goal-reports/"));
        assert!(prompt.contains(&goal.goal_id));
        assert!(prompt.contains("32 KiB"));
    }

    #[test]
    fn continuation_policy_rejects_inactive_or_disabled_goal() {
        let mut goal = Goal::new("ship", None);
        assert!(plan_goal_continuation(false, &goal, None).is_none());
        goal.status = GoalStatus::Paused;
        assert!(plan_goal_continuation(true, &goal, None).is_none());
    }

    #[test]
    fn auto_continuation_limit_is_inclusive_and_zero_disables_injection() {
        assert!(auto_continuation_limit_reached(0, 0));
        assert!(!auto_continuation_limit_reached(2, 1));
        assert!(auto_continuation_limit_reached(2, 2));
        assert!(auto_continuation_limit_reached(2, 3));
    }

    #[test]
    fn premature_stop_detector_uses_last_paragraph_and_avoids_known_false_positives() {
        assert_eq!(
            detect_premature_stop("Work is incomplete.\n\nUnable to proceed without credentials."),
            Some(PrematureStopKind::UnableToProceed)
        );
        assert_eq!(
            detect_premature_stop("前面还有工作。\n\n我先停在这里。"),
            Some(PrematureStopKind::StoppingHere)
        );
        assert_eq!(
            detect_premature_stop("Stopping hereafter would be wrong."),
            None
        );
        assert_eq!(
            detect_premature_stop("Once the test settles I'll iterate."),
            None
        );
        assert_eq!(
            detect_premature_stop("Please check your results later."),
            None
        );
    }

    #[test]
    fn arrangement_prompt_keeps_arrangement_contract() {
        let goal = Goal::new_with_file_and_mode("ship", None, Some(100), GoalMode::Arrangement);
        let decision = plan_goal_continuation(true, &goal, None).unwrap();
        let prompt = format_goal_continuation_prompt(&goal, &decision);
        assert!(prompt.contains("/ultgoal"));
        assert!(prompt.contains("Do not perform implementation edits directly"));
    }

    #[test]
    fn progress_fingerprint_is_path_order_independent_and_skips_chat_turns() {
        assert!(goal_progress_fingerprint(&[], &["a".to_string()]).is_none());
        let tools = vec!["read".to_string(), "bash".to_string()];
        let first = goal_progress_fingerprint(&tools, &["b".to_string(), "a".to_string()]);
        let second = goal_progress_fingerprint(&tools, &["a".to_string(), "b".to_string()]);
        assert_eq!(first, second);
    }
}
