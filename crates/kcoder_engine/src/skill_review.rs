pub const INTERNAL_SKILL_REVIEW_PREFIX: &str = "[internal:skill-review]";
pub const BACKGROUND_SKILL_REVIEW_MAX_TURNS: usize = 8;

use std::collections::BTreeMap;

/// Build the reviewer prompt. `reviewed_before` is how many of the
/// `message_count` inherited messages an earlier review already covered.
pub fn build_background_skill_review_prompt(
    tool_counts: &BTreeMap<String, usize>,
    reviewed_before: usize,
    message_count: usize,
) -> String {
    let coverage = if reviewed_before == 0 {
        format!(
            "No earlier review covered this conversation; consider all {message_count} inherited \
             messages."
        )
    } else {
        format!(
            "An earlier review already covered the first {reviewed_before} of the \
             {message_count} inherited messages. Focus on what changed after message \
             {reviewed_before}; use earlier messages only as context and do not re-save lessons \
             that come only from them."
        )
    };
    format!(
        "You are KCoder's background self-improvement reviewer.\n\n\
         Review the inherited conversation and decide whether it contains reusable procedural \
         knowledge that should be saved into KCoder skills. This pass runs after the user's \
         answer has already been delivered, so keep it quiet and bounded.\n\n\
         Available tools are limited to skill/memory management: `skill_manage`, \
         `DiscoverSkills`, `skill`, and `remember`. Do not attempt code/file/shell/sub-agent \
         tools; they are intentionally unavailable.\n\n\
         Foreground tool calls since the last review: {}.\n\n\
         {}\n\n\
         This review runs while the session is idle, after enough new tool activity \
         accumulated; it was not triggered by any keywords. The conversation may be in any \
         language; judge its meaning, and write saved skills in the language the conversation \
         and any existing skill already use. Most reviews should end with `Nothing to save.`\n\n\
         Policy:\n\
         - Prefer patching an existing skill. Use `skill_manage` list/view first and pass the returned `revision_sha256` as `expected_revision` on every update.\n\
         - Prefer updating an existing umbrella skill when the lesson affects a recurring class \
           of work.\n\
         - Create a new umbrella skill only when the conversation reveals a recurring workflow \
           that is not already covered.\n\
         - Skip narrow one-off facts, temporary paths, local environment accidents, and \
           provider glitches.\n\
         - Never record that a tool, command, or provider \"is broken\" or \"must not be used\" \
           because of a temporary failure such as a provider/API/server error, HTTP 5xx, \
           timeout, rate limit, or network/connection reset. A recovery procedure for such \
           failures (retry, escalate, request approval, fall back to an alternative) is durable \
           and may be saved.\n\
         - Never copy credentials, tokens, passwords, private keys, or personal data into a \
           skill; describe where the value comes from instead.\n\
         - Save durable procedures, exact commands, verification steps, pitfalls, user \
           corrections, and project workflow knowledge.\n\
         - If support material is large, write it under references/, templates/, scripts/, or \
           assets/ and point to it from SKILL.md.\n\
         - If there is no durable procedural knowledge, do not call tools.\n\n\
         End with exactly one compact line summarizing what changed, or `Nothing to save.`",
        summarize_tool_counts(tool_counts),
        coverage
    )
}

/// Reviewer prompt while self-evolution is enabled (plan section 13.1): the
/// review never edits existing skills or memory; it records findings and
/// proposes uncovered workflows, and the mode decides what happens next.
pub fn build_evolution_skill_review_prompt(
    tool_counts: &BTreeMap<String, usize>,
    reviewed_before: usize,
    message_count: usize,
) -> String {
    let base = build_background_skill_review_prompt(tool_counts, reviewed_before, message_count);
    let policy_start = base.find("Policy:").unwrap_or(base.len());
    format!(
        "{}Self-evolution is enabled, so this review only produces evidence and proposals:\n\
         - For an existing skill, call `evolution_review_finding` with the exact skill name and a \
           concise finding (lesson, pitfall, missing step). Findings are not applied; they wait \
           for observed outcomes to confirm them.\n\
         - For a recurring workflow no skill covers, call `evolution_propose_skill` with a new \
           name and the full SKILL.md (frontmatter with name and description).\n\
         - For a durable user preference or project fact, call `evolution_note` instead of \
           saving memory.\n\
         - Available tools are `evolution_review_finding`, `evolution_propose_skill`, \
           `evolution_note`, `skill` and `DiscoverSkills`. You cannot edit skill files or memory.\n\
         - Skip narrow one-off facts, temporary paths, environment accidents and provider \
           glitches (HTTP 5xx, timeouts, rate limits, network resets); a recovery procedure is \
           durable.\n\
         - Never copy credentials, tokens, passwords, private keys or personal data.\n\
         - If there is nothing durable, do not call tools.\n\n\
         End with exactly one compact line summarizing what you recorded, or `Nothing to save.`",
        &base[..policy_start]
    )
}

pub fn summarize_tool_counts(counts: &BTreeMap<String, usize>) -> String {
    if counts.is_empty() {
        return "none".to_string();
    }
    counts
        .iter()
        .map(|(name, count)| format!("{name} x{count}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(entries: &[(&str, usize)]) -> BTreeMap<String, usize> {
        entries
            .iter()
            .map(|(name, count)| (name.to_string(), *count))
            .collect()
    }

    #[test]
    fn prompt_contains_background_review_policy() {
        let prompt =
            build_background_skill_review_prompt(&counts(&[("read", 2), ("edit", 1)]), 0, 6);
        assert!(prompt.contains("skill_manage"));
        assert!(prompt.contains("Prefer patching an existing skill"));
        assert!(prompt.contains("read x2"));
        assert!(prompt.contains("edit x1"));
        assert!(prompt.contains("consider all 6 inherited messages"));
    }

    #[test]
    fn prompt_points_reviewer_at_activity_after_the_cursor() {
        let prompt = build_background_skill_review_prompt(&counts(&[("bash", 3)]), 8, 14);
        assert!(prompt.contains("first 8 of the 14 inherited messages"));
        assert!(prompt.contains("Focus on what changed after message 8"));
    }

    #[test]
    fn evolution_prompt_replaces_write_tools_with_evidence_tools() {
        let prompt = build_evolution_skill_review_prompt(&counts(&[("bash", 2)]), 0, 4);
        assert!(prompt.contains("evolution_review_finding"));
        assert!(prompt.contains("evolution_propose_skill"));
        assert!(prompt.contains("evolution_note"));
        assert!(prompt.contains("cannot edit skill files or memory"));
        assert!(!prompt.contains("Prefer patching an existing skill"));
        assert!(prompt.contains("bash x2"));
    }

    #[test]
    fn prompt_is_language_neutral_and_keeps_transient_failure_guidance() {
        let prompt = build_background_skill_review_prompt(&counts(&[("bash", 1)]), 0, 2);
        assert!(prompt.contains("may be in any language"));
        assert!(prompt.contains("not triggered by any keywords"));
        assert!(prompt.contains("while the session is idle"));
        assert!(prompt.contains("rate limit"));
        assert!(prompt.contains("recovery procedure"));
        assert!(prompt.contains("Nothing to save."));
    }
}
