//! Overlay text: applying proposal changes and the pre-write guard
//! (secret redaction, `skill_guard` scan, slot size limit).

use super::{EvolutionServiceError, ServiceResult};
use crate::skill_guard::{SkillRiskLevel, scan_skill_content};
use kcoder_evolution::OVERLAY_SLOT_MAX_CHARS;
use kcoder_types::evolution::{OverlayContent, ProposalChanges, ProposalExample};

fn normalized(line: &str) -> &str {
    let trimmed = line.trim();
    trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .unwrap_or(trimmed)
        .trim()
}

fn lines(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

fn bullet(text: &str) -> String {
    format!("- {}", text.trim())
}

fn add_line(lines: &mut Vec<String>, text: &str) {
    if !lines.iter().any(|line| normalized(line) == text.trim()) {
        lines.push(bullet(text));
    }
}

fn remove_line(lines: &mut Vec<String>, text: &str) {
    lines.retain(|line| normalized(line) != text.trim());
}

fn replace_line(lines: &mut Vec<String>, from: &str, to: &str) {
    match lines
        .iter()
        .position(|line| normalized(line) == from.trim())
    {
        Some(index) => lines[index] = bullet(to),
        None => add_line(lines, to),
    }
}

fn upsert_example(examples: &mut Vec<ProposalExample>, example: &ProposalExample) {
    match examples.iter_mut().find(|item| item.name == example.name) {
        Some(existing) => existing.text = example.text.clone(),
        None => examples.push(example.clone()),
    }
}

/// Apply a proposal's change set to overlay content. Lessons and checklist
/// entries are bullet lines compared without their bullet marker.
pub fn apply_changes(base: &OverlayContent, changes: &ProposalChanges) -> OverlayContent {
    let mut lessons = lines(&base.lessons);
    for revision in &changes.lessons_revise {
        replace_line(&mut lessons, &revision.from, &revision.to);
    }
    for removed in &changes.lessons_remove {
        remove_line(&mut lessons, removed);
    }
    for added in &changes.lessons_add {
        add_line(&mut lessons, added);
    }
    let mut checklist = lines(&base.checklist);
    for edit in &changes.checklist_edits {
        add_line(&mut checklist, edit);
    }
    let mut examples = base.examples.clone();
    for example in &changes.examples {
        upsert_example(&mut examples, example);
    }
    OverlayContent {
        lessons: lessons.join("\n"),
        checklist: checklist.join("\n"),
        examples,
    }
}

/// Undo a promoted change set on the current stable content: added lessons
/// and checklist entries are removed, revisions are reverted, removed
/// lessons come back and examples the proposal wrote are dropped.
pub fn revert_changes(current: &OverlayContent, changes: &ProposalChanges) -> OverlayContent {
    let mut lessons = lines(&current.lessons);
    for added in &changes.lessons_add {
        remove_line(&mut lessons, added);
    }
    for revision in &changes.lessons_revise {
        replace_line(&mut lessons, &revision.to, &revision.from);
    }
    for removed in &changes.lessons_remove {
        add_line(&mut lessons, removed);
    }
    let mut checklist = lines(&current.checklist);
    for edit in &changes.checklist_edits {
        remove_line(&mut checklist, edit);
    }
    let mut examples = current.examples.clone();
    examples.retain(|example| {
        !changes
            .examples
            .iter()
            .any(|item| item.name == example.name)
    });
    OverlayContent {
        lessons: lessons.join("\n"),
        checklist: checklist.join("\n"),
        examples,
    }
}

/// Reject text the skill guard rates medium or high risk.
pub(super) fn scan_text(text: &str) -> ServiceResult<()> {
    let report = scan_skill_content(text);
    if let Some(finding) = report
        .findings
        .iter()
        .find(|finding| finding.level >= SkillRiskLevel::Medium)
    {
        return Err(EvolutionServiceError::new(
            "evolution_content_rejected",
            format!(
                "content rejected by the safety scan (line {}): {}",
                finding.line, finding.message
            ),
        ));
    }
    Ok(())
}

/// Redact secrets, enforce the slot limit and scan the result. Returns the
/// content to write.
pub fn guard_overlay_content(content: &OverlayContent) -> ServiceResult<OverlayContent> {
    let redact = |text: &str| crate::session_read::redact_secrets(text).0;
    let content = OverlayContent {
        lessons: redact(&content.lessons),
        checklist: redact(&content.checklist),
        examples: content
            .examples
            .iter()
            .map(|example| ProposalExample {
                name: redact(&example.name),
                text: redact(&example.text),
            })
            .collect(),
    };
    let chars = content.char_count();
    if chars > OVERLAY_SLOT_MAX_CHARS {
        return Err(EvolutionServiceError::new(
            "evolution_content_too_large",
            format!(
                "overlay content has {chars} characters; the limit is {OVERLAY_SLOT_MAX_CHARS}"
            ),
        ));
    }
    let mut text = vec![content.lessons.as_str(), content.checklist.as_str()];
    for example in &content.examples {
        text.push(&example.name);
        text.push(&example.text);
    }
    scan_text(&text.join("\n"))?;
    Ok(content)
}
