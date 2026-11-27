//! Spec review domain implementation.

use super::*;

/// Write review findings back into the canonical spec-driven-superpowers artifacts.
pub fn review_writeback(
    cwd: &Path,
    name: &str,
    record: SpecReviewWritebackRecord,
) -> Result<SpecReviewWritebackReport> {
    let change_dir = checked_change_dir(cwd, name)?;
    let review_status = record.review_status.trim();
    if review_status.is_empty() {
        anyhow::bail!("review_status cannot be empty");
    }
    let findings = clean_markdown_items(&record.findings_summary);
    if review_status.eq_ignore_ascii_case("findings-received") && findings.is_empty() {
        anyhow::bail!("findings_summary cannot be empty when review_status is findings-received");
    }
    let root = specs_dir_for(cwd);
    let _lock = archive_transaction::lock(&root)?;
    archive_transaction::recover_change_locked(&root, name)?;
    let metadata_path = change_dir.join(".spec.yaml");
    let metadata = fs::read(&metadata_path)
        .with_context(|| format!("failed to read metadata for change '{name}'"))?;
    let meta: ChangeMetadata = serde_yaml::from_slice(&metadata)?;
    if !config::is_superpowers_schema(&metadata_schema_or_default(&meta)) {
        anyhow::bail!(
            "SpecReview action=writeback requires a spec-driven-superpowers schema change"
        );
    }
    let review_path = change_dir.join("review.md");
    let read = |path: &Path| {
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))
    };
    let before = read(&review_path)?;
    let updated = upsert_markdown_section(&before, "Review Status", review_status);
    let updated = upsert_markdown_section(
        &updated,
        "Findings Summary",
        &markdown_list_body(&record.findings_summary),
    );
    let mut updates = vec![(review_path.clone(), Some(before), updated)];
    let accepted_followups = clean_markdown_items(&record.accepted_followups);
    let mut tasks_updated = false;
    let mut plan_updated = false;
    if !accepted_followups.is_empty() {
        let path = change_dir.join("tasks.md");
        let before = read(&path)?;
        let updated = append_review_followup_tasks(&before, &accepted_followups);
        tasks_updated = before != updated;
        updates.push((path, Some(before), updated));
        let path = change_dir.join("plan.md");
        let before = read(&path)?;
        let updated =
            append_markdown_list_section(&before, "Review Follow-Up", &accepted_followups);
        plan_updated = before != updated;
        updates.push((path, Some(before), updated));
    }
    let notes = clean_markdown_items(&record.verification_notes);
    let mut verification_updated = false;
    if !notes.is_empty() {
        let path = change_dir.join("verification.md");
        let before = match fs::read_to_string(&path) {
            Ok(value) => Some(value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read {}", path.display()));
            }
        };
        let updated = append_verification_notes(before.as_deref().unwrap_or_default(), &notes);
        verification_updated = before.as_ref() != Some(&updated);
        updates.push((path, before, updated));
    }
    // Every body is read and constructed before any document publication begins.
    let mut prepared = vec![archive_transaction::input_guard(
        &root,
        metadata_path.strip_prefix(&root)?,
        &metadata,
    )?];
    for (path, before, updated) in updates {
        prepared.push(archive_transaction::prepare_expected(
            &root,
            path.strip_prefix(&root)?,
            updated.into_bytes(),
            before.as_deref().map(str::as_bytes),
        )?);
    }
    let publication = archive_transaction::commit_change(&root, name, prepared)?;
    Ok(SpecReviewWritebackReport {
        publication,
        change_name: meta.name,
        review_status: review_status.to_string(),
        review_path,
        tasks_updated,
        plan_updated,
        verification_updated,
    })
}

/// Build a code-review request for a completed spec change.
///
/// Gathers the change metadata, delta specs, git diff, and pre-check results,
/// then produces a populated reviewer prompt that can be passed to a review
/// subagent.
pub fn review(cwd: &Path, name: &str, base_sha: Option<&str>) -> Result<SpecReviewReport> {
    let change_dir = checked_change_dir(cwd, name)?;
    let specs_dir = specs_dir_for(cwd);
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;

    let read = |file: &str| -> String {
        change_dir
            .join(file)
            .to_str()
            .and_then(|p| fs::read_to_string(p).ok())
            .unwrap_or_default()
    };

    let deltas = parse::load_change_deltas_with_paths(&change_dir)?
        .into_iter()
        .map(|(domain, _delta, path)| {
            let content = fs::read_to_string(&path)
                .with_context(|| format!("failed to read {}", path.display()))?;
            Ok((domain, content))
        })
        .collect::<Result<Vec<_>>>()?;

    let git_base = base_sha
        .map(|s| s.to_string())
        .or_else(|| infer_review_base(cwd))
        .unwrap_or_else(|| "HEAD".to_string());
    let git_head = git_rev_parse(cwd, "HEAD").unwrap_or_else(|| "HEAD".to_string());

    let git_diff_stat = git_diff(cwd, &git_base, &git_head, true).unwrap_or_default();
    let git_diff = git_diff(cwd, &git_base, &git_head, false).unwrap_or_default();

    let summary = build_precheck_summary(cwd, &specs_dir, &change_dir);

    let reviewer_prompt = populate_reviewer_prompt(
        &meta,
        &read("proposal.md"),
        &read("design.md"),
        &read("tasks.md"),
        &deltas,
        &git_base,
        &git_head,
        &git_diff_stat,
        &git_diff,
        &summary,
    );

    Ok(SpecReviewReport {
        change_name: meta.name,
        title: meta.title,
        proposal: read("proposal.md"),
        design: read("design.md"),
        tasks: read("tasks.md"),
        deltas,
        git_base,
        git_head,
        git_diff_stat,
        git_diff,
        precheck_summary: summary,
        reviewer_prompt,
    })
}

