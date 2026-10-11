//! Spec apply preflight domain implementation.

use super::*;

pub(super) fn apply_blockers_for_schema(schema: &str, change_dir: &Path) -> Vec<String> {
    if !config::is_superpowers_schema(schema) {
        return Vec::new();
    }

    let mut blockers = Vec::new();
    let review_path = change_dir.join("review.md");
    let Ok(review) = fs::read_to_string(&review_path) else {
        blockers.push("review.md is missing or unreadable".to_string());
        return blockers;
    };

    if markdown_section(&review, "Readiness Decision")
        .map(first_meaningful_line)
        .is_some_and(|line| line.eq_ignore_ascii_case("blocked"))
    {
        blockers.push("review.md Readiness Decision is blocked".to_string());
    }

    if markdown_section(&review, "Blocked By")
        .map(first_meaningful_line)
        .is_some_and(|line| !line.is_empty() && !line.eq_ignore_ascii_case("none"))
    {
        blockers.push("review.md Blocked By is not none".to_string());
    }

    let plan_path = change_dir.join("plan.md");
    let Ok(plan) = fs::read_to_string(&plan_path) else {
        blockers.push("plan.md is missing or unreadable".to_string());
        return blockers;
    };
    if markdown_section(&plan, "Covers")
        .map(first_meaningful_line)
        .unwrap_or_default()
        .is_empty()
    {
        blockers.push("plan.md Covers has no task mapping".to_string());
    }

    blockers
}

pub(super) fn markdown_section(content: &str, title: &str) -> Option<String> {
    let wanted = format!("## {}", title);
    let mut collecting = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case(&wanted) {
            collecting = true;
            continue;
        }
        if collecting && trimmed.starts_with("## ") {
            break;
        }
        if collecting {
            lines.push(line);
        }
    }
    collecting.then(|| lines.join("\n").trim().to_string())
}

pub(super) fn first_meaningful_line(section: String) -> String {
    section
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("<!--") && !line.starts_with("-->"))
        .map(|line| {
            line.trim_start_matches("- ")
                .trim_start_matches("* ")
                .trim()
        })
        .unwrap_or("")
        .to_string()
}

