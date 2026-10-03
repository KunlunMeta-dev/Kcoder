//! Spec change lifecycle domain implementation.

use super::*;

impl ChangeMetadata {
    pub fn new(name: impl Into<String>, title: Option<String>) -> Self {
        Self {
            name: name.into(),
            title,
            schema: None,
            created_at: chrono::Local::now().to_rfc3339(),
            status: ChangeStatus::Draft,
        }
    }
}

pub(super) fn project_schema(specs_dir: &Path) -> Result<String> {
    let config = read_validated_project_config(specs_dir)?;
    Ok(normalize_schema_name(&config.schema))
}

pub(super) fn metadata_schema_or_default(meta: &ChangeMetadata) -> String {
    if let Some(schema) = meta
        .schema
        .as_deref()
        .filter(|schema| !schema.trim().is_empty())
    {
        normalize_schema_name(schema)
    } else {
        "spec-driven".to_string()
    }
}

pub(super) fn normalize_schema_name(schema: &str) -> String {
    let trimmed = schema.trim();
    if trimmed.is_empty() {
        "spec-driven".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(super) fn required_artifacts_for_schema(schema: &str) -> &'static [&'static str] {
    if config::is_superpowers_schema(schema) {
        &[
            "proposal.md",
            "specs",
            "design.md",
            "review.md",
            "tasks.md",
            "plan.md",
        ]
    } else {
        &["proposal.md", "specs", "design.md", "tasks.md"]
    }
}

pub(super) fn template_artifacts_for_schema(schema: &str) -> Vec<(&'static str, &'static str)> {
    let mut artifacts = vec![
        ("proposal.md", PROPOSAL_TEMPLATE),
        ("design.md", DESIGN_TEMPLATE),
    ];
    if config::is_superpowers_schema(schema) {
        artifacts.push(("review.md", REVIEW_TEMPLATE));
    }
    artifacts.push(("tasks.md", TASKS_TEMPLATE));
    if config::is_superpowers_schema(schema) {
        artifacts.push(("plan.md", PLAN_TEMPLATE));
    }
    artifacts
}

/// Create a new change scaffold.
pub fn new_change(cwd: &Path, name: &str, title: Option<String>) -> Result<PathBuf> {
    let change_dir = checked_change_dir(cwd, name)?;
    if change_dir.exists() {
        anyhow::bail!("change '{}' already exists", name);
    }

    fs::create_dir_all(change_dir.join("specs"))
        .with_context(|| format!("failed to create change directory {:?}", change_dir))?;

    let specs_dir = specs_dir_for(cwd);
    let schema = project_schema(&specs_dir)?;
    let mut metadata = ChangeMetadata::new(name, title);
    metadata.schema = Some(schema.clone());
    let meta_path = change_dir.join(".spec.yaml");
    fs::write(&meta_path, serde_yaml::to_string(&metadata)?)
        .with_context(|| format!("failed to write {:?}", meta_path))?;

    for (file_name, content) in template_artifacts_for_schema(&schema) {
        let path = change_dir.join(file_name);
        fs::write(&path, content).with_context(|| format!("failed to write {:?}", path))?;
    }

    // Create a starter delta spec so the change has a concrete place to write
    // ADDED/MODIFIED/REMOVED/RENAMED requirements. Default to the first existing
    // authoritative domain (usually "core" after init).
    let default_domain =
        first_authoritative_domain(&specs_dir).unwrap_or_else(|| "core".to_string());
    let delta_dir = change_dir.join("specs").join(&default_domain);
    fs::create_dir_all(&delta_dir)
        .with_context(|| format!("failed to create delta directory {:?}", delta_dir))?;
    let delta_path = delta_dir.join("spec.md");
    if !delta_path.exists() {
        fs::write(&delta_path, DEFAULT_DELTA_TEMPLATE)
            .with_context(|| format!("failed to write {:?}", delta_path))?;
    }

    // Snapshot the current authoritative specs so we can detect drift before
    // archiving this change.
    fingerprint::capture_base_snapshot(&specs_dir, &change_dir)
        .with_context(|| "failed to capture base spec snapshot")?;

    debug!("created change {:?}", change_dir);
    Ok(change_dir)
}

/// Archive a completed change.
///
/// First merges the change's delta specs into the authoritative specs under
/// `.kcoder/specs/specs/`, then moves the change directory into
/// `.kcoder/specs/changes/archive/` and marks it as archived.
pub fn archive(cwd: &Path, name: &str) -> Result<PathBuf> {
    let change_dir = checked_change_dir(cwd, name)?;
    let archive_root = checked_change_dir(cwd, "archive")?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let summary = status(cwd, name)?;
    let mut readiness_blockers = Vec::new();
    if !summary.tasks_complete {
        readiness_blockers.push("tasks.md contains incomplete tasks".to_string());
    }
    readiness_blockers.extend(summary.apply_blockers);
    readiness_blockers.extend(summary.completion_blockers);
    if !readiness_blockers.is_empty() {
        let mut message = format!(
            "cannot archive change '{}'; readiness blockers must be resolved:",
            name
        );
        for blocker in readiness_blockers {
            message.push_str(&format!("\n- {blocker}"));
        }
        anyhow::bail!(message);
    }

    let specs_dir = specs_dir_for(cwd);

    // Automatically fast-forward any unchanged deltas before checking drift.
    // If there are real conflicts, surface them now so the user can resolve.
    let sync_report = sync::sync(cwd, name)
        .with_context(|| format!("failed to sync change '{}' before archiving", name))?;
    if !sync_report.conflicts.is_empty() {
        let mut msg = format!(
            "cannot archive change '{}'; unresolved spec conflicts detected. Run SpecSync to resolve them:",
            name
        );
        for r in &sync_report.conflicts {
            msg.push_str(&format!("\n- specs/{}: {}", r.domain, r.name));
        }
        anyhow::bail!(msg);
    }

    run_precheck(cwd, &specs_dir)
        .with_context(|| format!("verification failed for change '{}'", name))?;

    let drift_errors = fingerprint::check_change(&specs_dir, &change_dir)?;
    if !drift_errors.is_empty() {
        let mut msg = format!(
            "cannot archive change '{}'; the live spec has drifted from the change base:",
            name
        );
        for err in drift_errors {
            msg.push_str("\n- ");
            msg.push_str(&err);
        }
        msg.push_str("\nRebase the change against the current specs before archiving (SpecSync).");
        anyhow::bail!(msg);
    }

    let merged = merge::merge_change(&specs_dir, &change_dir)
        .with_context(|| format!("failed to merge change '{}' into authoritative specs", name))?;
    debug!("merged change {} into {:?}", name, merged);

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let archive_name = format!("{}-{}", date, name);
    let archive_dir = archive_root.join(&archive_name);
    if archive_dir.exists() {
        anyhow::bail!("archive target {:?} already exists", archive_dir);
    }

    fs::rename(&change_dir, &archive_dir)
        .with_context(|| format!("failed to archive {:?} to {:?}", change_dir, archive_dir))?;

    let meta_path = archive_dir.join(".spec.yaml");
    if let Ok(mut meta) = read_metadata(&meta_path) {
        meta.status = ChangeStatus::Archived;
        if let Err(e) = fs::write(&meta_path, serde_yaml::to_string(&meta)?) {
            warn!("failed to update archived metadata: {}", e);
        }
    }

    debug!("archived change {} to {:?}", name, archive_dir);
    Ok(archive_dir)
}

/// List active change names.
pub fn list_changes(cwd: &Path) -> Result<Vec<String>> {
    let changes_dir = checked_changes_dir(cwd)?;
    if !changes_dir.exists() {
        return Ok(Vec::new());
    }

    let mut names = Vec::new();
    for entry in
        fs::read_dir(&changes_dir).with_context(|| format!("failed to read {:?}", changes_dir))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir()
            && path.join(".spec.yaml").exists()
            && path.file_name() != Some(std::ffi::OsStr::new("archive"))
            && let Some(name) = path.file_name().and_then(|n| n.to_str())
        {
            checked_change_dir(cwd, name)?;
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

pub(super) fn first_authoritative_domain(specs_dir: &Path) -> Option<String> {
    let auth_dir = specs_dir.join("specs");
    if !auth_dir.exists() {
        return None;
    }
    let mut domains: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&auth_dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir()
            && path.join("spec.md").is_file()
            && let Some(name) = path.file_name().and_then(|n| n.to_str())
        {
            domains.push(name.to_string());
        }
    }
    domains.sort();
    domains.into_iter().next()
}

/// Apply a plan text to the `tasks.md` of an active spec change.
///
/// If `change_name` is omitted and there is exactly one active change, the plan
/// is written there. Each non-empty plan line is converted into a `- [ ]`
/// task if it is not already a checkbox or a markdown heading.
pub fn apply_plan(cwd: &Path, change_name: Option<&str>, plan: &str) -> Result<PathBuf> {
    let name = match change_name {
        Some(n) => n.to_string(),
        None => {
            let changes = list_changes(cwd)?;
            match changes.len() {
                0 => anyhow::bail!(
                    "no active spec changes; create one with SpecNewChange or pass change_name"
                ),
                1 => changes.into_iter().next().unwrap(),
                _ => anyhow::bail!(
                    "multiple active spec changes: {}; pass change_name to choose one",
                    changes.join(", ")
                ),
            }
        }
    };

    let change_dir = checked_change_dir(cwd, &name)?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let meta = read_metadata(&change_dir.join(".spec.yaml"))
        .with_context(|| format!("failed to read metadata for change '{}'", name))?;
    let schema = metadata_schema_or_default(&meta);
    if config::is_superpowers_schema(&schema) {
        let plan_path = change_dir.join("plan.md");
        fs::write(&plan_path, plan)
            .with_context(|| format!("failed to write {}", plan_path.display()))?;
        debug!("wrote plan to {:?}", plan_path);
        return Ok(plan_path);
    }

    let tasks_path = change_dir.join("tasks.md");
    let tasks = plan
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.is_empty()
                || trimmed.starts_with('#')
                || trimmed.starts_with("- [")
                || trimmed.starts_with("* [")
            {
                return line.to_string();
            }
            let indent = &line[..line.len() - trimmed.len()];
            if let Some(rest) = trimmed.strip_prefix("- ") {
                format!("{}- [ ] {}", indent, rest)
            } else if let Some(rest) = trimmed.strip_prefix("* ") {
                format!("{}- [ ] {}", indent, rest)
            } else {
                format!("{}- [ ] {}", indent, trimmed)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    fs::write(&tasks_path, tasks)
        .with_context(|| format!("failed to write {}", tasks_path.display()))?;
    debug!("wrote plan to {:?}", tasks_path);
    Ok(tasks_path)
}

pub(super) fn read_metadata(path: &Path) -> Result<ChangeMetadata> {
    let text = fs::read_to_string(path).with_context(|| format!("failed to read {:?}", path))?;
    serde_yaml::from_str(&text).with_context(|| format!("failed to parse {:?}", path))
}
