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
    let specs_dir = specs_dir_for(cwd);
    let _lock = archive_transaction::lock(&specs_dir)?;
    archive_transaction::recover_change_locked(&specs_dir, name)?;
    if change_dir.exists() {
        anyhow::bail!("change '{}' already exists", name);
    }

    fs::create_dir_all(change_dir.join("specs"))
        .with_context(|| format!("failed to create change directory {:?}", change_dir))?;

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
/// Prepares every authoritative file and metadata update before committing the
/// change directory move. A durable journal completes committed publication
/// after interruption; external edits are never overwritten during recovery.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchiveOutcome {
    pub archive_dir: PathBuf,
    pub committed: bool,
    pub recovery_pending: bool,
}
pub fn archive(cwd: &Path, name: &str) -> Result<PathBuf> {
    archive_with_outcome(cwd, name).map(|outcome| outcome.archive_dir)
}
pub fn archive_with_outcome(cwd: &Path, name: &str) -> Result<ArchiveOutcome> {
    let change_dir = checked_change_dir(cwd, name)?;
    let archive_root = checked_change_dir(cwd, "archive")?;
    let specs_dir = specs_dir_for(cwd);
    let _lock = archive_transaction::lock(&specs_dir)?;
    let committed_archive = archive_transaction::committed_archive_identity(&specs_dir)?;
    if let Some((pending_name, _)) = &committed_archive {
        anyhow::ensure!(
            pending_name == name,
            "spec_transaction_pending: committed change '{pending_name}' must be recovered before archiving '{name}'; retry SpecArchive for '{pending_name}'"
        );
    }
    if let Err(error) = archive_transaction::recover_change_locked(&specs_dir, name) {
        if let Some((_, path)) = &committed_archive {
            debug!("committed archive recovery pending: {error:#}");
            return Ok(ArchiveOutcome {
                archive_dir: path.clone(),
                committed: true,
                recovery_pending: true,
            });
        }
        return Err(error);
    }
    // Recovery is bound to the persisted target, including an earlier date.
    if let Some((_, archive_dir)) = committed_archive {
        return Ok(ArchiveOutcome {
            archive_dir,
            committed: true,
            recovery_pending: false,
        });
    }
    if !change_dir.exists()
        && let Some(archive_dir) = retained_archive(cwd, &archive_root, name)?
    {
        return Ok(ArchiveOutcome {
            archive_dir,
            committed: true,
            recovery_pending: false,
        });
    }
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let archive_name = format!("{}-{}", date, name);
    let archive_dir = archive_root.join(&archive_name);
    if !change_dir.exists()
        && archive_dir.is_dir()
        && read_metadata(&archive_dir.join(".spec.yaml"))?.status == ChangeStatus::Archived
    {
        return Ok(ArchiveOutcome {
            archive_dir,
            committed: true,
            recovery_pending: false,
        });
    }
    archive_transaction::ensure_absent(&archive_dir)?;
    if !change_dir.exists() {
        anyhow::bail!("change '{}' does not exist", name);
    }

    let tasks_relative = Path::new("changes").join(name).join("tasks.md");
    let tasks_before =
        fs::read(change_dir.join("tasks.md")).context("failed to read archive tasks")?;
    let tasks_guard = archive_transaction::input_guard(&specs_dir, &tasks_relative, &tasks_before)?;
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

    // Automatically fast-forward any unchanged deltas before checking drift.
    // If there are real conflicts, surface them now so the user can resolve.
    let sync_report = sync::sync_locked(cwd, name)
        .with_context(|| format!("failed to sync change '{}' before archiving", name))?;
    if sync_report
        .publication
        .is_some_and(|receipt| receipt.recovery_pending)
    {
        anyhow::bail!(
            "spec_transaction_pending: SpecSync for change '{name}' committed with publication recovery pending; retry SpecSync before archiving"
        );
    }
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

    let mut prepared = merge::prepare_change(&specs_dir, &change_dir)
        .with_context(|| format!("failed to prepare change '{}'", name))?;
    prepared.push(tasks_guard);
    let mut metadata = read_metadata(&change_dir.join(".spec.yaml"))?;
    metadata.status = ChangeStatus::Archived;
    prepared.push(archive_transaction::prepare_file(
        &specs_dir,
        &Path::new("changes").join(name).join(".spec.yaml"),
        serde_yaml::to_string(&metadata)?.into_bytes(),
    )?);
    fs::create_dir_all(&archive_root).context("failed to prepare archive directory")?;
    archive_transaction::commit(
        &specs_dir,
        prepared,
        Some(archive_transaction::ArchiveMove {
            source: name.into(),
            target: archive_name,
        }),
    )?;

    debug!("archived change {} to {:?}", name, archive_dir);
    let recovery_pending = archive_transaction::committed_archive(&specs_dir, name)
        .map(|value| value.is_some())
        .unwrap_or(true);
    Ok(ArchiveOutcome {
        archive_dir,
        committed: true,
        recovery_pending,
    })
}

fn retained_archive(cwd: &Path, archive_root: &Path, name: &str) -> Result<Option<PathBuf>> {
    if !archive_root.exists() {
        return Ok(None);
    }
    let workspace = cwd
        .canonicalize()
        .context("failed to resolve spec workspace")?;
    let suffix = format!("-{name}");
    let mut latest = None;
    for entry in fs::read_dir(archive_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let leaf = entry.file_name();
        let Some(date) = leaf
            .to_str()
            .and_then(|leaf| leaf.strip_suffix(&suffix))
            .and_then(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        else {
            continue;
        };
        let path = entry.path();
        workspace_paths::check_change_directory(&path, &workspace)?;
        let metadata = read_metadata(&path.join(".spec.yaml"))?;
        if metadata.name == name
            && metadata.status == ChangeStatus::Archived
            && latest.as_ref().is_none_or(|(previous, _)| date > *previous)
        {
            latest = Some((date, path));
        }
    }
    Ok(latest.map(|(_, path)| path))
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