/// Check whether an enhanced spec-driven change is ready for apply-time work.
pub fn apply_preflight(cwd: &Path, name: &str) -> Result<SpecApplyPreflightReport> {
    let change_dir = checked_change_dir(cwd, name)?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;
    let schema = metadata_schema_or_default(&meta);
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();

    if !config::is_superpowers_schema(&schema) {
        warnings.push(format!(
            "schema `{schema}` does not use the enhanced review/plan apply preflight"
        ));
        return Ok(SpecApplyPreflightReport {
            change_name: meta.name,
            schema,
            ok: true,
            blockers,
            warnings,
            modes: SpecApplyModes::default(),
            task_coverage: SpecTaskCoverage::default(),
            validation_focus: Vec::new(),
            unmapped_validation_focus: Vec::new(),
            verification: verification_status(&change_dir),
        });
    }

    for artifact in required_artifacts_for_schema(&schema) {
        let path = change_dir.join(artifact);
        if !path.exists() {
            blockers.push(format!("{artifact}: missing required apply artifact"));
        } else if artifact_has_no_content(&path) {
            blockers.push(format!("{artifact}: required apply artifact is empty"));
        }
    }

    let review = read_change_file_or_block(&change_dir, "review.md", &mut blockers);
    let plan = read_change_file_or_block(&change_dir, "plan.md", &mut blockers);
    let tasks = read_change_file_or_block(&change_dir, "tasks.md", &mut blockers);

    let modes = SpecApplyModes {
        readiness_decision: section_value(review.as_deref(), "Readiness Decision", ""),
        execution_mode: section_value(review.as_deref(), "Execution Mode", "standard"),
        verification_mode: section_value(review.as_deref(), "Verification Mode", "inline-only"),
        debug_mode: section_value(review.as_deref(), "Debug Mode", "standard"),
        review_status: section_value(review.as_deref(), "Review Status", "not-requested"),
        delegation_mode: section_value(review.as_deref(), "Delegation Mode", "single-agent"),
        parallelization_mode: section_value(
            review.as_deref(),
            "Parallelization Mode",
            "serial-only",
        ),
        worktree_mode: section_value(review.as_deref(), "Worktree Mode", "same-tree"),
        branch_finish_mode: section_value(review.as_deref(), "Branch Finish Mode", "standard"),
    };

    if modes.readiness_decision.is_empty() {
        blockers.push("review.md Readiness Decision is missing".to_string());
    } else if modes.readiness_decision.eq_ignore_ascii_case("blocked") {
        blockers.push("review.md Readiness Decision is blocked".to_string());
    } else if modes
        .readiness_decision
        .eq_ignore_ascii_case("ready with conditions")
    {
        warnings.push(
            "review.md is ready with conditions; conditions must be tracked in tasks.md or plan.md"
                .to_string(),
        );
    }

    let blocked_by = section_value(review.as_deref(), "Blocked By", "none");
    if !is_none_like(&blocked_by) {
        blockers.push("review.md Blocked By is not none".to_string());
    }

    let open_task_ids = tasks
        .as_deref()
        .map(open_task_ids_from_tasks)
        .unwrap_or_default();
    let covered_task_ids = plan
        .as_deref()
        .and_then(|text| markdown_section(text, "Covers"))
        .map(|section| numbered_ids(&section))
        .unwrap_or_default();
    let uncovered_task_ids = open_task_ids
        .iter()
        .filter(|id| !covered_task_ids.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    if !open_task_ids.is_empty() && covered_task_ids.is_empty() {
        blockers.push("plan.md Covers has no task mapping".to_string());
    } else if !uncovered_task_ids.is_empty() {
        blockers.push(format!(
            "plan.md Covers does not include open task ids: {}",
            uncovered_task_ids.join(", ")
        ));
    }

    let validation_focus = review
        .as_deref()
        .and_then(|text| markdown_section(text, "Validation Focus"))
        .map(section_items)
        .unwrap_or_default();
    if !validation_focus.is_empty()
        && plan
            .as_deref()
            .and_then(|text| markdown_section(text, "Validation Per Step"))
            .map(first_meaningful_line)
            .unwrap_or_default()
            .is_empty()
    {
        blockers.push("plan.md Validation Per Step does not map Validation Focus".to_string());
    }
    let verification_text = fs::read_to_string(change_dir.join("verification.md")).ok();
    let unmapped_validation_focus = unmapped_high_priority_validation_focus(
        &validation_focus,
        plan.as_deref(),
        verification_text.as_deref(),
    );
    if !unmapped_validation_focus.is_empty() {
        blockers.push(format!(
            "high-priority Validation Focus items are not mapped into plan.md or verification.md: {}",
            unmapped_validation_focus.join("; ")
        ));
    }

    check_mode_requirements(
        &modes,
        plan.as_deref(),
        review.as_deref(),
        &mut blockers,
        &mut warnings,
    );
    let verification = verification_status(&change_dir);
    if modes
        .review_status
        .eq_ignore_ascii_case("findings-received")
        && review
            .as_deref()
            .is_some_and(findings_summary_has_accepted_items)
        && !has_review_finding_writeback(plan.as_deref(), tasks.as_deref(), &change_dir)
    {
        blockers.push(
            "accepted review findings must be written back into tasks.md, plan.md, or verification.md"
                .to_string(),
        );
    }
    if modes
        .verification_mode
        .eq_ignore_ascii_case("retained-required")
        && !verification.present
    {
        warnings.push(
            "verification.md evidence is missing; completion will remain pending".to_string(),
        );
    }

    let task_coverage = SpecTaskCoverage {
        open_task_ids,
        covered_task_ids,
        uncovered_task_ids,
    };
    let ok = blockers.is_empty();

    Ok(SpecApplyPreflightReport {
        change_name: meta.name,
        schema,
        ok,
        blockers,
        warnings,
        modes,
        task_coverage,
        validation_focus,
        unmapped_validation_focus,
        verification,
    })
}

pub(super) fn artifact_has_no_content(path: &Path) -> bool {
    if path.is_dir() {
        fs::read_dir(path)
            .ok()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    } else {
        fs::metadata(path).map(|m| m.len() == 0).unwrap_or(true)
    }
}

pub(super) fn read_change_file_or_block(
    change_dir: &Path,
    file_name: &str,
    blockers: &mut Vec<String>,
) -> Option<String> {
    let path = change_dir.join(file_name);
    match fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) => {
            blockers.push(format!("{file_name}: failed to read apply artifact ({e})"));
            None
        }
    }
}