pub(super) fn infer_review_base(cwd: &Path) -> Option<String> {
    git_output(cwd, &["merge-base", "HEAD", "origin/main"])
        .or_else(|| git_output(cwd, &["rev-parse", "HEAD~1"]))
        .or_else(|| git_output(cwd, &["rev-list", "--max-parents=0", "HEAD"]))
}

pub(super) fn git_rev_parse(cwd: &Path, rev: &str) -> Option<String> {
    git_output(cwd, &["rev-parse", rev])
}

pub(super) fn git_output(cwd: &Path, args: &[&str]) -> Option<String> {
    let git_path = resolve_program("git").ok()?;
    run_git_command(cwd, &git_path, args)
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(super) fn git_diff(cwd: &Path, base: &str, head: &str, stat_only: bool) -> Option<String> {
    let range = format!("{}..{}", base, head);
    if stat_only {
        git_output(cwd, &["diff", "--stat", &range])
    } else {
        git_output(cwd, &["diff", &range])
    }
}

pub(super) fn build_precheck_summary(cwd: &Path, specs_dir: &Path, change_dir: &Path) -> String {
    let mut lines = Vec::new();

    let tasks_path = change_dir.join("tasks.md");
    if tasks_path.exists() {
        let tasks = fs::read_to_string(&tasks_path).unwrap_or_default();
        let total = tasks.matches("- [").count();
        let checked = tasks.matches("- [x]").count() + tasks.matches("- [X]").count();
        lines.push(format!("Tasks: {}/{} checked", checked, total));
    } else {
        lines.push("Tasks: tasks.md missing".to_string());
    }

    let drift = fingerprint::check_change(specs_dir, change_dir).unwrap_or_default();
    if drift.is_empty() {
        lines.push("Spec drift: none".to_string());
    } else {
        lines.push(format!("Spec drift: {} issue(s)", drift.len()));
    }

    if cwd.join("Cargo.toml").exists() && std::env::var("KCODER_SPEC_SKIP_TESTS").is_err() {
        let cargo_output = resolve_program("cargo")
            .and_then(|cargo_path| run_cargo_command(cwd, &cargo_path, &["test", "--quiet"]));
        match cargo_output {
            Ok(output) if output.status.success() => lines.push("Tests: passing".to_string()),
            Ok(output) => lines.push(format!(
                "Tests: failing\n{}",
                String::from_utf8_lossy(&output.stderr)
            )),
            Err(e) => lines.push(format!("Tests: could not run ({})", e)),
        }
    } else {
        lines.push("Tests: skipped (no Cargo.toml or KCODER_SPEC_SKIP_TESTS set)".to_string());
    }

    lines.join("\n")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn populate_reviewer_prompt(
    meta: &ChangeMetadata,
    proposal: &str,
    design: &str,
    tasks: &str,
    deltas: &[(String, String)],
    base: &str,
    head: &str,
    diff_stat: &str,
    diff: &str,
    precheck: &str,
) -> String {
    let title = meta.title.as_deref().unwrap_or(meta.name.as_str());
    let deltas_text = deltas
        .iter()
        .map(|(domain, content)| format!("## specs/{}\n\n{}", domain, content))
        .collect::<Vec<_>>()
        .join("\n\n");
    let description = format!(
        "Change: {}\n\nProposal:\n{}\n\nDesign:\n{}\n\nTasks:\n{}",
        meta.name, proposal, design, tasks
    );
    CODE_REVIEWER_PROMPT_TEMPLATE
        .replace("{TITLE}", title)
        .replace("{DESCRIPTION}", &description)
        .replace("{PLAN_OR_REQUIREMENTS}", &deltas_text)
        .replace("{BASE_SHA}", base)
        .replace("{HEAD_SHA}", head)
        .replace("{DIFF_STAT}", diff_stat)
        .replace("{DIFF}", diff)
        .replace("{PRECHECK}", precheck)
}
