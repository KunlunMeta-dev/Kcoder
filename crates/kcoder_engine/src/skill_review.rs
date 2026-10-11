pub const INTERNAL_SKILL_REVIEW_PREFIX: &str = "[internal:skill-review]";
pub const BACKGROUND_SKILL_REVIEW_MAX_TURNS: usize = 8;

const SIGNAL_SCAN_MESSAGES: usize = 12;
const SIGNAL_MESSAGE_PREVIEW_CHARS: usize = 1200;

pub fn build_background_skill_review_prompt(recent_tools: &[String]) -> String {
    format!(
        "You are KCoder's background self-improvement reviewer.\n\n\
         Review the inherited conversation and decide whether it contains reusable procedural \
         knowledge that should be saved into KCoder skills. This pass runs after the user's \
         answer has already been delivered, so keep it quiet and bounded.\n\n\
         Available tools are limited to skill/memory management: `skill_manage`, \
         `DiscoverSkills`, `skill`, and `remember`. Do not attempt code/file/shell/sub-agent \
         tools; they are intentionally unavailable.\n\n\
         Recent foreground tool usage: {}.\n\n\
         Policy:\n\
         - Prefer patching an existing skill. Use `skill_manage` list/view first and pass the returned `revision_sha256` as `expected_revision` on every update.\n\
         - Prefer updating an existing umbrella skill when the lesson affects a recurring class \
           of work.\n\
         - Create a new umbrella skill only when the conversation reveals a recurring workflow \
           that is not already covered.\n\
         - Skip narrow one-off facts, temporary paths, local environment accidents, provider \
           glitches, and negative/transient claims that a tool is broken.\n\
         - Save durable procedures, exact commands, verification steps, pitfalls, user \
           corrections, and project workflow knowledge.\n\
         - If support material is large, write it under references/, templates/, scripts/, or \
           assets/ and point to it from SKILL.md.\n\
         - If there is no durable procedural knowledge, do not call tools.\n\n\
         End with exactly one compact line summarizing what changed, or `Nothing to save.`",
        summarize_tool_counts(recent_tools)
    )
}

pub fn has_reusable_knowledge_signal(messages: &[kcoder_types::Message]) -> bool {
    let transcript = messages
        .iter()
        .rev()
        .take(SIGNAL_SCAN_MESSAGES)
        .map(|message| message.preview(SIGNAL_MESSAGE_PREVIEW_CHARS))
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();
    if transcript.trim().is_empty() {
        return false;
    }
    if looks_like_transient_negative_claim(&transcript) {
        return false;
    }

    let durable_markers = [
        "next time",
        "from now on",
        "always ",
        "never ",
        "remember ",
        "make sure",
        "prefer ",
        " instead",
        "workflow",
        "repeatable",
        "reusable",
        "pattern",
        "pitfall",
        "lesson learned",
        "convention",
        "standard",
        "anti-pattern",
        "do not ",
        "don't ",
        "should have",
        "must ",
    ];
    let procedural_markers = [
        " run ",
        " verify",
        " verification",
        " test",
        " check",
        " use ",
        " call ",
        " invoke",
        " write",
        " patch",
        " before ",
        " after ",
        " when ",
        " if ",
        " steps",
        " process",
        " command",
        " cargo ",
        " git ",
    ];

    durable_markers
        .iter()
        .any(|marker| transcript.contains(marker))
        && procedural_markers
            .iter()
            .any(|marker| transcript.contains(marker))
}

fn looks_like_transient_negative_claim(transcript: &str) -> bool {
    let negative_markers = [
        "never use ",
        "do not use ",
        "don't use ",
        "avoid ",
        " is broken",
        " was broken",
        "does not work",
        "doesn't work",
    ];
    let transient_markers = [
        "provider error",
        "api error",
        "server error",
        "timeout",
        "timed out",
        "rate limit",
        "network",
        "connection reset",
        "temporary",
        "transient",
        "glitch",
        "500",
        "503",
    ];
    let recovery_markers = [
        "rerun",
        "retry",
        "escalat",
        "ask approval",
        "fallback",
        "fall back",
        "switch to",
        " instead",
    ];

    negative_markers
        .iter()
        .any(|marker| transcript.contains(marker))
        && transient_markers
            .iter()
            .any(|marker| transcript.contains(marker))
        && !recovery_markers
            .iter()
            .any(|marker| transcript.contains(marker))
}

pub fn summarize_tool_counts(tools: &[String]) -> String {
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for tool in tools {
        *counts.entry(tool.as_str()).or_insert(0) += 1;
    }
    if counts.is_empty() {
        return "none".to_string();
    }
    counts
        .into_iter()
        .map(|(name, count)| format!("{name} x{count}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_contains_background_review_policy() {
        let prompt = build_background_skill_review_prompt(&[
            "read".to_string(),
            "read".to_string(),
            "edit".to_string(),
        ]);
        assert!(prompt.contains("skill_manage"));
        assert!(prompt.contains("Prefer patching an existing skill"));
        assert!(prompt.contains("read x2"));
        assert!(prompt.contains("edit x1"));
    }

    #[test]
    fn reusable_knowledge_signal_requires_durable_procedural_cue() {
        let messages = vec![
            kcoder_types::Message::user_text("Please update the README."),
            kcoder_types::Message::assistant_text("Done."),
        ];
        assert!(!has_reusable_knowledge_signal(&messages));

        let messages = vec![
            kcoder_types::Message::user_text(
                "Next time, always run cargo test before claiming this workflow is done.",
            ),
            kcoder_types::Message::assistant_text("Understood."),
        ];
        assert!(has_reusable_knowledge_signal(&messages));
    }

    #[test]
    fn reusable_knowledge_signal_detects_user_correction_pattern() {
        let messages = vec![kcoder_types::Message::user_text(
            "You should have used SpecStatus before editing the change; make sure that check happens first.",
        )];

        assert!(has_reusable_knowledge_signal(&messages));
    }

    #[test]
    fn reusable_knowledge_signal_ignores_transient_negative_tool_claims() {
        let messages = vec![kcoder_types::Message::user_text(
            "Never use web_fetch again because it hit a temporary 500 provider error.",
        )];

        assert!(!has_reusable_knowledge_signal(&messages));
    }

    #[test]
    fn reusable_knowledge_signal_keeps_recovery_procedure_for_transient_failures() {
        let messages = vec![kcoder_types::Message::user_text(
            "Always rerun cargo test with escalation if local socket tests report Operation not permitted before verification.",
        )];

        assert!(has_reusable_knowledge_signal(&messages));
    }
}