pub(super) fn section_value(content: Option<&str>, title: &str, default: &str) -> String {
    content
        .and_then(|text| markdown_section(text, title))
        .map(first_meaningful_line)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub(super) fn is_none_like(value: &str) -> bool {
    let value = value.trim();
    value.is_empty()
        || value.eq_ignore_ascii_case("none")
        || value.eq_ignore_ascii_case("not-needed")
        || value.eq_ignore_ascii_case("not-requested")
}

pub(super) fn open_task_ids_from_tasks(tasks: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for line in tasks.lines().map(str::trim_start) {
        if !line.starts_with("- [ ]") {
            continue;
        }
        for id in numbered_ids(line) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

pub(super) fn numbered_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut current = String::new();
    for ch in text.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
        } else if !current.is_empty() {
            let candidate = current.trim_matches('.');
            if is_numbered_id(candidate) && !ids.iter().any(|id| id == candidate) {
                ids.push(candidate.to_string());
            }
            current.clear();
        }
    }
    ids
}

pub(super) fn is_numbered_id(candidate: &str) -> bool {
    candidate.contains('.')
        && candidate
            .split('.')
            .all(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit()))
}

pub(super) fn section_items(section: String) -> Vec<String> {
    section
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("<!--") && !line.starts_with("-->"))
        .map(|line| {
            line.trim_start_matches("- ")
                .trim_start_matches("* ")
                .trim()
                .to_string()
        })
        .filter(|line| !is_none_like(line))
        .collect()
}

pub(super) fn check_mode_requirements(
    modes: &SpecApplyModes,
    plan: Option<&str>,
    review: Option<&str>,
    blockers: &mut Vec<String>,
    warnings: &mut Vec<String>,
) {
    let ordered_steps = plan
        .and_then(|text| markdown_section(text, "Ordered Steps"))
        .unwrap_or_default();
    if modes.execution_mode.eq_ignore_ascii_case("tdd-required")
        && !contains_any(&ordered_steps, &["fail", "failing", "red", "test"])
    {
        blockers.push(
            "plan.md Ordered Steps must include a failing/test-first step for tdd-required"
                .to_string(),
        );
    } else if modes.execution_mode.eq_ignore_ascii_case("tdd-preferred")
        && !contains_any(&ordered_steps, &["fail", "failing", "red", "test"])
    {
        warnings.push(
            "plan.md Ordered Steps does not visibly encode a test-first step for tdd-preferred"
                .to_string(),
        );
    }

    if modes
        .verification_mode
        .eq_ignore_ascii_case("retained-required")
    {
        require_plan_section(plan, "Completion Verification", blockers);
        warnings.push(
            "Verification Mode is retained-required; verification.md evidence is required before full completion"
                .to_string(),
        );
    } else if modes
        .verification_mode
        .eq_ignore_ascii_case("retained-recommended")
    {
        require_plan_section(plan, "Completion Verification", blockers);
    }

    if modes
        .debug_mode
        .eq_ignore_ascii_case("systematic-debugging")
    {
        require_review_section(review, "Observed Failure", blockers);
        require_plan_section(plan, "Debugging Trail", blockers);
    }

    if modes
        .review_status
        .eq_ignore_ascii_case("findings-received")
    {
        require_review_section(review, "Findings Summary", blockers);
    }

    if !modes.delegation_mode.eq_ignore_ascii_case("single-agent") {
        require_plan_section(plan, "Delegation Units", blockers);
    }
    if !modes
        .parallelization_mode
        .eq_ignore_ascii_case("serial-only")
    {
        require_plan_section(plan, "Parallel Units", blockers);
        require_plan_section(plan, "Isolation Boundaries", blockers);
    }
    if !modes.worktree_mode.eq_ignore_ascii_case("same-tree") {
        require_plan_section(plan, "Worktree Units", blockers);
        require_plan_section(plan, "Isolation Reason", blockers);
        require_plan_section(plan, "Integration Owner", blockers);
    }
    if modes
        .branch_finish_mode
        .to_ascii_lowercase()
        .starts_with("finish-")
    {
        require_plan_section(plan, "Finish Checklist", blockers);
        require_plan_section(plan, "Delivery Handoff", blockers);
    }
}

pub(super) fn contains_any(text: &str, needles: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

pub(super) fn findings_summary_has_accepted_items(review: &str) -> bool {
    let Some(summary) = markdown_section(review, "Findings Summary") else {
        return false;
    };
    let lower = summary.to_ascii_lowercase();
    lower.contains("accepted")
        && !lower.contains("no accepted")
        && !lower.contains("accepted: none")
        && !lower.contains("accepted findings: none")
}

pub(super) fn has_review_finding_writeback(
    plan: Option<&str>,
    tasks: Option<&str>,
    change_dir: &Path,
) -> bool {
    let plan_has_followup = plan
        .and_then(|text| markdown_section(text, "Review Follow-Up"))
        .map(section_items)
        .is_some_and(|items| !items.is_empty());
    if plan_has_followup {
        return true;
    }

    let tasks_has_followup = tasks.map(tasks_have_review_followup_items).unwrap_or(false);
    if tasks_has_followup {
        return true;
    }

    fs::read_to_string(change_dir.join("verification.md"))
        .ok()
        .map(|text| {
            markdown_section(&text, "Residual Risks")
                .map(section_items)
                .is_some_and(|items| !items.is_empty())
                || markdown_section(&text, "Evidence")
                    .map(section_items)
                    .is_some_and(|items| !items.is_empty())
        })
        .unwrap_or(false)
}

pub(super) fn tasks_have_review_followup_items(tasks: &str) -> bool {
    let mut in_review_followup = false;
    for line in tasks.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("## ") {
            in_review_followup = trimmed.to_ascii_lowercase().contains("review follow-up");
            continue;
        }
        if in_review_followup
            && (trimmed.starts_with("- [ ]") || trimmed.starts_with("- [x]"))
            && !numbered_ids(trimmed).is_empty()
        {
            return true;
        }
    }
    false
}

pub(super) fn unmapped_high_priority_validation_focus(
    validation_focus: &[String],
    plan: Option<&str>,
    verification: Option<&str>,
) -> Vec<String> {
    let mapping_text = validation_mapping_text(plan, verification);
    validation_focus
        .iter()
        .filter(|item| is_high_priority_validation_focus(item))
        .filter(|item| !validation_focus_item_is_mapped(item, &mapping_text))
        .cloned()
        .collect()
}

pub(super) fn validation_mapping_text(plan: Option<&str>, verification: Option<&str>) -> String {
    let mut text = String::new();
    if let Some(plan) = plan {
        for title in [
            "Ordered Steps",
            "Validation Per Step",
            "Completion Checkpoint",
            "Completion Verification",
        ] {
            if let Some(section) = markdown_section(plan, title) {
                text.push_str(&section);
                text.push('\n');
            }
        }
    }
    if let Some(verification) = verification {
        for title in [
            "Commands Run",
            "Manual Checks",
            "Evidence",
            "Residual Risks",
        ] {
            if let Some(section) = markdown_section(verification, title) {
                text.push_str(&section);
                text.push('\n');
            }
        }
    }
    text
}

pub(super) fn is_high_priority_validation_focus(item: &str) -> bool {
    let lower = item.to_ascii_lowercase();
    ["required", "must", "critical", "high-priority", "blocker"]
        .iter()
        .any(|marker| lower.contains(marker))
}

pub(super) fn validation_focus_item_is_mapped(item: &str, mapping_text: &str) -> bool {
    let tokens = significant_validation_tokens(item);
    if tokens.is_empty() {
        return mapping_text
            .to_ascii_lowercase()
            .contains(&item.to_ascii_lowercase());
    }
    let mapping_text = mapping_text.to_ascii_lowercase();
    let matches = tokens
        .iter()
        .filter(|token| mapping_text.contains(token.as_str()))
        .count();
    let required = if tokens.len() <= 2 { 1 } else { 2 };
    matches >= required
}

pub(super) fn significant_validation_tokens(text: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "required",
        "must",
        "should",
        "critical",
        "high",
        "priority",
        "blocker",
        "validation",
        "focus",
        "verify",
        "check",
        "confirm",
    ];
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::trim)
        .filter(|token| token.len() >= 4)
        .map(|token| token.to_ascii_lowercase())
        .filter(|token| !STOPWORDS.contains(&token.as_str()))
        .fold(Vec::new(), |mut tokens, token| {
            if !tokens.contains(&token) {
                tokens.push(token);
            }
            tokens
        })
}

pub(super) fn require_plan_section(plan: Option<&str>, title: &str, blockers: &mut Vec<String>) {
    if plan
        .and_then(|text| markdown_section(text, title))
        .map(first_meaningful_line)
        .filter(|value| !is_none_like(value))
        .is_none()
    {
        blockers.push(format!("plan.md {title} is required by active mode"));
    }
}

pub(super) fn require_review_section(
    review: Option<&str>,
    title: &str,
    blockers: &mut Vec<String>,
) {
    if review
        .and_then(|text| markdown_section(text, title))
        .map(first_meaningful_line)
        .filter(|value| !is_none_like(value))
        .is_none()
    {
        blockers.push(format!("review.md {title} is required by active mode"));
    }
}

pub(super) fn verification_status(change_dir: &Path) -> SpecVerificationStatus {
    let path = change_dir.join("verification.md");
    let Ok(content) = fs::read_to_string(&path) else {
        return SpecVerificationStatus::default();
    };
    let completion_decision = markdown_section(&content, "Completion Decision")
        .map(first_meaningful_line)
        .filter(|value| !value.trim().is_empty());
    SpecVerificationStatus {
        present: true,
        completion_decision,
    }
}

pub(super) fn completion_blockers_for_schema(
    schema: &str,
    change_dir: &Path,
    verification: &SpecVerificationStatus,
) -> Vec<String> {
    if !config::is_superpowers_schema(schema) {
        return Vec::new();
    }
    let review = fs::read_to_string(change_dir.join("review.md")).ok();
    let verification_mode = section_value(review.as_deref(), "Verification Mode", "inline-only");
    if !verification_mode.eq_ignore_ascii_case("retained-required") {
        return Vec::new();
    }

    let mut blockers = Vec::new();
    if !verification.present {
        blockers.push("verification.md is required by retained-required mode".to_string());
    } else if match verification.completion_decision.as_deref() {
        Some(decision) => !completion_decision_is_complete(decision),
        None => true,
    } {
        blockers.push("verification.md Completion Decision is not complete".to_string());
    }
    blockers
}

pub(super) fn completion_decision_is_complete(decision: &str) -> bool {
    matches!(
        decision.trim().to_ascii_lowercase().as_str(),
        "complete" | "completed" | "verified" | "passed" | "pass" | "ready" | "done"
    )
}
